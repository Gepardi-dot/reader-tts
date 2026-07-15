// Manages the singleton Kokoro Web Worker on the main thread.
//
// Responsibilities:
//   - Lazy-spawn the worker on first warmup call.
//   - Track download + warmup progress; surface a small reactive store to the UI.
//   - Correlate synthesize requests/responses via a message id.
//   - Expose a streaming API so the reader can schedule sentence-level PCM as it
//     arrives (sub-200 ms time-to-first-audio after warmup).
//   - Cross-tab status sync via BroadcastChannel (best effort).
//
// The model itself is cached by the service worker (kokoro-model-v1 Cache
// Storage bucket — see web-next/public/sw.js), so a fresh tab/session reuses
// the bytes downloaded by any prior tab without re-fetching.

export type ModelStatus = 'idle' | 'downloading' | 'warming' | 'ready' | 'error'

export interface ModelState {
  status: ModelStatus
  progress: number   // 0..100, only meaningful while status === 'downloading'
  error: string | null
}

export interface SynthResult {
  wav: ArrayBuffer
  sampleRate: number
  durationSec: number
}

export interface StreamHandle {
  /** Sentence-level PCM chunk; schedule it on Web Audio immediately. */
  onChunk?: (pcm: Float32Array, sampleRate: number, index: number) => void
  /** Full assembled WAV — persist to IndexedDB so repeats hit cache. */
  onComplete: (result: SynthResult) => void
  /** Synthesis failed. Caller may fall back to the remote API. */
  onError: (err: Error) => void
}

type ProgressMsg = { type: 'progress'; progress: number; file?: string }
type WarmingMsg = { type: 'warming' }
type ReadyMsg = { type: 'ready' }
type WarmupErrorMsg = { type: 'warmup:error'; message: string }
type ChunkMsg = {
  type: 'chunk'
  id: string
  index: number
  pcm: Float32Array
  sampleRate: number
}
type ResultMsg = {
  type: 'result'
  id: string
  wav: ArrayBuffer
  sampleRate: number
  durationSec: number
}
type SynthErrorMsg = { type: 'error'; id: string; message: string }
type WorkerMsg =
  | ProgressMsg
  | WarmingMsg
  | ReadyMsg
  | WarmupErrorMsg
  | ChunkMsg
  | ResultMsg
  | SynthErrorMsg

const BROADCAST_NAME = 'kokoro-model-status'

let worker: Worker | null = null
let state: ModelState = { status: 'idle', progress: 0, error: null }
const listeners = new Set<(state: ModelState) => void>()
const pending = new Map<string, StreamHandle>()
let nextId = 1
/** One in-flight synth at a time — concurrent jobs thrash the single ONNX pipeline. */
let synthTail: Promise<void> = Promise.resolve()
const synthWaiters = new Map<string, { resolve: () => void; reject: (err: Error) => void }>()

let broadcast: BroadcastChannel | null = null
try {
  if (typeof BroadcastChannel !== 'undefined') {
    broadcast = new BroadcastChannel(BROADCAST_NAME)
    broadcast.addEventListener('message', (event: MessageEvent<ModelState>) => {
      // Adopt sibling-tab state when ours is less progressed.
      const remote = event.data
      if (!remote || typeof remote !== 'object') return
      if (state.status === 'ready') return
      const statusRank: Record<ModelStatus, number> = {
        idle: 0, error: 0, downloading: 1, warming: 2, ready: 3,
      }
      const remoteRank = statusRank[remote.status] ?? 0
      const localRank = statusRank[state.status] ?? 0
      if (remoteRank > localRank || (remoteRank === localRank && remote.progress > state.progress)) {
        setState({ ...remote }, /* broadcast */ false)
      }
    })
  }
} catch {
  broadcast = null
}

function setState(next: Partial<ModelState>, doBroadcast = true) {
  state = { ...state, ...next }
  for (const cb of listeners) {
    try { cb(state) } catch { /* listener error shouldn't break others */ }
  }
  if (doBroadcast && broadcast) {
    try { broadcast.postMessage(state) } catch { /* best effort */ }
  }
}

export function getModelStatus(): ModelState {
  return state
}

export function subscribeModelStatus(cb: (state: ModelState) => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

function handleWorkerMessage(event: MessageEvent<WorkerMsg>) {
  const msg = event.data
  if (!msg || typeof msg !== 'object') return
  switch (msg.type) {
    case 'progress':
      setState({ status: 'downloading', progress: Math.max(state.progress, msg.progress) })
      break
    case 'warming':
      setState({ status: 'warming', progress: 100, error: null })
      break
    case 'ready':
      setState({ status: 'ready', progress: 100, error: null })
      break
    case 'warmup:error':
      setState({ status: 'error', error: msg.message })
      worker?.terminate()
      worker = null
      break
    case 'chunk': {
      const slot = pending.get(msg.id)
      if (slot?.onChunk) {
        try { slot.onChunk(msg.pcm, msg.sampleRate, msg.index) }
        catch { /* listener fault shouldn't kill the stream */ }
      }
      break
    }
    case 'result': {
      const slot = pending.get(msg.id)
      if (slot) {
        pending.delete(msg.id)
        slot.onComplete({ wav: msg.wav, sampleRate: msg.sampleRate, durationSec: msg.durationSec })
      }
      const waiter = synthWaiters.get(msg.id)
      if (waiter) {
        synthWaiters.delete(msg.id)
        waiter.resolve()
      }
      break
    }
    case 'error': {
      const slot = pending.get(msg.id)
      if (slot) {
        pending.delete(msg.id)
        slot.onError(new Error(msg.message))
      }
      const waiter = synthWaiters.get(msg.id)
      if (waiter) {
        synthWaiters.delete(msg.id)
        waiter.resolve()
      }
      break
    }
  }
}

function ensureWorker(): Worker | null {
  if (worker) return worker
  if (typeof Worker === 'undefined') return null
  try {
    worker = new Worker(
      new URL('../../workers/kokoroWorker.ts', import.meta.url),
      { type: 'module', name: 'kokoro-tts' },
    )
    worker.addEventListener('message', handleWorkerMessage)
    worker.addEventListener('error', (event) => {
      setState({ status: 'error', error: event.message || 'Worker error' })
      worker?.terminate()
      worker = null
    })
    return worker
  } catch (err) {
    setState({ status: 'error', error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

export function startWarmup(): void {
  // Idempotent: already in flight or finished → noop.
  if (state.status === 'downloading' || state.status === 'warming' || state.status === 'ready') return
  const w = ensureWorker()
  if (!w) return
  setState({ status: 'downloading', progress: 0, error: null })
  w.postMessage({ type: 'warmup' })
}

export function isModelReady(): boolean {
  return state.status === 'ready'
}

export function waitForModelReady(signal?: AbortSignal): Promise<boolean> {
  if (isModelReady()) return Promise.resolve(true)
  if (signal?.aborted) return Promise.resolve(false)

  return new Promise((resolve) => {
    let done = false
    let unsubscribe: (() => void) | null = null

    const finish = (ready: boolean) => {
      if (done) return
      done = true
      unsubscribe?.()
      signal?.removeEventListener('abort', onAbort)
      resolve(ready)
    }
    const onAbort = () => finish(false)

    signal?.addEventListener('abort', onAbort, { once: true })
    unsubscribe = subscribeModelStatus((next) => {
      if (next.status === 'ready') finish(true)
      if (next.status === 'error') finish(false)
    })
    startWarmup()
  })
}

/**
 * Streaming synthesis. Resolves the worker handle synchronously so the caller
 * can start scheduling audio chunks as they arrive. `onComplete` fires once
 * the full WAV is assembled (use it for IndexedDB persistence). Returns a
 * cancel handle so the caller can abort if the user navigates away.
 *
 * Returns null when the model isn't ready — caller should fall back to remote
 * synthesis or display a "Preparing voice…" state.
 */
export function synthesizeLocalStreaming(
  text: string,
  voice: string,
  speed: number,
  handle: StreamHandle,
): { cancel: () => void } | null {
  if (state.status !== 'ready') return null
  const w = worker
  if (!w) return null

  const id = String(nextId++)
  let cancelled = false
  let started = false

  // Serialize synthesis: the ONNX worker degrades badly with concurrent jobs,
  // and overlapping synths cause underruns when the active one is delayed.
  const run = async () => {
    if (cancelled) return
    const activeWorker = worker
    if (!activeWorker || state.status !== 'ready') {
      if (!cancelled) handle.onError(new Error('Kokoro model is not ready.'))
      return
    }
    started = true
    pending.set(id, handle)
    const done = new Promise<void>((resolve) => {
      synthWaiters.set(id, { resolve, reject: () => resolve() })
    })
    try {
      activeWorker.postMessage({ type: 'synthesize', id, text, voice, speed })
    } catch (err) {
      pending.delete(id)
      synthWaiters.delete(id)
      if (!cancelled) handle.onError(err instanceof Error ? err : new Error(String(err)))
      return
    }
    await done
  }

  synthTail = synthTail.then(run, run)

  return {
    cancel: () => {
      cancelled = true
      if (!started) {
        // Job never reached the worker; the caller's abort handler settles.
        return
      }
      if (!pending.has(id)) return
      pending.delete(id)
      const waiter = synthWaiters.get(id)
      if (waiter) {
        synthWaiters.delete(id)
        waiter.resolve()
      }
      try { worker?.postMessage({ type: 'cancel', id }) } catch { /* best effort */ }
    },
  }
}

/**
 * IndexedDB cache key for on-device Kokoro WAV output. Voice + speed are part
 * of the key because they change the audio bytes; text is hashed (SHA-256) to
 * keep keys short. Bump LOCAL_KOKORO_CACHE_VERSION if the synth contract
 * changes (e.g. different sample rate, different post-processing).
 */
export const LOCAL_KOKORO_CACHE_VERSION = 1

export async function localKokoroCacheKey(voice: string, speed: number, text: string): Promise<string> {
  const encoder = new TextEncoder()
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text))
  const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
  return `local:kokoro:v${LOCAL_KOKORO_CACHE_VERSION}:${voice}:${speed.toFixed(3)}:${hex}`
}

/**
 * Legacy single-shot API. Resolves with the full WAV (or null if the model
 * isn't ready). Use synthesizeLocalStreaming() when you want sentence-level
 * audio chunks for low-latency playback.
 */
export async function synthesizeLocal(
  text: string,
  voice: string,
  speed: number,
): Promise<SynthResult | null> {
  return new Promise<SynthResult | null>((resolve) => {
    const stream = synthesizeLocalStreaming(text, voice, speed, {
      onComplete: (result) => resolve(result),
      onError: (err) => {
        if (typeof console !== 'undefined') {
          console.warn('[kokoro] local synthesis failed:', err)
        }
        resolve(null)
      },
    })
    if (!stream) resolve(null)
  })
}
