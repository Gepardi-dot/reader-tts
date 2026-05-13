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
}

const listeners = new Set<(state: RollingCacheState) => void>()
let state: RollingCacheState = {
  bookId: null, voice: null, completed: 0, total: 0, active: false,
}

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
  setState({ active: false })
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

    const chunk = grid[idx]
    if (!chunk || chunk.end <= chunk.start) {
      completed += 1
      setState({ completed })
      continue
    }

    const chunkText = text.slice(chunk.start, chunk.end)
    if (!chunkText.trim()) {
      completed += 1
      setState({ completed })
      continue
    }

    let cacheKey: string
    try {
      cacheKey = await localKokoroCacheKey(voice, speed, chunkText)
    } catch {
      continue
    }
    if (signal.aborted) return

    const hit = await getCachedAudio(cacheKey, LOCAL_KOKORO_CACHE_VERSION).catch(() => null)
    if (!hit) {
      await synthAndPersist(chunkText, voice, speed, cacheKey, signal)
      if (signal.aborted) return
    }

    completed += 1
    setState({ completed })

    // Small idle yield so the main thread (and event loop) can breathe.
    await new Promise<void>((r) => setTimeout(r, 60))
  }

  if (!signal.aborted) {
    setState({ active: false })
  }
}

function synthAndPersist(
  text: string,
  voice: string,
  speed: number,
  cacheKey: string,
  signal: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) { resolve(); return }
    let settled = false
    const finish = () => { if (!settled) { settled = true; resolve() } }

    const handle = synthesizeLocalStreaming(text, voice, speed, {
      onComplete: async (result) => {
        currentSynthCancel = null
        if (signal.aborted) { finish(); return }
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
        } catch { /* persistence failure non-fatal */ }
        finish()
      },
      onError: () => {
        currentSynthCancel = null
        finish()
      },
    })

    if (!handle) { finish(); return }
    currentSynthCancel = handle.cancel

    const onAbort = () => {
      const cancel = currentSynthCancel
      currentSynthCancel = null
      try { cancel?.() } catch { /* best effort */ }
      finish()
    }
    if (signal.aborted) {
      onAbort()
    } else {
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}
