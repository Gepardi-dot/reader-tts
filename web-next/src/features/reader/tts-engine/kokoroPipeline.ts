/**
 * Kokoro continuous producer.
 *
 * - Stable segments + SegmentCache for instant hits
 * - Serial ONNX synth (via modelCache queue)
 * - Keeps AudioClock fed with a time watermark (~2s ahead)
 * - Playback work always beats idle prep
 */

import {
  isModelReady,
  startWarmup,
  waitForModelReady,
  synthesizeLocalStreaming,
} from '@/shared/storage/modelCache'
import {
  notePlaybackFetchEnd,
  notePlaybackFetchStart,
} from '@/shared/storage/rollingVoiceCache'
import { pacingFor } from '../audioPlayback'
import { AudioClock, pcmToAudioBuffer } from './audioClock'
import {
  getMemorySegment,
  getStoredSegment,
  putMemorySegment,
  putStoredSegment,
  segmentCacheKey,
  type SegmentAudio,
} from './segmentCache'
import {
  buildStableSegments,
  findSegmentIndexAt,
  type StableSegment,
} from './stableSegments'

export const KOKORO_WATERMARK_SEC = 2.0
export const KOKORO_PREFETCH_SEGMENTS = 4

export type KokoroPipelinePhase = 'idle' | 'buffering' | 'playing' | 'paused'

export interface KokoroPipelineSnapshot {
  phase: KokoroPipelinePhase
  currentIndex: number
  totalSegments: number
  bufferedSeconds: number
  word: string | null
  error: string | null
  cacheHit: boolean | null
}

export interface KokoroPipelineHooks {
  onSnapshot: () => void
  onSegmentStart: (segment: StableSegment, bufferTime: number) => void
  onProgress: (segment: StableSegment, bufferTime: number) => void
  onError: (message: string) => void
  onEnded: () => void
  onFirstAudio: (meta: {
    durationMs: number
    cacheHit: boolean | null
    cacheStorage: string | null
    segmentChars: number
  }) => void
}

export class KokoroPipeline {
  private readonly clock = new AudioClock()
  private generation = 0
  private controller: AbortController | null = null
  private phase: KokoroPipelinePhase = 'idle'
  private segments: StableSegment[] = []
  private cursor = 0
  private voice: string | null = null
  private speed = 1
  private word: string | null = null
  private error: string | null = null
  private producing = false
  private scheduledIds = new Set<string>()
  private firstAudioSent = false
  private startedAt = 0
  private lastCacheHit: boolean | null = null
  private hooks: KokoroPipelineHooks = {
    onSnapshot: () => undefined,
    onSegmentStart: () => undefined,
    onProgress: () => undefined,
    onError: () => undefined,
    onEnded: () => undefined,
    onFirstAudio: () => undefined,
  }

  setHooks(hooks: Partial<KokoroPipelineHooks>) {
    this.hooks = { ...this.hooks, ...hooks }
  }

  getSnapshot(): KokoroPipelineSnapshot {
    return {
      phase: this.phase,
      currentIndex: this.cursor,
      totalSegments: this.segments.length,
      bufferedSeconds: this.clock.bufferedAheadSeconds(),
      word: this.word,
      error: this.error,
      cacheHit: this.lastCacheHit,
    }
  }

  isActive() {
    return this.phase === 'playing' || this.phase === 'buffering' || this.clock.isActive
  }

  ensureContext() {
    return this.clock.ensureContext()
  }

  setRate(rate: number) {
    this.clock.setRate(rate)
  }

  stop() {
    this.generation += 1
    this.controller?.abort()
    this.controller = null
    this.clock.stop()
    this.producing = false
    this.segments = []
    this.cursor = 0
    this.scheduledIds.clear()
    this.firstAudioSent = false
    this.phase = 'idle'
    this.word = null
    this.error = null
    this.hooks.onSnapshot()
  }

  dispose() {
    this.stop()
    this.clock.close()
  }

  pause() {
    if (this.phase === 'buffering') {
      this.stop()
      return
    }
    if (this.phase !== 'playing') return
    void this.clock.pause()
    this.phase = 'paused'
    this.hooks.onSnapshot()
  }

  resume() {
    if (this.phase !== 'paused') return
    void this.clock.resume()
    this.phase = 'playing'
    this.hooks.onSnapshot()
  }

  toggle() {
    if (this.phase === 'buffering') this.stop()
    else if (this.phase === 'playing') this.pause()
    else if (this.phase === 'paused') this.resume()
  }

  /**
   * Idle prep: synth segments around an offset into cache without playing.
   * Playback always wins because synth is serialized and prep uses low priority
   * by only running when no controller is active.
   */
  async prepareWindow(input: {
    bookText: string
    offset: number
    voice: string
    maxSegments?: number
    signal?: AbortSignal
  }) {
    if (this.controller && !this.controller.signal.aborted) return
    startWarmup()
    if (!isModelReady()) {
      const ready = await waitForModelReady(input.signal)
      if (!ready) return
    }
    const { lengthScale } = pacingFor('kokoro')
    const speed = lengthScale > 0 ? 1 / lengthScale : 1
    const all = buildStableSegments(input.bookText)
    const startIdx = findSegmentIndexAt(all, input.offset)
    if (startIdx < 0) return
    const window = all.slice(startIdx, startIdx + (input.maxSegments ?? 8))
    const ctx = this.clock.ensureContext()
    for (const segment of window) {
      if (input.signal?.aborted) return
      if (this.controller && !this.controller.signal.aborted) return
      const key = await segmentCacheKey(input.voice, speed, segment)
      if (getMemorySegment(key)) continue
      const stored = await getStoredSegment(key, ctx)
      if (stored) continue
      await this.synthesizeToCache(segment, input.voice, speed, ctx, input.signal ?? new AbortController().signal)
    }
  }

  async start(input: {
    bookText: string
    startOffset: number
    voice: string
    rate: number
    word: string
    startedAt: number
  }) {
    this.stop()
    const generation = this.generation
    this.startedAt = input.startedAt
    this.word = input.word
    this.voice = input.voice
    this.clock.setRate(input.rate)
    this.phase = 'buffering'
    this.error = null
    this.hooks.onSnapshot()

    startWarmup()
    void this.clock.ensureContext().resume()

    if (!isModelReady()) {
      this.hooks.onError('Warming up Kokoro… first play is slower.')
      const ready = await waitForModelReady()
      if (generation !== this.generation) return
      if (!ready) {
        this.hooks.onError('Kokoro is still preparing. Wait for the model, then tap again.')
        this.stop()
        return
      }
    }

    const { lengthScale } = pacingFor('kokoro')
    this.speed = lengthScale > 0 ? 1 / lengthScale : 1

    // Full-book stable map; only play from the tapped segment forward.
    const all = buildStableSegments(input.bookText)
    const startIdx = findSegmentIndexAt(all, input.startOffset)
    if (startIdx < 0) {
      this.hooks.onError('There is no readable text at this position.')
      this.stop()
      return
    }
    this.segments = all.slice(startIdx).map((seg, index) => ({ ...seg, index }))
    this.cursor = 0

    const controller = new AbortController()
    this.controller = controller

    this.clock.setHandlers({
      onUnitStart: (unit) => {
        if (generation !== this.generation) return
        const seg = this.segments[unit.chunkIndex]
        if (seg) {
          this.cursor = unit.chunkIndex
          this.phase = 'playing'
          this.hooks.onSegmentStart(seg, 0)
          this.hooks.onSnapshot()
        }
        void this.pump(generation)
      },
      onProgress: (unit, currentTime) => {
        if (generation !== this.generation) return
        const seg = this.segments[unit.chunkIndex]
        if (seg) this.hooks.onProgress(seg, currentTime)
      },
      onUnderrun: () => {
        if (generation !== this.generation) return
        this.phase = 'buffering'
        this.hooks.onSnapshot()
        void this.pump(generation)
      },
      onEnded: () => {
        if (generation !== this.generation) return
        this.stop()
        this.hooks.onEnded()
      },
    })

    this.clock.setExpectMore(true)
    await this.pump(generation)
  }

  private async pump(generation: number) {
    if (generation !== this.generation || this.producing) return
    this.producing = true
    try {
      while (generation === this.generation && this.controller && !this.controller.signal.aborted) {
        const ahead = this.clock.bufferedAheadSeconds()
        const nextIndex = this.nextUnscheduledIndex()
        if (nextIndex < 0) {
          this.clock.setExpectMore(false)
          break
        }

        // Keep ~2s scheduled; always ensure at least the next segment if empty.
        if (ahead >= KOKORO_WATERMARK_SEC && this.clock.scheduledCount > 0) break

        const segment = this.segments[nextIndex]!
        if (this.scheduledIds.has(segment.id)) continue

        const ok = await this.scheduleSegment(segment, nextIndex, generation, this.controller.signal)
        if (generation !== this.generation || this.controller.signal.aborted) return
        if (!ok) {
          this.hooks.onError('Kokoro could not synthesize this passage.')
          this.stop()
          return
        }

        // Soft cap per pump turn so we yield to the event loop.
        if (this.clock.bufferedAheadSeconds() >= KOKORO_WATERMARK_SEC) break
      }
    } finally {
      this.producing = false
    }
  }

  private nextUnscheduledIndex() {
    for (let i = 0; i < this.segments.length; i += 1) {
      if (!this.scheduledIds.has(this.segments[i]!.id)) return i
    }
    return -1
  }

  /**
   * Cache-hit: append whole segment once.
   * Cache-miss: stream sentence PCM into the clock as frames arrive, then cache.
   */
  private async scheduleSegment(
    segment: StableSegment,
    index: number,
    generation: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (!this.voice) return false
    const key = await segmentCacheKey(this.voice, this.speed, segment)
    if (signal.aborted) return false

    const ctx = this.clock.ensureContext()
    const cached = getMemorySegment(key) ?? await getStoredSegment(key, ctx)
    if (signal.aborted || generation !== this.generation) return false

    if (cached) {
      this.scheduledIds.add(segment.id)
      this.lastCacheHit = true
      this.clock.setExpectMore(index < this.segments.length - 1)
      this.clock.append(cached.buffer, { chunkIndex: index })
      this.noteFirstAudio(segment, true, cached.cacheStorage)
      return true
    }

    return this.streamSegmentToClock(segment, index, key, generation, signal)
  }

  private streamSegmentToClock(
    segment: StableSegment,
    index: number,
    cacheKey: string,
    generation: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (!this.voice) return Promise.resolve(false)
    const voice = this.voice
    const speed = this.speed
    const ctx = this.clock.ensureContext()

    return new Promise((resolve) => {
      let settled = false
      const frameBuffers: AudioBuffer[] = []
      let cancel: (() => void) | null = null
      let streamed = false

      const finish = (ok: boolean) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        notePlaybackFetchEnd()
        resolve(ok)
      }

      const onAbort = () => {
        try { cancel?.() } catch { /* best effort */ }
        finish(false)
      }
      signal.addEventListener('abort', onAbort, { once: true })

      this.scheduledIds.add(segment.id)
      this.clock.setExpectMore(index < this.segments.length - 1)
      notePlaybackFetchStart()

      const handle = synthesizeLocalStreaming(segment.text, voice, speed, {
        onChunk: (pcm, sampleRate) => {
          if (settled || signal.aborted || generation !== this.generation || pcm.length === 0) return
          try {
            const buffer = pcmToAudioBuffer(ctx, pcm, sampleRate)
            frameBuffers.push(buffer)
            this.clock.append(buffer, { chunkIndex: index })
            streamed = true
            this.lastCacheHit = false
            this.noteFirstAudio(segment, false, 'generated')
          } catch {
            // skip bad frame
          }
        },
        onComplete: (result) => {
          if (settled || signal.aborted || generation !== this.generation) {
            finish(streamed)
            return
          }
          void (async () => {
            try {
              let buffer: AudioBuffer | null = null
              if (frameBuffers.length === 1) buffer = frameBuffers[0]!
              else if (frameBuffers.length > 1) buffer = concatAudioBuffers(ctx, frameBuffers)
              else if (result.wav.byteLength > 0) {
                buffer = await ctx.decodeAudioData(result.wav.slice(0))
                if (!streamed) {
                  this.clock.append(buffer, { chunkIndex: index })
                  streamed = true
                  this.noteFirstAudio(segment, false, 'generated')
                }
              }
              if (buffer) {
                const durationSec = result.durationSec || buffer.duration
                putMemorySegment(cacheKey, segment.id, buffer, durationSec)
                if (result.wav.byteLength > 0) {
                  void putStoredSegment({
                    key: cacheKey,
                    segmentId: segment.id,
                    buffer,
                    wav: result.wav,
                    durationSec,
                  })
                }
              }
              finish(streamed || Boolean(buffer))
            } catch {
              finish(streamed)
            }
          })()
        },
        onError: () => finish(streamed),
      })

      if (!handle) {
        this.scheduledIds.delete(segment.id)
        finish(false)
        return
      }
      cancel = handle.cancel
    })
  }

  private noteFirstAudio(
    segment: StableSegment,
    cacheHit: boolean,
    cacheStorage: string,
  ) {
    if (this.firstAudioSent) {
      if (this.phase === 'buffering') {
        this.phase = 'playing'
        this.hooks.onSnapshot()
      }
      return
    }
    this.firstAudioSent = true
    this.phase = 'playing'
    this.hooks.onFirstAudio({
      durationMs: Math.max(0, performance.now() - this.startedAt),
      cacheHit,
      cacheStorage,
      segmentChars: segment.text.length,
    })
    this.hooks.onSnapshot()
  }

  private async synthesizeToCache(
    segment: StableSegment,
    voice: string,
    speed: number,
    ctx: AudioContext,
    signal: AbortSignal,
  ): Promise<SegmentAudio | null> {
    // Idle prep path: wait for full result, no clock scheduling.
    return new Promise((resolve) => {
      let settled = false
      const frameBuffers: AudioBuffer[] = []
      let cancel: (() => void) | null = null

      const finish = (value: SegmentAudio | null) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        notePlaybackFetchEnd()
        resolve(value)
      }
      const onAbort = () => {
        try { cancel?.() } catch { /* best effort */ }
        finish(null)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      notePlaybackFetchStart()

      const handle = synthesizeLocalStreaming(segment.text, voice, speed, {
        onChunk: (pcm, sampleRate) => {
          if (settled || signal.aborted || pcm.length === 0) return
          try {
            frameBuffers.push(pcmToAudioBuffer(ctx, pcm, sampleRate))
          } catch {
            // skip
          }
        },
        onComplete: (result) => {
          if (settled || signal.aborted) {
            finish(null)
            return
          }
          void (async () => {
            try {
              let buffer: AudioBuffer
              if (frameBuffers.length === 1) buffer = frameBuffers[0]!
              else if (frameBuffers.length > 1) buffer = concatAudioBuffers(ctx, frameBuffers)
              else if (result.wav.byteLength > 0) buffer = await ctx.decodeAudioData(result.wav.slice(0))
              else {
                finish(null)
                return
              }
              const key = await segmentCacheKey(voice, speed, segment)
              const durationSec = result.durationSec || buffer.duration
              putMemorySegment(key, segment.id, buffer, durationSec)
              if (result.wav.byteLength > 0) {
                void putStoredSegment({
                  key,
                  segmentId: segment.id,
                  buffer,
                  wav: result.wav,
                  durationSec,
                })
              }
              finish({
                segmentId: segment.id,
                buffer,
                durationSec,
                cacheHit: false,
                cacheStorage: 'generated',
              })
            } catch {
              finish(null)
            }
          })()
        },
        onError: () => finish(null),
      })
      if (!handle) {
        finish(null)
        return
      }
      cancel = handle.cancel
    })
  }
}

function concatAudioBuffers(ctx: AudioContext, buffers: AudioBuffer[]): AudioBuffer {
  if (buffers.length === 1) return buffers[0]!
  const sampleRate = buffers[0]!.sampleRate
  let total = 0
  for (const b of buffers) total += b.length
  const out = ctx.createBuffer(1, Math.max(1, total), sampleRate)
  const channel = out.getChannelData(0)
  let offset = 0
  for (const b of buffers) {
    channel.set(b.getChannelData(0), offset)
    offset += b.length
  }
  return out
}
