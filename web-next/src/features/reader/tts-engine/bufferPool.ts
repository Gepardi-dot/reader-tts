import type { NativeAudioResult, TtsAudioChunk } from './types'

export type ChunkLoader = (
  chunk: TtsAudioChunk,
  signal: AbortSignal,
  options: {
    background: boolean
    /** Called as soon as each playable frame is ready (streaming Kokoro). */
    onFrame: (frame: NativeAudioResult & { buffer: AudioBuffer }) => void
  },
) => Promise<void>

export type BufferPoolListener = () => void

/**
 * Producer-side buffer manager. Loads text chunks through a provider loader,
 * dedupes in-flight work, prefetches ahead sequentially, and notifies
 * subscribers whenever a chunk or streamed frame becomes ready.
 */
export class BufferPool {
  private chunks: TtsAudioChunk[]
  private readonly loader: ChunkLoader
  private readonly inflight = new Map<number, Promise<void>>()
  private readonly listeners = new Set<BufferPoolListener>()
  private prefetchChain: Promise<void> = Promise.resolve()
  private frameHandlers = new Set<(chunkIndex: number, result: NativeAudioResult & { buffer: AudioBuffer }) => void>()

  constructor(chunks: TtsAudioChunk[], loader: ChunkLoader) {
    this.chunks = chunks
    this.loader = loader
  }

  get allChunks() {
    return this.chunks
  }

  get length() {
    return this.chunks.length
  }

  subscribe(listener: BufferPoolListener) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  onFrame(handler: (chunkIndex: number, result: NativeAudioResult & { buffer: AudioBuffer }) => void) {
    this.frameHandlers.add(handler)
    return () => {
      this.frameHandlers.delete(handler)
    }
  }

  readyRunFrom(index: number) {
    let count = 0
    let seconds = 0
    for (let cursor = Math.max(0, index); cursor < this.chunks.length; cursor += 1) {
      const chunk = this.chunks[cursor]
      // Count chunks that have at least one playable frame (ready or still streaming).
      if (!chunk || !chunk.buffer || (chunk.status !== 'ready' && chunk.status !== 'fetching')) break
      count += 1
      seconds += chunk.durationSec ?? chunk.buffer.duration ?? 0
      if (chunk.status === 'fetching') break
    }
    return { count, seconds }
  }

  /**
   * Ensure chunk `index` is loaded. Streaming loaders may emit frames via
   * `onFrame` before the promise settles.
   */
  ensure(index: number, signal: AbortSignal, background = false): Promise<void> {
    const chunk = this.chunks[index]
    if (!chunk) return Promise.resolve()
    if (chunk.status === 'ready' && chunk.buffer) {
      // Re-emit so a late subscriber (clock) can schedule a cache-hit chunk.
      this.emitFrame(index, {
        url: chunk.url,
        buffer: chunk.buffer,
        cues: chunk.cues,
        durationSec: chunk.durationSec,
        cacheHit: chunk.cacheHit,
        cacheStorage: chunk.cacheStorage,
      })
      return Promise.resolve()
    }

    const existing = this.inflight.get(index)
    if (existing) return existing

    this.patch(index, { status: 'fetching' })
    let receivedFrames = 0
    const promise = this.loader(chunk, signal, {
      background,
      onFrame: (frame) => {
        if (signal.aborted) return
        receivedFrames += 1
        const extra = frame.durationSec ?? frame.buffer.duration
        const prev = receivedFrames === 1 ? 0 : (chunk.durationSec ?? 0)
        // Stay in 'fetching' until the loader settles so the clock knows more
        // stream frames may still arrive (avoids false end-of-stream underruns).
        this.patch(index, {
          status: 'fetching',
          buffer: frame.buffer,
          url: frame.url ?? chunk.url,
          cues: frame.cues?.length ? frame.cues : chunk.cues,
          durationSec: prev + extra,
          cacheHit: frame.cacheHit ?? chunk.cacheHit,
          cacheStorage: frame.cacheStorage ?? chunk.cacheStorage,
        })
        this.emitFrame(index, frame)
      },
    })
      .then(() => {
        if (signal.aborted) return
        if (receivedFrames > 0 || chunk.buffer) {
          this.patch(index, { status: 'ready' })
          return
        }
        this.patch(index, { status: background ? 'idle' : 'error' })
      })
      .catch((error) => {
        if (!signal.aborted) {
          this.patch(index, {
            status: receivedFrames > 0 ? 'ready' : (background ? 'idle' : 'error'),
          })
        }
        if (!background) throw error
      })
      .finally(() => {
        this.inflight.delete(index)
      })

    this.inflight.set(index, promise)
    return promise
  }

  /**
   * Prefetch chunks starting at `index` for `target` count.
   * Hosted paths benefit from parallel kick-off (default); on-device serial
   * loaders still dedupe via `ensure` inflight maps.
   */
  prefetchFrom(
    index: number,
    target: number,
    signal: AbortSignal,
    options?: { parallel?: boolean },
  ) {
    if (signal.aborted) return Promise.resolve()
    const start = Math.max(0, index)
    const stop = Math.min(this.chunks.length - 1, start + Math.max(0, target) - 1)
    const parallel = options?.parallel !== false

    const run = async () => {
      if (parallel) {
        const jobs: Promise<void>[] = []
        for (let cursor = start; cursor <= stop; cursor += 1) {
          if (signal.aborted) return
          const chunk = this.chunks[cursor]
          if (!chunk || chunk.status === 'ready' || chunk.status === 'fetching') continue
          jobs.push(this.ensure(cursor, signal, true).catch(() => undefined))
        }
        await Promise.all(jobs)
        return
      }
      for (let cursor = start; cursor <= stop; cursor += 1) {
        if (signal.aborted) return
        const chunk = this.chunks[cursor]
        if (!chunk || chunk.status === 'ready' || chunk.status === 'fetching') continue
        await this.ensure(cursor, signal, true)
      }
    }

    const next = this.prefetchChain.catch(() => undefined).then(run)
    this.prefetchChain = next.catch(() => undefined)
    return next
  }

  reset() {
    this.inflight.clear()
    this.prefetchChain = Promise.resolve()
  }

  private emitFrame(chunkIndex: number, result: NativeAudioResult & { buffer: AudioBuffer }) {
    for (const handler of this.frameHandlers) {
      try {
        handler(chunkIndex, result)
      } catch {
        // Frame observers must not break the pool.
      }
    }
  }

  private patch(index: number, patch: Partial<TtsAudioChunk>) {
    const chunk = this.chunks[index]
    if (!chunk) return
    Object.assign(chunk, patch)
    this.notify()
  }

  private notify() {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        // Store observers should not break playback.
      }
    }
  }
}
