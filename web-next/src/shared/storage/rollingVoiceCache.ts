// Background rolling cache for on-device Kokoro.
//
// After the user commits to a voice for a book, this module walks forward
// through the presynth grid synth-and-persisting every chunk to IndexedDB.
// Subsequent plays hit the cache and start instantly.
//
// The Kokoro worker is a singleton — only one synth at a time. The rolling
// loop yields whenever the reader fires its own synth via
// notePlaybackFetchStart/End: any in-flight rolling synth is cancelled so the
// playback request gets the worker immediately. After playback finishes the
// loop resumes from where it was.

import {
  isModelReady,
  synthesizeLocalStreaming,
  localKokoroCacheKey,
  LOCAL_KOKORO_CACHE_VERSION,
} from './modelCache'
import { getCachedAudio, putCachedAudio } from './audioCache'

export interface RollingCacheStart {
  bookId: string
  voice: string
  speed: number
  text: string
  grid: ReadonlyArray<{ start: number; end: number }>
  fromIdx?: number
}

export interface RollingCacheState {
  bookId: string | null
  voice: string | null
  completed: number
  total: number
  active: boolean
  current: number | null
  error: string | null
}

const listeners = new Set<(state: RollingCacheState) => void>()
let state: RollingCacheState = {
  bookId: null, voice: null, completed: 0, total: 0, active: false, current: null, error: null,
}

const ROLLING_SYNTH_TIMEOUT_MS = 45_000
const ROLLING_CHUNK_TIMEOUT_MS = 45_000

function setState(next: Partial<RollingCacheState>) {
  state = { ...state, ...next }
  for (const cb of listeners) { try { cb(state) } catch { /* listener fault shouldn't break others */ } }
}

export function subscribeRollingCache(cb: (s: RollingCacheState) => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

export function getRollingCacheState(): RollingCacheState {
  return state
}

export function isRollingCacheActiveFor(bookId: string, voice: string): boolean {
  return state.active && state.bookId === bookId && state.voice === voice
}

let abortController: AbortController | null = null
let currentSynthCancel: (() => void) | null = null
let playbackInFlight = 0
let playbackGateResolvers: Array<() => void> = []

/**
 * Reader's fetchWordAudioChunk should call this around any synth that actually
 * occupies the Kokoro worker (i.e. after a cache miss). Pre-emptively cancels
 * any rolling synth so the playback request runs immediately.
 */
export function notePlaybackFetchStart(): void {
  playbackInFlight += 1
  if (playbackInFlight === 1) {
    const cancel = currentSynthCancel
    currentSynthCancel = null
    try { cancel?.() } catch { /* best effort */ }
  }
}

export function notePlaybackFetchEnd(): void {
  playbackInFlight = Math.max(0, playbackInFlight - 1)
  if (playbackInFlight === 0) {
    const wakers = playbackGateResolvers
    playbackGateResolvers = []
    for (const wake of wakers) { try { wake() } catch { /* best effort */ } }
  }
}

function awaitPlaybackIdle(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  if (playbackInFlight === 0) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const done = () => resolve()
    playbackGateResolvers.push(done)
    signal.addEventListener('abort', done, { once: true })
  })
}

export function cancelRollingCache(): void {
  if (!abortController && !state.active) return
  abortController?.abort()
  abortController = null
  const cancel = currentSynthCancel
  currentSynthCancel = null
  try { cancel?.() } catch { /* best effort */ }
  setState({ active: false, current: null, error: null })
}

export function startRollingCache(opts: RollingCacheStart): boolean {
  if (!isModelReady()) return false
  if (!opts.grid.length) return false
  // If we're already running the same (book, voice), don't restart.
  if (state.active && state.bookId === opts.bookId && state.voice === opts.voice) return true

  cancelRollingCache()
  const ctrl = new AbortController()
  abortController = ctrl
  setState({
    bookId: opts.bookId,
    voice: opts.voice,
    completed: 0,
    total: opts.grid.length,
    active: true,
    current: null,
    error: null,
  })
  void runLoop(opts, ctrl.signal)
  return true
}

async function runLoop(opts: RollingCacheStart, signal: AbortSignal): Promise<void> {
  const { grid, voice, speed, text, fromIdx = 0 } = opts
  let completed = Math.max(0, Math.min(fromIdx, grid.length))
  setState({ completed })

  for (let idx = fromIdx; idx < grid.length; idx += 1) {
    if (signal.aborted) return

    await awaitPlaybackIdle(signal)
    if (signal.aborted) return
    setState({ current: idx, error: null })

    const chunk = grid[idx]
    const result = await withChunkTimeout(
      prepareChunk({ chunk, text, voice, speed, signal }),
      signal,
    )
    if (signal.aborted) return
    if (result === 'cancelled') {
      idx -= 1
      continue
    }
    if (result !== 'done') {
      const message = result === 'timeout'
        ? 'Voice preparation timed out. Try again after Kokoro finishes warming, or use normal playback.'
        : 'Voice preparation failed. Try a different voice or retry after Kokoro finishes warming.'
      setState({ active: false, current: null, error: message })
      return
    }

    completed += 1
    setState({ completed })

    // Small idle yield so the main thread (and event loop) can breathe.
    await new Promise<void>((r) => setTimeout(r, 60))
  }

  if (!signal.aborted) {
    setState({ active: false, current: null, error: null })
  }
}

type SynthPersistResult = 'saved' | 'cancelled' | 'failed' | 'timeout'
type ChunkPrepareResult = 'done' | 'cancelled' | 'failed' | 'timeout'

async function prepareChunk({
  chunk,
  text,
  voice,
  speed,
  signal,
}: {
  chunk: { start: number; end: number } | undefined
  text: string
  voice: string
  speed: number
  signal: AbortSignal
}): Promise<ChunkPrepareResult> {
  if (!chunk || chunk.end <= chunk.start) return 'done'

  const chunkText = text.slice(chunk.start, chunk.end)
  if (!chunkText.trim()) return 'done'

  let cacheKey: string
  try {
    cacheKey = await localKokoroCacheKey(voice, speed, chunkText)
  } catch {
    return 'failed'
  }
  if (signal.aborted) return 'cancelled'

  const hit = await getCachedAudio(cacheKey, LOCAL_KOKORO_CACHE_VERSION).catch(() => null)
  if (signal.aborted) return 'cancelled'
  if (hit) return 'done'

  const result = await synthAndPersist(chunkText, voice, speed, cacheKey, signal)
  if (result === 'saved') return 'done'
  return result
}

function cancelCurrentRollingSynth(): void {
  const cancel = currentSynthCancel
  currentSynthCancel = null
  try { cancel?.() } catch { /* best effort */ }
}

function withChunkTimeout(
  work: Promise<ChunkPrepareResult>,
  signal: AbortSignal,
): Promise<ChunkPrepareResult> {
  if (signal.aborted) return Promise.resolve('cancelled')
  return new Promise((resolve) => {
    let settled = false
    let timeoutId: ReturnType<typeof setTimeout> | null = null
    let removeAbortListener: (() => void) | null = null
    const finish = (result: ChunkPrepareResult) => {
      if (settled) return
      settled = true
      if (timeoutId) clearTimeout(timeoutId)
      removeAbortListener?.()
      resolve(result)
    }
    const onAbort = () => {
      cancelCurrentRollingSynth()
      finish('cancelled')
    }

    timeoutId = setTimeout(() => {
      cancelCurrentRollingSynth()
      finish('timeout')
    }, ROLLING_CHUNK_TIMEOUT_MS)

    signal.addEventListener('abort', onAbort, { once: true })
    removeAbortListener = () => signal.removeEventListener('abort', onAbort)
    work.then(finish, () => finish('failed'))
  })
}

function synthAndPersist(
  text: string,
  voice: string,
  speed: number,
  cacheKey: string,
  signal: AbortSignal,
): Promise<SynthPersistResult> {
  return new Promise<SynthPersistResult>((resolve) => {
    if (signal.aborted) { resolve('cancelled'); return }
    let settled = false
    let timeoutId: ReturnType<typeof setTimeout> | null = null
    let removeAbortListener: (() => void) | null = null
    let synthCancel: (() => void) | null = null
    let cancelCurrentSynth: (() => void) | null = null
    const finish = (result: SynthPersistResult) => {
      if (settled) return
      settled = true
      if (timeoutId) clearTimeout(timeoutId)
      removeAbortListener?.()
      if (cancelCurrentSynth && currentSynthCancel === cancelCurrentSynth) currentSynthCancel = null
      resolve(result)
    }
    cancelCurrentSynth = () => {
      try { synthCancel?.() } catch { /* best effort */ }
      finish('cancelled')
    }

    const handle = synthesizeLocalStreaming(text, voice, speed, {
      onComplete: async (result) => {
        if (signal.aborted) { finish('cancelled'); return }
        try {
          const blob = new Blob([result.wav], { type: 'audio/wav' })
          await putCachedAudio({
            cacheKey,
            cacheVersion: LOCAL_KOKORO_CACHE_VERSION,
            blob,
            cues: [],
            duration: result.durationSec,
            contentType: 'audio/wav',
            byteLength: blob.size,
          })
        } catch {
          finish('failed')
          return
        }
        finish('saved')
      },
      onError: () => {
        finish('failed')
      },
    })

    if (!handle) { finish('failed'); return }
    if (settled) return
    synthCancel = handle.cancel
    currentSynthCancel = cancelCurrentSynth
    timeoutId = setTimeout(() => {
      try { synthCancel?.() } catch { /* best effort */ }
      finish('timeout')
    }, ROLLING_SYNTH_TIMEOUT_MS)

    const onAbort = () => {
      cancelCurrentSynth?.()
    }
    if (signal.aborted) {
      onAbort()
    } else {
      signal.addEventListener('abort', onAbort, { once: true })
      removeAbortListener = () => signal.removeEventListener('abort', onAbort)
    }
  })
}
