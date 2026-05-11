/// <reference lib="webworker" />
// Web Worker — runs Kokoro TTS inference off the main thread.
//
// Lifecycle:
//   1. Main posts { type: 'warmup' } → worker downloads + caches the model (~82 MB, q8)
//      using transformers.js Cache API. Progress is reported as percent.
//   2. Main posts { type: 'synthesize' } → worker runs inference, returns Float32 PCM.
//
// The model singleton lives for the worker's lifetime; the worker stays warm so the
// next synth request has zero load cost.

import { KokoroTTS } from 'kokoro-js'

declare const self: DedicatedWorkerGlobalScope

type WarmupIn = { type: 'warmup' }
type SynthIn = {
  type: 'synthesize'
  id: string
  text: string
  voice: string
  speed: number
}
type In = WarmupIn | SynthIn

type ProgressOut = { type: 'progress'; progress: number; file?: string }
type ReadyOut = { type: 'ready' }
type WarmupErrorOut = { type: 'warmup:error'; message: string }
type ResultOut = {
  type: 'result'
  id: string
  wav: ArrayBuffer
  sampleRate: number
  durationSec: number
}
type SynthErrorOut = { type: 'error'; id: string; message: string }

type Out =
  | ProgressOut
  | ReadyOut
  | WarmupErrorOut
  | ResultOut
  | SynthErrorOut

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX'

let pipeline: KokoroTTS | null = null
let warmupPromise: Promise<void> | null = null

function post(msg: Out, transfer?: Transferable[]) {
  (self as DedicatedWorkerGlobalScope).postMessage(msg, transfer ?? [])
}

async function pickDevice(): Promise<'webgpu' | 'wasm'> {
  // WebGPU is dramatically faster when available; fall back to WASM otherwise.
  const nav = (globalThis as { navigator?: { gpu?: { requestAdapter: () => Promise<unknown> } } }).navigator
  const gpu = nav?.gpu
  if (!gpu) return 'wasm'
  try {
    const adapter = await gpu.requestAdapter()
    return adapter ? 'webgpu' : 'wasm'
  } catch {
    return 'wasm'
  }
}

async function warmup() {
  if (pipeline) {
    post({ type: 'ready' })
    return
  }
  if (warmupPromise) {
    await warmupPromise
    return
  }
  warmupPromise = (async () => {
    const device = await pickDevice()
    try {
      pipeline = await KokoroTTS.from_pretrained(MODEL_ID, {
        dtype: 'q8',
        device,
        progress_callback: (data: { progress?: number; file?: string; status?: string }) => {
          if (typeof data.progress === 'number') {
            post({
              type: 'progress',
              progress: Math.max(0, Math.min(100, Math.round(data.progress))),
              file: data.file,
            })
          }
        },
      })
      post({ type: 'ready' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      post({ type: 'warmup:error', message })
      throw err
    }
  })()
  try {
    await warmupPromise
  } finally {
    if (!pipeline) warmupPromise = null
  }
}

async function synthesize(msg: SynthIn) {
  try {
    if (!pipeline) {
      // If a synthesize arrives before warmup completes, kick off warmup and wait.
      await warmup()
    }
    if (!pipeline) {
      post({ type: 'error', id: msg.id, message: 'Model not initialized' })
      return
    }
    // kokoro-js types don't expose a `speed` field on GenerateOptions for some
    // model revisions, so cast the options bag.
    const audio = await pipeline.generate(msg.text, { voice: msg.voice as never, speed: msg.speed as never })
    const sampleRate = audio.sampling_rate ?? 24000
    const samples = audio.audio
    const durationSec = samples.length / sampleRate
    const wav = audio.toWav()
    post(
      { type: 'result', id: msg.id, wav, sampleRate, durationSec },
      [wav],
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    post({ type: 'error', id: msg.id, message })
  }
}

self.addEventListener('message', (event: MessageEvent<In>) => {
  const data = event.data
  if (!data || typeof data !== 'object') return
  if (data.type === 'warmup') {
    void warmup()
  } else if (data.type === 'synthesize') {
    void synthesize(data)
  }
})

export {}
