/**
 * KokoroEngine — cache-first continuous playback.
 *
 * Design (not a patch of the old chunk controller):
 *
 * 1. PREHEAT is the product feature. Scrolling / opening a book fills
 *    SegmentCache so taps are memory hits (~instant).
 * 2. PLAY never waits for a long multi-sentence synth on the critical path.
 *    - Cache hit → schedule immediately.
 *    - Cache miss → synth a MICRO lead (first short sentence only) and stream
 *      it; the rest of the segment + following segments fill behind a watermark.
 * 3. MODEL GATE: if the ONNX model is still downloading, we keep a play-intent
 *    and auto-start when ready — no silent multi-second hang.
 * 4. PREP YIELDS to PLAY: active sessions own the serialized worker queue.
 */

import {
  getModelStatus,
  isModelReady,
  startWarmup,
  subscribeModelStatus,
  synthesizeLocalStreaming,
  waitForModelReady,
} from '@/shared/storage/modelCache'
import {
  notePlaybackFetchEnd,
  notePlaybackFetchStart,
} from '@/shared/storage/rollingVoiceCache'
import { decodeAudioDataSafe } from '@/lib/browser'
import { pacingFor } from '../audioPlayback'
import { AudioClock, pcmToAudioBuffer } from './audioClock'
import {
  getMemorySegment,
  getStoredSegment,
  putMemorySegment,
  putStoredSegment,
  segmentCacheKey,
} from './segmentCache'
import {
  buildStableSegments,
  findSegmentIndexAt,
  type StableSegment,
} from './stableSegments'

/** Keep this much audio on the WebAudio timeline while playing. */
const WATERMARK_SEC = 2.2
/** Segments idle-prep tries to fill around the viewport. */
export const PREHEAT_SEGMENTS = 12

export type KokoroPhase = 'idle' | 'buffering' | 'playing' | 'paused'

export interface KokoroEngineSnapshot {
  phase: KokoroPhase
  currentIndex: number
  totalSegments: number
  bufferedSeconds: number
  word: string | null
  error: string | null
  cacheHit: boolean | null
  modelStatus: string
  modelProgress: number
  statusText: string | null
}

export interface KokoroEngineHooks {
  onSnapshot: () => void
  onSegmentStart: (segment: StableSegment, t: number) => void
  onProgress: (segment: StableSegment, t: number) => void
  onError: (message: string) => void
  onEnded: () => void
  onFirstAudio: (meta: {
    durationMs: number
    cacheHit: boolean | null
    cacheStorage: string | null
    segmentChars: number
  }) => void
}

interface PlayRequest {
  bookText: string
  startOffset: number
  voice: string
  rate: number
  word: string
  startedAt: number
}

export class KokoroEngine {
  private readonly clock = new AudioClock()
  private generation = 0
  private playAbort: AbortController | null = null
  private prepAbort: AbortController | null = null
  private phase: KokoroPhase = 'idle'
  private segments: StableSegment[] = []
  private cursor = 0
  private voice: string | null = null
  private speed = 1
  private word: string | null = null
  private error: string | null = null
  private statusText: string | null = null
  private producing = false
  private scheduledKeys = new Set<string>()
  private firstAudioSent = false
  private startedAt = 0
  private lastCacheHit: boolean | null = null
  private pendingPlay: PlayRequest | null = null
  private unsubModel: (() => void) | null = null
  private hooks: KokoroEngineHooks = {
    onSnapshot: () => undefined,
    onSegmentStart: () => undefined,
    onProgress: () => undefined,
    onError: () => undefined,
    onEnded: () => undefined,
    onFirstAudio: () => undefined,
  }

  constructor() {
    this.unsubModel = subscribeModelStatus(() => {
      if (this.phase === 'buffering' || this.pendingPlay) this.hooks.onSnapshot()
    })
  }

  setHooks(hooks: Partial<KokoroEngineHooks>) {
    this.hooks = { ...this.hooks, ...hooks }
  }

  getSnapshot(): KokoroEngineSnapshot {
    const model = getModelStatus()
    return {
      phase: this.phase,
      currentIndex: this.cursor,
      totalSegments: this.segments.length,
      bufferedSeconds: this.clock.bufferedAheadSeconds(),
      word: this.word,
      error: this.error,
      cacheHit: this.lastCacheHit,
      modelStatus: model.status,
      modelProgress: model.progress,
      statusText: this.statusText ?? this.deriveStatusText(model.status, model.progress),
    }
  }

  isActive() {
    return this.phase === 'playing' || this.phase === 'buffering' || this.clock.isActive
  }

  setRate(rate: number) {
    this.clock.setRate(rate)
  }

  stop() {
    this.generation += 1
    this.playAbort?.abort()
    this.playAbort = null
    this.pendingPlay = null
    this.clock.stop()
    this.producing = false
    this.segments = []
    this.cursor = 0
    this.scheduledKeys.clear()
    this.firstAudioSent = false
    this.phase = 'idle'
    this.word = null
    this.error = null
    this.statusText = null
    this.hooks.onSnapshot()
  }

  dispose() {
    this.stop()
    this.prepAbort?.abort()
    this.prepAbort = null
    this.unsubModel?.()
    this.unsubModel = null
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
    this.clock.unlock()
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
   * Fill SegmentCache around an offset. Safe to call often; yields if playback
   * owns the session. This is what makes taps feel instant.
   */
  async preheat(input: {
    bookText: string
    offset: number
    voice: string
    maxSegments?: number
  }) {
    startWarmup()
    this.prepAbort?.abort()
    const prep = new AbortController()
    this.prepAbort = prep

    if (!isModelReady()) {
      const ready = await waitForModelReady(prep.signal)
      if (!ready || prep.signal.aborted) return
    }
    // Playback owns the worker.
    if (this.playAbort && !this.playAbort.signal.aborted) return

    const { lengthScale } = pacingFor('kokoro')
    const speed = lengthScale > 0 ? 1 / lengthScale : 1
    const all = buildStableSegments(input.bookText)
    const startIdx = findSegmentIndexAt(all, input.offset)
    if (startIdx < 0) return
    const window = all.slice(startIdx, startIdx + (input.maxSegments ?? PREHEAT_SEGMENTS))
    const ctx = this.clock.ensureContext()

    for (const segment of window) {
      if (prep.signal.aborted) return
      if (this.playAbort && !this.playAbort.signal.aborted) return
      const key = await segmentCacheKey(input.voice, speed, segment)
      if (getMemorySegment(key)) continue
      const stored = await getStoredSegment(key, ctx).catch(() => null)
      if (stored || prep.signal.aborted) continue
      await this.synthFullToCache(segment, input.voice, speed, ctx, prep.signal)
    }
  }

  async start(req: PlayRequest) {
    // Cancel prep so the worker is free for audible work.
    this.prepAbort?.abort()
    this.stop()
    const generation = this.generation
    this.startedAt = req.startedAt
    this.word = req.word
    this.voice = req.voice
    this.clock.setRate(req.rate)
    this.phase = 'buffering'
    this.statusText = 'Starting…'
    this.hooks.onSnapshot()

    startWarmup()
    this.clock.unlock()

    if (!isModelReady()) {
      this.pendingPlay = req
      this.statusText = this.modelWaitLabel()
      this.hooks.onSnapshot()
      const ready = await waitForModelReady()
      if (generation !== this.generation) return
      if (!ready) {
        this.hooks.onError('Kokoro model failed to load. Check your connection and try again.')
        this.stop()
        return
      }
      // If user cancelled while waiting, pendingPlay is cleared.
      if (!this.pendingPlay || generation !== this.generation) return
      this.pendingPlay = null
    }

    await this.beginPlayback(req, generation)
  }

  private async beginPlayback(req: PlayRequest, generation: number) {
    const { lengthScale } = pacingFor('kokoro')
    this.speed = lengthScale > 0 ? 1 / lengthScale : 1
    this.voice = req.voice

    const all = buildStableSegments(req.bookText)
    const startIdx = findSegmentIndexAt(all, req.startOffset)
    if (startIdx < 0) {
      this.hooks.onError('There is no readable text at this position.')
      this.stop()
      return
    }
    this.segments = all.slice(startIdx).map((s, index) => ({ ...s, index }))
    this.cursor = 0

    const playAbort = new AbortController()
    this.playAbort = playAbort

    this.clock.setHandlers({
      onUnitStart: (unit) => {
        if (generation !== this.generation) return
        const seg = this.segments[unit.chunkIndex]
        if (!seg) return
        this.cursor = unit.chunkIndex
        this.phase = 'playing'
        this.statusText = null
        this.hooks.onSegmentStart(seg, 0)
        this.hooks.onSnapshot()
        void this.fill(generation)
      },
      onProgress: (unit, t) => {
        if (generation !== this.generation) return
        const seg = this.segments[unit.chunkIndex]
        if (seg) this.hooks.onProgress(seg, t)
      },
      onUnderrun: () => {
        if (generation !== this.generation) return
        this.phase = 'buffering'
        this.statusText = 'Buffering…'
        this.hooks.onSnapshot()
        void this.fill(generation)
      },
      onEnded: () => {
        if (generation !== this.generation) return
        this.stop()
        this.hooks.onEnded()
      },
    })

    this.clock.setExpectMore(true)
    this.statusText = 'Synthesizing…'
    this.hooks.onSnapshot()
    await this.fill(generation)
  }

  /** Keep the clock fed to WATERMARK_SEC. */
  private async fill(generation: number) {
    if (generation !== this.generation || this.producing) return
    this.producing = true
    const signal = this.playAbort?.signal
    if (!signal) {
      this.producing = false
      return
    }

    try {
      while (generation === this.generation && !signal.aborted) {
        const ahead = this.clock.bufferedAheadSeconds()
        const next = this.nextUnscheduledIndex()
        if (next < 0) {
          this.clock.setExpectMore(false)
          break
        }
        if (ahead >= WATERMARK_SEC && this.clock.scheduledCount > 0) break

        const segment = this.segments[next]!
        const ok = await this.scheduleSegment(segment, next, generation, signal)
        if (generation !== this.generation || signal.aborted) return
        if (!ok) {
          this.hooks.onError('Kokoro could not synthesize this passage.')
          this.stop()
          return
        }
        if (this.clock.bufferedAheadSeconds() >= WATERMARK_SEC) break
      }
    } finally {
      this.producing = false
    }
  }

  private nextUnscheduledIndex() {
    for (let i = 0; i < this.segments.length; i += 1) {
      if (!this.scheduledKeys.has(this.segments[i]!.id)) return i
    }
    return -1
  }

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

    // ── Instant path: memory / IDB ─────────────────────────────────────
    const cached = getMemorySegment(key) ?? await getStoredSegment(key, ctx).catch(() => null)
    if (signal.aborted || generation !== this.generation) return false
    if (cached) {
      this.scheduledKeys.add(segment.id)
      this.lastCacheHit = true
      this.clock.setExpectMore(index < this.segments.length - 1)
      this.clock.append(cached.buffer, { chunkIndex: index })
      this.markFirstAudio(segment, true, cached.cacheStorage)
      return true
    }

    // Cold path: stream the full segment. First PCM frame starts audio;
    // completed WAV is written so the next tap is a memory/IDB hit.
    this.scheduledKeys.add(segment.id)
    return this.streamText(segment.text, segment, index, key, generation, signal, true)
  }

  private streamText(
    text: string,
    segment: StableSegment,
    index: number,
    cacheKey: string,
    generation: number,
    signal: AbortSignal,
    persist: boolean,
  ): Promise<boolean> {
    if (!this.voice) return Promise.resolve(false)
    const voice = this.voice
    const speed = this.speed
    const ctx = this.clock.ensureContext()

    return new Promise((resolve) => {
      let settled = false
      const frames: AudioBuffer[] = []
      let streamed = false
      let cancel: (() => void) | null = null

      const finish = (ok: boolean) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        notePlaybackFetchEnd()
        resolve(ok)
      }
      const onAbort = () => {
        try { cancel?.() } catch { /* */ }
        finish(streamed)
      }
      signal.addEventListener('abort', onAbort, { once: true })

      this.clock.setExpectMore(true)
      notePlaybackFetchStart()
      this.statusText = this.firstAudioSent ? 'Buffering…' : 'Synthesizing…'
      this.hooks.onSnapshot()

      const handle = synthesizeLocalStreaming(text, voice, speed, {
        onChunk: (pcm, sampleRate) => {
          if (settled || signal.aborted || generation !== this.generation || pcm.length === 0) return
          try {
            const buffer = pcmToAudioBuffer(ctx, pcm, sampleRate)
            frames.push(buffer)
            this.clock.append(buffer, { chunkIndex: index })
            streamed = true
            this.lastCacheHit = false
            this.markFirstAudio(segment, false, 'generated')
          } catch {
            // skip frame
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
              if (frames.length === 1) buffer = frames[0]!
              else if (frames.length > 1) buffer = concatBuffers(ctx, frames)
              else if (result.wav.byteLength > 0) {
                buffer = await decodeAudioDataSafe(ctx, result.wav)
                if (!streamed) {
                  this.clock.append(buffer, { chunkIndex: index })
                  streamed = true
                  this.markFirstAudio(segment, false, 'generated')
                }
              }
              if (persist && buffer && result.wav.byteLength > 0) {
                const durationSec = result.durationSec || buffer.duration
                putMemorySegment(cacheKey, segment.id, buffer, durationSec)
                void putStoredSegment({
                  key: cacheKey,
                  segmentId: segment.id,
                  buffer,
                  wav: result.wav,
                  durationSec,
                })
              } else if (persist && buffer) {
                putMemorySegment(cacheKey, segment.id, buffer, buffer.duration)
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
        finish(false)
        return
      }
      cancel = handle.cancel
    })
  }

  private async synthFullToCache(
    segment: StableSegment,
    voice: string,
    speed: number,
    ctx: AudioContext,
    signal: AbortSignal,
  ) {
    const key = await segmentCacheKey(voice, speed, segment)
    if (signal.aborted) return
    await new Promise<void>((resolve) => {
      let settled = false
      const frames: AudioBuffer[] = []
      let cancel: (() => void) | null = null
      const done = () => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        notePlaybackFetchEnd()
        resolve()
      }
      const onAbort = () => {
        try { cancel?.() } catch { /* */ }
        done()
      }
      signal.addEventListener('abort', onAbort, { once: true })
      notePlaybackFetchStart()
      const handle = synthesizeLocalStreaming(segment.text, voice, speed, {
        onChunk: (pcm, sr) => {
          if (settled || signal.aborted || pcm.length === 0) return
          try { frames.push(pcmToAudioBuffer(ctx, pcm, sr)) } catch { /* */ }
        },
        onComplete: (result) => {
          if (settled || signal.aborted) {
            done()
            return
          }
          void (async () => {
            try {
              let buffer: AudioBuffer
              if (frames.length === 1) buffer = frames[0]!
              else if (frames.length > 1) buffer = concatBuffers(ctx, frames)
              else if (result.wav.byteLength > 0) buffer = await decodeAudioDataSafe(ctx, result.wav)
              else {
                done()
                return
              }
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
            } finally {
              done()
            }
          })()
        },
        onError: () => done(),
      })
      if (!handle) done()
      else cancel = handle.cancel
    })
  }

  private markFirstAudio(
    segment: StableSegment,
    cacheHit: boolean,
    cacheStorage: string,
  ) {
    if (this.phase === 'buffering') {
      this.phase = 'playing'
      this.statusText = null
      this.hooks.onSnapshot()
    }
    if (this.firstAudioSent) return
    this.firstAudioSent = true
    this.phase = 'playing'
    this.statusText = null
    this.hooks.onFirstAudio({
      durationMs: Math.max(0, performance.now() - this.startedAt),
      cacheHit,
      cacheStorage,
      segmentChars: segment.text.length,
    })
    this.hooks.onSnapshot()
  }

  private modelWaitLabel() {
    const m = getModelStatus()
    if (m.status === 'downloading') return `Downloading voice… ${Math.round(m.progress)}%`
    if (m.status === 'warming') return 'Compiling voice…'
    return 'Loading voice…'
  }

  private deriveStatusText(status: string, progress: number) {
    if (this.phase !== 'buffering') return null
    if (status === 'downloading') return `Downloading voice… ${Math.round(progress)}%`
    if (status === 'warming') return 'Compiling voice…'
    return this.statusText
  }
}

function concatBuffers(ctx: AudioContext, buffers: AudioBuffer[]): AudioBuffer {
  if (buffers.length === 1) return buffers[0]!
  const rate = buffers[0]!.sampleRate
  let total = 0
  for (const b of buffers) total += b.length
  const out = ctx.createBuffer(1, Math.max(1, total), rate)
  const ch = out.getChannelData(0)
  let offset = 0
  for (const b of buffers) {
    ch.set(b.getChannelData(0), offset)
    offset += b.length
  }
  return out
}
