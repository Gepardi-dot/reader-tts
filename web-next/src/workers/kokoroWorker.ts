/// <reference lib="webworker" />
// Web Worker — runs Kokoro TTS inference off the main thread.
//
// Lifecycle:
//   1. Main posts { type: 'warmup' } → worker downloads the model (~82 MB, q8),
//      then runs a dummy synth so WASM kernels are compiled and tensors allocated.
//      Posts 'progress', 'warming', 'ready' in that order.
//   2. Main posts { type: 'synthesize' } → worker streams sentence-level PCM
//      chunks back, then posts the final WAV for IndexedDB caching.
//
// The model singleton lives for the worker's lifetime; the worker stays warm so the
// next synth request has zero load cost.

import { KokoroTTS } from 'kokoro-js'
import { env } from '@huggingface/transformers'

declare const self: DedicatedWorkerGlobalScope

type WarmupIn = { type: 'warmup' }
type SynthIn = {
  type: 'synthesize'
  id: string
  text: string
  voice: string
  speed: number
}
type CancelIn = { type: 'cancel'; id: string }
type In = WarmupIn | SynthIn | CancelIn

type ProgressOut = { type: 'progress'; progress: number; file?: string }
type WarmingOut = { type: 'warming' }
type ReadyOut = { type: 'ready' }
type WarmupErrorOut = { type: 'warmup:error'; message: string }
type ChunkOut = {
  type: 'chunk'
  id: string
  index: number
  pcm: Float32Array
  sampleRate: number
}
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
  | WarmingOut
  | ReadyOut
  | WarmupErrorOut
  | ChunkOut
  | ResultOut
  | SynthErrorOut

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX'

let pipeline: KokoroTTS | null = null
let warmupPromise: Promise<void> | null = null
const cancelled = new Set<string>()

// Multithreaded WASM requires SharedArrayBuffer, which is only available when the
// page is cross-origin isolated (COOP: same-origin + COEP: require-corp). When
// available, give ORT all the cores we can; otherwise it silently falls back to
// the single-threaded build and runs ~3× slower.
if (typeof SharedArrayBuffer !== 'undefined') {
  const hw = (self as DedicatedWorkerGlobalScope & { navigator?: { hardwareConcurrency?: number } })
    .navigator?.hardwareConcurrency
  const wasmEnv = env.backends.onnx.wasm
  if (wasmEnv) wasmEnv.numThreads = Math.min(8, Math.max(1, hw ?? 4))
}

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
      // Model bytes in memory ≠ ready to play. The first generate() call still
      // pays WASM-kernel compilation + tensor-buffer allocation (~1–3 s on cold
      // hardware). Run a throwaway synth here so the first real user request
      // sees a hot pipeline.
      post({ type: 'warming' })
      try {
        await pipeline.generate('a', { voice: 'af_heart' as never, speed: 1 as never })
      } catch {
        // Warmup synth failure is non-fatal — user-facing synth will surface its own error.
      }
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

function concatFloat32(parts: Float32Array[]): Float32Array {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Float32Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

function pcmToWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const bytesPerSample = 2
  const numChannels = 1
  const blockAlign = numChannels * bytesPerSample
  const byteRate = sampleRate * blockAlign
  const dataSize = samples.length * bytesPerSample
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)
  // RIFF header
  view.setUint32(0, 0x52494646, false) // 'RIFF'
  view.setUint32(4, 36 + dataSize, true)
  view.setUint32(8, 0x57415645, false) // 'WAVE'
  // fmt chunk
  view.setUint32(12, 0x666d7420, false) // 'fmt '
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, 16, true)
  // data chunk
  view.setUint32(36, 0x64617461, false) // 'data'
  view.setUint32(40, dataSize, true)
  let offset = 44
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return buffer
}

async function synthesize(msg: SynthIn) {
  try {
    if (!pipeline) await warmup()
    if (!pipeline) {
      post({ type: 'error', id: msg.id, message: 'Model not initialized' })
      return
    }

    let index = 0
    const collected: Float32Array[] = []
    let sampleRate = 24000

    const iterator = pipeline.stream(msg.text, {
      voice: msg.voice as never,
      speed: msg.speed as never,
    })

    for await (const chunk of iterator) {
      if (cancelled.has(msg.id)) {
        cancelled.delete(msg.id)
        return
      }
      const raw = chunk.audio
      sampleRate = raw.sampling_rate ?? sampleRate
      const pcm = raw.audio
      // Keep an owned copy for the final WAV (the original goes via transfer).
      collected.push(new Float32Array(pcm))
      post(
        { type: 'chunk', id: msg.id, index, pcm, sampleRate },
        [pcm.buffer],
      )
      index++
    }

    if (collected.length === 0) {
      // Empty input or stream emitted nothing — return silence; the caller
      // path uses the WAV existence as the cache trigger.
      post({ type: 'result', id: msg.id, wav: pcmToWav(new Float32Array(0), sampleRate), sampleRate, durationSec: 0 })
      return
    }

    const full = concatFloat32(collected)
    const wav = pcmToWav(full, sampleRate)
    const durationSec = full.length / sampleRate
    post({ type: 'result', id: msg.id, wav, sampleRate, durationSec }, [wav])
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
  } else if (data.type === 'cancel') {
    cancelled.add(data.id)
  }
})

export {}
