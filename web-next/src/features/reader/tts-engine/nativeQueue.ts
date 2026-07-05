import type { NativeAudioResult, TtsAudioChunk } from './types'

export const MIN_NATIVE_HANDOFF_CHUNKS = 2
export const MIN_NATIVE_HANDOFF_SECONDS = 8

type NativeFetcher = (chunk: TtsAudioChunk, signal: AbortSignal, background: boolean) => Promise<NativeAudioResult | null>
type QueueListener = () => void

export class TtsNativeQueue {
  private chunks: TtsAudioChunk[]
  private readonly fetcher: NativeFetcher
  private readonly inflight = new Map<number, Promise<NativeAudioResult | null>>()
  private readonly listeners = new Set<QueueListener>()
  private prefetchChain: Promise<void> = Promise.resolve()

  constructor(chunks: TtsAudioChunk[], fetcher: NativeFetcher) {
    this.chunks = chunks
    this.fetcher = fetcher
  }

  get allChunks() {
    return this.chunks
  }

  subscribe(listener: QueueListener) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  replaceChunks(chunks: TtsAudioChunk[]) {
    this.chunks = chunks
    this.inflight.clear()
    this.notify()
  }

  readyRunFrom(index: number) {
    let count = 0
    let seconds = 0
    for (let cursor = Math.max(0, index); cursor < this.chunks.length; cursor += 1) {
      const chunk = this.chunks[cursor]
      if (!chunk || chunk.status !== 'ready' || !chunk.buffer) break
      count += 1
      seconds += chunk.durationSec ?? chunk.buffer.duration ?? 0
    }
    return { count, seconds }
  }

  shouldStartNativeFrom(index: number) {
    const remaining = Math.max(0, this.chunks.length - Math.max(0, index))
    if (remaining === 0) return false
    const ready = this.readyRunFrom(index)
    return (
      ready.count >= Math.min(MIN_NATIVE_HANDOFF_CHUNKS, remaining) ||
      ready.seconds >= MIN_NATIVE_HANDOFF_SECONDS ||
      (remaining <= 1 && ready.count === remaining)
    )
  }

  async ensure(index: number, signal: AbortSignal, background = false) {
    const chunk = this.chunks[index]
    if (!chunk) return null
    if (chunk.status === 'ready' && chunk.buffer) return {
      url: chunk.url,
      buffer: chunk.buffer,
      cues: chunk.cues,
      durationSec: chunk.durationSec,
      cacheHit: chunk.cacheHit,
      cacheStorage: chunk.cacheStorage,
    }
    const existing = this.inflight.get(index)
    if (existing) return existing

    this.patch(index, { status: 'fetching' })
    const fetchPromise = this.fetcher(chunk, signal, background)
      .then((result) => {
        if (signal.aborted) return null
        if (!result?.buffer) {
          this.patch(index, { status: background ? 'idle' : 'error' })
          return null
        }
        this.patch(index, {
          status: 'ready',
          url: result.url,
          buffer: result.buffer,
          cues: result.cues,
          durationSec: result.durationSec ?? result.buffer.duration,
          cacheHit: result.cacheHit,
          cacheStorage: result.cacheStorage,
        })
        return result
      })
      .catch(() => {
        if (!signal.aborted) this.patch(index, { status: background ? 'idle' : 'error' })
        return null
      })
      .finally(() => {
        this.inflight.delete(index)
      })

    this.inflight.set(index, fetchPromise)
    return fetchPromise
  }

  prefetchFrom(index: number, target: number, signal: AbortSignal) {
    if (signal.aborted) return Promise.resolve()
    const start = Math.max(0, index)
    const stop = Math.min(this.chunks.length - 1, start + Math.max(0, target))

    const run = async () => {
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

  resetInflight() {
    this.inflight.clear()
    this.prefetchChain = Promise.resolve()
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
