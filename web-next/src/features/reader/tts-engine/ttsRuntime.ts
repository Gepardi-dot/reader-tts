import { isModelReady } from '@/shared/storage/modelCache'
import {
  elapsedMs,
  performanceNow,
  queuePerformanceTelemetry,
} from '@/shared/telemetry/performanceTelemetry'
import {
  BROWSER_TTS_PROVIDER_ID,
  DEFAULT_PREFETCH_AHEAD,
  PREFETCH_AHEAD_TARGET,
  audioSelectionKey,
} from '../audioPlayback'
import { AudioClock } from './audioClock'
import { BufferPool } from './bufferPool'
import { BrowserSpeechLane } from './browserSpeechLane'
import { createChunkLoader } from './chunkLoader'
import { KokoroEngine, PREHEAT_SEGMENTS } from './kokoroEngine'
import { audioErrorMessage } from './liveAudio'
import { warmLiveAudioFromOffset } from './liveAudioWarm'
import { buildTtsChunks } from './segmenter'
import { FirstAudioGate } from './sessionTelemetry'
import type {
  TtsAudioChunk,
  TtsGridChunk,
  TtsPhase,
  TtsPlaybackLane,
  TtsSnapshot,
} from './types'

export interface TtsRuntimeStartParams {
  word: string
  startOffset: number
  bookText: string
  bookId?: string
  provider: string
  voice: string | null
  rate: number
  presynthGrid: readonly TtsGridChunk[] | null
  reason?: 'voice-switch' | 'tap'
}

export interface TtsRuntimeHooks {
  syncAudioFollowCue: (chunk: TtsAudioChunk, currentTime: number, follow: boolean) => void
  clearAudioFollow: () => void
  showToast: (message: string) => void
}

/**
 * Imperative TTS runtime. React only observes snapshots and forwards commands.
 *
 * Kokoro: stable segments + SegmentCache + continuous KokoroEngine.
 * Gemini: BufferPool + live-audio chunks.
 * Browser speech: selected-provider path only (never masks native).
 */
export class TtsRuntime {
  private generation = 0
  private controller: AbortController | null = null
  private phase: TtsPhase = 'idle'
  private lane: TtsPlaybackLane = 'none'
  private currentIndex = 0
  private word: string | null = null
  private provider = BROWSER_TTS_PROVIDER_ID
  private voice: string | null = null
  private rate = 1
  private error: string | null = null
  private chunks: TtsAudioChunk[] = []
  private pool: BufferPool | null = null
  private bookId: string | undefined
  private readonly clock = new AudioClock()
  private readonly kokoro = new KokoroEngine()
  private readonly browser = new BrowserSpeechLane()
  private readonly firstAudio = new FirstAudioGate()
  private readonly objectUrls = new Set<string>()
  private readonly listeners = new Set<() => void>()
  private readonly scheduledBuffers = new WeakSet<AudioBuffer>()
  private startedAt = 0
  private sessionId = 0
  private reason: 'voice-switch' | 'tap' = 'tap'
  private loadingChunkIndexes = new Set<number>()
  private usingKokoroEngine = false
  private kokoroSegmentStarts: number[] = []
  private hooks: TtsRuntimeHooks = {
    syncAudioFollowCue: () => undefined,
    clearAudioFollow: () => undefined,
    showToast: () => undefined,
  }

  setHooks(hooks: Partial<TtsRuntimeHooks>) {
    this.hooks = { ...this.hooks, ...hooks }
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot(): TtsSnapshot {
    if (this.usingKokoroEngine) {
      const k = this.kokoro.getSnapshot()
      return {
        phase: k.phase,
        lane: k.phase === 'idle' ? 'none' : 'native',
        currentIndex: k.currentIndex,
        totalChunks: k.totalSegments,
        word: k.word,
        provider: this.provider,
        nativeReadyChunks: k.totalSegments > 0 ? 1 : 0,
        bufferedSeconds: k.bufferedSeconds,
        error: k.error,
        statusText: k.statusText,
      }
    }
    const ready = this.pool?.readyRunFrom(this.currentIndex) ?? { count: 0, seconds: 0 }
    return {
      phase: this.phase,
      lane: this.lane,
      currentIndex: this.currentIndex,
      totalChunks: this.chunks.length,
      word: this.word,
      provider: this.provider,
      nativeReadyChunks: ready.count,
      bufferedSeconds: ready.seconds + this.clock.bufferedAheadSeconds(),
      error: this.error,
      statusText: null,
    }
  }

  isAudibleOrLoading() {
    if (this.usingKokoroEngine) return this.kokoro.isActive()
    return this.phase === 'playing' || this.phase === 'buffering' || this.clock.isActive || this.browser.isActive
  }

  /** Absolute book offset for a chunk index — used for voice-switch restart. */
  chunkStart(index: number): number | null {
    if (this.usingKokoroEngine) {
      return this.kokoroSegmentStarts[index]
        ?? this.kokoroSegmentStarts[0]
        ?? null
    }
    const chunk = this.chunks[index] ?? this.chunks[0]
    return chunk ? chunk.start : null
  }

  setRate(rate: number) {
    this.rate = rate
    this.clock.setRate(rate)
    this.kokoro.setRate(rate)
  }

  /** Preheat SegmentCache around the reading position (legacy on-device path). */
  prepareKokoroWindow(input: {
    bookText: string
    offset: number
    voice: string
    maxSegments?: number
    signal?: AbortSignal
  }) {
    return this.kokoro.preheat({
      bookText: input.bookText,
      offset: input.offset,
      voice: input.voice,
      maxSegments: input.maxSegments ?? PREHEAT_SEGMENTS,
    })
  }

  /**
   * Speculative warm for hosted Kokoro/Gemini: fetch first chunk(s) into the
   * live-audio memory cache so Play is often a cache hit.
   */
  warmCloudAtOffset(input: {
    bookId?: string
    bookText: string
    startOffset: number
    provider: string
    voice: string | null
    signal?: AbortSignal
  }) {
    if (!input.bookId) return Promise.resolve()
    if (input.provider !== 'kokoro' && input.provider !== 'google') return Promise.resolve()
    return warmLiveAudioFromOffset({
      bookId: input.bookId,
      bookText: input.bookText,
      startOffset: input.startOffset,
      provider: input.provider,
      voice: input.voice,
      chunkCount: input.provider === 'kokoro' ? 2 : 1,
      signal: input.signal,
    })
  }

  stop() {
    this.generation += 1
    this.controller?.abort()
    this.controller = null
    this.browser.stop()
    this.clock.stop()
    this.kokoro.stop()
    this.usingKokoroEngine = false
    this.kokoroSegmentStarts = []
    this.pool?.reset()
    this.pool = null
    this.chunks = []
    this.loadingChunkIndexes.clear()
    this.firstAudio.reset()
    this.revokeObjectUrls()
    this.hooks.clearAudioFollow()
    this.phase = 'idle'
    this.lane = 'none'
    this.currentIndex = 0
    this.word = null
    this.error = null
    this.emit()
  }

  dispose() {
    this.stop()
    this.clock.close()
    this.kokoro.dispose()
  }

  pause() {
    if (this.usingKokoroEngine) {
      this.kokoro.pause()
      this.emit()
      return
    }
    if (this.phase === 'buffering') {
      this.stop()
      return
    }
    if (this.phase !== 'playing') return
    if (this.lane === 'fallback') this.browser.pause()
    else void this.clock.pause()
    this.phase = 'paused'
    this.emit()
  }

  resume() {
    if (this.usingKokoroEngine) {
      this.kokoro.resume()
      this.emit()
      return
    }
    if (this.phase !== 'paused') return
    if (this.lane === 'fallback') this.browser.resume()
    else void this.clock.resume()
    this.phase = 'playing'
    this.emit()
  }

  toggle() {
    if (this.usingKokoroEngine) {
      this.kokoro.toggle()
      this.emit()
      return
    }
    if (this.phase === 'buffering') this.stop()
    else if (this.phase === 'playing') this.pause()
    else if (this.phase === 'paused') this.resume()
  }

  async start(params: TtsRuntimeStartParams) {
    this.stop()
    const generation = this.generation
    const sessionId = generation
    this.sessionId = sessionId
    this.startedAt = performanceNow()
    this.reason = params.reason === 'voice-switch' ? 'voice-switch' : 'tap'
    this.provider = params.provider
    this.voice = params.voice
    this.rate = params.rate
    this.bookId = params.bookId
    this.word = params.word
    this.phase = 'buffering'
    this.lane = 'none'
    this.currentIndex = 0
    this.error = null
    this.firstAudio.reset()
    this.clock.setRate(params.rate)

    const controller = new AbortController()
    this.controller = controller
    const selectionKey = audioSelectionKey(params.provider, params.voice)

    // Hosted Kokoro + Gemini use the same BufferPool → live-audio path.
    if (params.provider === 'kokoro' && !params.voice) {
      this.hooks.showToast('Select a Kokoro voice before playing.')
      this.stop()
      return
    }

    const chunks = buildTtsChunks({
      bookText: params.bookText,
      startOffset: params.startOffset,
      provider: params.provider,
      presynthGrid: params.presynthGrid,
      kokoroModelReady: true,
    })

    if (generation !== this.generation) return
    if (!chunks.length) {
      this.hooks.showToast('There is no readable text at this position.')
      this.stop()
      return
    }

    this.chunks = chunks
    this.emit()

    queuePerformanceTelemetry({
      eventName: 'tts.play_start_v2',
      bookId: params.bookId,
      provider: params.provider,
      metadata: {
        reason: this.reason,
        startOffset: params.startOffset,
        selectedChars: params.word.length,
        chunkCount: chunks.length,
        browserFallback: params.provider === BROWSER_TTS_PROVIDER_ID && this.browser.canSpeak(),
        kokoroModelReady: isModelReady(),
        engine: params.provider === 'kokoro' ? 'kokoro-hosted' : 'v3',
      },
    })

    // Selected browser speech path only — never masks Kokoro/Gemini.
    if (params.provider === BROWSER_TTS_PROVIDER_ID) {
      if (!this.browser.canSpeak()) {
        this.hooks.showToast('Browser speech is not supported by this browser.')
        this.stop()
        return
      }
      this.speakBrowserAt(0, generation, controller.signal)
      return
    }

    const loader = createChunkLoader({
      bookId: params.bookId,
      getProvider: () => this.provider,
      getVoice: () => this.voice,
      getSelectionKey: () => selectionKey,
      ensureAudioContext: () => this.clock.ensureContext(),
      trackObjectUrl: (url) => this.objectUrls.add(url),
    })

    const pool = new BufferPool(chunks, loader)
    this.pool = pool

    this.clock.setHandlers({
      onUnitStart: (unit) => {
        if (generation !== this.generation) return
        this.currentIndex = unit.chunkIndex
        this.phase = 'playing'
        this.lane = 'native'
        const chunk = this.chunks[unit.chunkIndex]
        if (chunk) {
          this.markFirstAudio(chunk)
          this.hooks.syncAudioFollowCue(chunk, 0, true)
        }
        const ahead = PREFETCH_AHEAD_TARGET[this.provider] ?? DEFAULT_PREFETCH_AHEAD
        void pool.prefetchFrom(unit.chunkIndex + 1, ahead, controller.signal)
        this.emit()
      },
      onProgress: (unit, currentTime) => {
        if (generation !== this.generation) return
        const chunk = this.chunks[unit.chunkIndex]
        if (chunk) this.hooks.syncAudioFollowCue(chunk, currentTime, false)
      },
      onUnderrun: (nextChunkIndex) => {
        if (generation !== this.generation) return

        // Stream gap: more frames still arriving for an in-flight chunk.
        if (this.chunks.some((chunk) => chunk.status === 'fetching') || this.loadingChunkIndexes.size > 0) {
          this.phase = 'buffering'
          this.emit()
          return
        }

        if (nextChunkIndex >= this.chunks.length) {
          this.stop()
          return
        }

        // Prefetch may have finished without the consumer noticing — schedule now.
        if (this.scheduleReadyFrom(nextChunkIndex) > 0) {
          this.phase = 'playing'
          this.lane = 'native'
          this.emit()
          return
        }

        this.phase = 'buffering'
        this.emit()
        queuePerformanceTelemetry({
          eventName: 'tts.native_underrun_v3',
          bookId: this.bookId,
          provider: this.provider,
          metadata: {
            nextIndex: nextChunkIndex,
            totalChunks: this.chunks.length,
            reason: this.reason,
          },
        })

        this.loadingChunkIndexes.add(nextChunkIndex)
        void pool.ensure(nextChunkIndex, controller.signal, false)
          .then(() => {
            this.loadingChunkIndexes.delete(nextChunkIndex)
            if (generation !== this.generation) return
            this.scheduleReadyFrom(nextChunkIndex)
            this.refreshExpectMore(nextChunkIndex)
          })
          .catch((error) => {
            this.loadingChunkIndexes.delete(nextChunkIndex)
            if (generation !== this.generation) return
            this.hooks.showToast(audioErrorMessage(error))
            this.stop()
          })
      },
      onEnded: () => {
        if (generation !== this.generation) return
        this.stop()
      },
    })

    // Stream frames to the clock as soon as they arrive (first Kokoro sentence
    // should be audible without waiting for the full first chunk).
    let firstFrameSeen = false
    const unsubFrames = pool.onFrame((chunkIndex, frame) => {
      if (generation !== this.generation || controller.signal.aborted) return
      if (this.scheduledBuffers.has(frame.buffer)) return
      this.scheduledBuffers.add(frame.buffer)
      this.refreshExpectMore(chunkIndex)

      this.clock.append(frame.buffer, {
        chunkIndex,
        seekSeconds: 0,
        cues: frame.cues,
      })
      if (this.phase === 'buffering' || this.phase === 'idle') {
        this.phase = 'playing'
        this.lane = 'native'
        this.emit()
      }

      // Kick follow-up synth after first audible frame so loading isn't a
      // multi-second silent wait for the whole first chunk.
      if (!firstFrameSeen) {
        firstFrameSeen = true
        void pool.prefetchFrom(
          1,
          PREFETCH_AHEAD_TARGET[params.provider] ?? DEFAULT_PREFETCH_AHEAD,
          controller.signal,
        )
      }
    })
    controller.signal.addEventListener('abort', unsubFrames, { once: true })

    pool.subscribe(() => {
      if (generation !== this.generation) return
      this.emit()
    })

    try {
      this.clock.setExpectMore(true)
      this.loadingChunkIndexes.add(0)
      // Kick follow-up fetch immediately (hosted path is sequential; first chunk
      // often already warm from selection speculative fetch).
      void pool.prefetchFrom(
        1,
        PREFETCH_AHEAD_TARGET[params.provider] ?? DEFAULT_PREFETCH_AHEAD,
        controller.signal,
      )
      await pool.ensure(0, controller.signal, false)
      this.loadingChunkIndexes.delete(0)
      if (generation !== this.generation) return

      if (!firstFrameSeen) {
        void pool.prefetchFrom(
          1,
          PREFETCH_AHEAD_TARGET[params.provider] ?? DEFAULT_PREFETCH_AHEAD,
          controller.signal,
        )
      }

      if (this.clock.scheduledCount === 0) {
        throw new Error('Audio provider did not return playable audio.')
      }

      this.refreshExpectMore(0)
    } catch (error) {
      this.loadingChunkIndexes.delete(0)
      if (controller.signal.aborted || generation !== this.generation) return
      this.hooks.showToast(audioErrorMessage(error))
      this.stop()
    }
  }

  private scheduleReadyFrom(startIndex: number): number {
    let scheduled = 0
    for (let index = Math.max(0, startIndex); index < this.chunks.length; index += 1) {
      const chunk = this.chunks[index]
      if (!chunk) break
      if (!chunk.buffer) {
        if (chunk.status === 'fetching' || chunk.status === 'idle') break
        continue
      }
      if (!this.scheduledBuffers.has(chunk.buffer)) {
        this.scheduledBuffers.add(chunk.buffer)
        this.refreshExpectMore(index)
        this.clock.append(chunk.buffer, {
          chunkIndex: index,
          seekSeconds: 0,
          cues: chunk.cues,
        })
        scheduled += 1
      }
      if (chunk.status === 'fetching') break
      if (chunk.status !== 'ready') break
    }
    return scheduled
  }

  private refreshExpectMore(fromChunkIndex: number) {
    const anyLoading = this.loadingChunkIndexes.size > 0
      || this.chunks.some((chunk) => chunk.status === 'fetching')
    const hasLaterChunks = this.chunks.some((chunk, index) => (
      index > fromChunkIndex && chunk.status !== 'ready'
    ))
    const notLastChunk = fromChunkIndex < this.chunks.length - 1
    this.clock.setExpectMore(anyLoading || hasLaterChunks || notLastChunk)
  }

  private speakBrowserAt(index: number, generation: number, signal: AbortSignal) {
    const chunk = this.chunks[index]
    if (!chunk || generation !== this.generation || signal.aborted) return

    this.lane = 'fallback'
    this.currentIndex = index
    this.hooks.syncAudioFollowCue(chunk, 0, true)
    this.emit()

    const started = this.browser.speakChunk({
      chunk: { index, text: chunk.text },
      rate: this.rate,
      signal,
      onStart: () => {
        if (generation !== this.generation) return
        this.phase = 'playing'
        this.lane = 'fallback'
        this.markFirstAudio(chunk)
        this.emit()
      },
      onEnd: () => {
        if (generation !== this.generation) return
        const next = index + 1
        if (next >= this.chunks.length) {
          this.stop()
          return
        }
        this.speakBrowserAt(next, generation, signal)
      },
      onError: () => {
        if (generation !== this.generation) return
        this.hooks.showToast('Browser speech stopped. Tap a word to start again.')
        this.stop()
      },
    })

    if (!started) {
      this.hooks.showToast('Browser speech is not supported by this browser.')
      this.stop()
    }
  }

  private markFirstAudio(chunk: TtsAudioChunk) {
    if (!this.firstAudio.shouldReport(this.sessionId, this.generation)) return
    queuePerformanceTelemetry({
      eventName: 'tts.first_audio_v2',
      bookId: this.bookId,
      provider: this.provider,
      durationMs: elapsedMs(this.startedAt),
      cacheHit: chunk.cacheHit,
      cacheStorage: chunk.cacheStorage,
      metadata: {
        lane: this.lane === 'fallback' ? 'fallback' : 'native',
        reason: this.reason,
        chunkIndex: chunk.index,
        chunkChars: chunk.text.length,
        engine: 'v3',
      },
    })
  }

  private revokeObjectUrls() {
    for (const url of this.objectUrls) URL.revokeObjectURL(url)
    this.objectUrls.clear()
  }

  private emit() {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        // Snapshot subscribers must not break playback.
      }
    }
  }
}

