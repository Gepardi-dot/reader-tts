// Manages the singleton Kokoro Web Worker on the main thread.
//
// Responsibilities:
//   - Lazy-spawn the worker on first warmup call.
//   - Track download progress and surface a small reactive store to the UI.
//   - Correlate synthesize requests/responses via a message id.
//   - Cross-tab status sync via BroadcastChannel (best effort).
//
// The model itself is cached by transformers.js (browser Cache API), so a fresh
// tab/session reuses the bytes downloaded by any prior tab without re-fetching.

export type ModelStatus = 'idle' | 'downloading' | 'ready' | 'error'

export interface ModelState {
  status: ModelStatus
  progress: number   // 0..100, only meaningful while status === 'downloading'
  error: string | null
}

interface SynthResult {
  wav: ArrayBuffer
  sampleRate: number
  durationSec: number
}

type ProgressMsg = { type: 'progress'; progress: number; file?: string }
type ReadyMsg = { type: 'ready' }
type WarmupErrorMsg = { type: 'warmup:error'; message: string }
type ResultMsg = {
  type: 'result'
  id: string
  wav: ArrayBuffer
  sampleRate: number
  durationSec: number
}
type SynthErrorMsg = { type: 'error'; id: string; message: string }
type WorkerMsg = ProgressMsg | ReadyMsg | WarmupErrorMsg | ResultMsg | SynthErrorMsg

const BROADCAST_NAME = 'kokoro-model-status'

let worker: Worker | null = null
let state: ModelState = { status: 'idle', progress: 0, error: null }
const listeners = new Set<(state: ModelState) => void>()
const pending = new Map<string, {
  resolve: (value: SynthResult) => void
  reject: (reason: Error) => void
}>()
let nextId = 1

let broadcast: BroadcastChannel | null = null
try {
  if (typeof BroadcastChannel !== 'undefined') {
    broadcast = new BroadcastChannel(BROADCAST_NAME)
    broadcast.addEventListener('message', (event: MessageEvent<ModelState>) => {
      // Adopt sibling-tab state only when ours is less progressed.
      const remote = event.data
      if (!remote || typeof remote !== 'object') return
      if (state.status === 'ready') return
      if (remote.status === 'ready' || remote.progress > state.progress) {
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
    case 'ready':
      setState({ status: 'ready', progress: 100, error: null })
      break
    case 'warmup:error':
      setState({ status: 'error', error: msg.message })
      // Allow retry on next startWarmup call.
      worker?.terminate()
      worker = null
      break
    case 'result': {
      const slot = pending.get(msg.id)
      if (slot) {
        pending.delete(msg.id)
        slot.resolve({ wav: msg.wav, sampleRate: msg.sampleRate, durationSec: msg.durationSec })
      }
      break
    }
    case 'error': {
      const slot = pending.get(msg.id)
      if (slot) {
        pending.delete(msg.id)
        slot.reject(new Error(msg.message))
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
  // Idempotent: already running or finished → noop.
  if (state.status === 'downloading' || state.status === 'ready') return
  const w = ensureWorker()
  if (!w) return
  setState({ status: 'downloading', progress: 0, error: null })
  w.postMessage({ type: 'warmup' })
}

export function isModelReady(): boolean {
  return state.status === 'ready'
}

export async function synthesizeLocal(
  text: string,
  voice: string,
  speed: number,
): Promise<SynthResult | null> {
  if (state.status !== 'ready') return null
  const w = worker
  if (!w) return null

  const id = String(nextId++)
  return new Promise<SynthResult | null>((resolve, reject) => {
    pending.set(id, {
      resolve: (value) => resolve(value),
      reject: (reason) => reject(reason),
    })
    try {
      w.postMessage({ type: 'synthesize', id, text, voice, speed })
    } catch (err) {
      pending.delete(id)
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  }).catch((err) => {
    // Swallow errors → caller falls back to the remote API path.
    if (typeof console !== 'undefined') {
      console.warn('[kokoro] local synthesis failed:', err)
    }
    return null
  })
}
