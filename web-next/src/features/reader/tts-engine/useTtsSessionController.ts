import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import {
  isModelReady,
  startWarmup,
} from '@/shared/storage/modelCache'
import {
  elapsedMs,
  performanceNow,
  queuePerformanceTelemetry,
} from '@/shared/telemetry/performanceTelemetry'
import {
  BROWSER_TTS_PROVIDER_ID,
  DEFAULT_PREFETCH_AHEAD,
  PREFETCH_AHEAD_TARGET,
  pacingFor,
} from '../audioPlayback'
import {
  audioErrorMessage,
  liveAudioCooldownRemainingMs,
  loadLiveAudioBlob,
  requestLiveAudio,
  type LiveAudioPayload,
} from './liveAudio'
import { BrowserSpeechLane } from './browserSpeechLane'
import { ClockedAudioSink } from './clockedAudioSink'
import { TtsNativeQueue } from './nativeQueue'
import { buildTtsChunks } from './segmenter'
import { FirstAudioGate } from './sessionTelemetry'
import { synthesizeKokoroLocal } from './kokoroAudio'
import type {
  NativeAudioResult,
  TtsAudioChunk,
  TtsGridChunk,
  TtsPhase,
  TtsSnapshot,
} from './types'

export type { TtsAudioChunk, TtsCue, TtsPhase } from './types'

export interface UseTtsSessionControllerParams {
  bookId?: string
  bookText: string
  provider: string
  voice: string | null
  rate: number
  presynthGridRef: MutableRefObject<Array<TtsGridChunk> | null>
  syncAudioFollowCue: (chunk: TtsAudioChunk, currentTime: number, follow: boolean) => void
  clearAudioFollow: () => void
  showToast: (message: string) => void
}

export interface TtsSessionController {
  wordAudioPhase: TtsPhase
  wordAudioCurIdx: number
  wordAudioTotal: number
  playWord: (word: string, startOffset: number, reason?: 'voice-switch') => Promise<void>
  toggleWordAudio: () => void
  stopWordAudio: () => void
  isAudioActive: () => boolean
}

type StartNativeAt = (
  index: number,
  ctrl: AbortController,
  startedAt: number,
  sessionId: number,
  reason?: 'voice-switch',
) => boolean

type SpeakFallbackAt = (
  index: number,
  ctrl: AbortController,
  startedAt: number,
  sessionId: number,
  reason?: 'voice-switch',
) => boolean

const EMPTY_SNAPSHOT: TtsSnapshot = {
  phase: 'idle',
  lane: 'none',
  currentIndex: 0,
  totalChunks: 0,
  word: null,
  provider: BROWSER_TTS_PROVIDER_ID,
  nativeReadyChunks: 0,
  bufferedSeconds: 0,
  error: null,
}

async function decodeBlob(ctx: AudioContext, blob: Blob) {
  return ctx.decodeAudioData(await blob.arrayBuffer())
}

export function useTtsSessionController({
  bookId,
  bookText,
  provider,
  voice,
  rate,
  presynthGridRef,
  syncAudioFollowCue,
  clearAudioFollow,
  showToast,
}: UseTtsSessionControllerParams): TtsSessionController {
  const [snapshot, setSnapshot] = useState<TtsSnapshot>({ ...EMPTY_SNAPSHOT, provider })
  const sessionIdRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  const queueRef = useRef<TtsNativeQueue | null>(null)
  const chunksRef = useRef<TtsAudioChunk[]>([])
  const currentIndexRef = useRef(0)
  const currentWordRef = useRef<string | null>(null)
  const phaseRef = useRef<TtsPhase>('idle')
  const laneRef = useRef<TtsSnapshot['lane']>('none')
  const fallbackLaneRef = useRef(new BrowserSpeechLane())
  const nativeSinkRef = useRef(new ClockedAudioSink())
  const firstAudioGateRef = useRef(new FirstAudioGate())
  const objectUrlsRef = useRef(new Set<string>())
  const rateRef = useRef(rate)
  const providerRef = useRef(provider)
  const voiceRef = useRef(voice)
  const syncAudioFollowCueRef = useRef(syncAudioFollowCue)
  const clearAudioFollowRef = useRef(clearAudioFollow)
  const showToastRef = useRef(showToast)
  const nativeReadyReportedRef = useRef(false)
  const startNativeAtRef = useRef<StartNativeAt>(() => false)
  const speakFallbackAtRef = useRef<SpeakFallbackAt>(() => false)
  rateRef.current = rate
  providerRef.current = provider
  voiceRef.current = voice
  syncAudioFollowCueRef.current = syncAudioFollowCue
  clearAudioFollowRef.current = clearAudioFollow
  showToastRef.current = showToast

  const emitSnapshot = useCallback((patch: Partial<TtsSnapshot> = {}) => {
    const queue = queueRef.current
    const ready = queue?.readyRunFrom(currentIndexRef.current) ?? { count: 0, seconds: 0 }
    const next: TtsSnapshot = {
      phase: phaseRef.current,
      lane: laneRef.current,
      currentIndex: currentIndexRef.current,
      totalChunks: chunksRef.current.length,
      word: currentWordRef.current,
      provider: providerRef.current,
      nativeReadyChunks: ready.count,
      bufferedSeconds: ready.seconds,
      error: null,
      ...patch,
    }
    setSnapshot(next)
  }, [])

  const revokeObjectUrls = useCallback(() => {
    for (const url of objectUrlsRef.current) URL.revokeObjectURL(url)
    objectUrlsRef.current.clear()
  }, [])

  const stopWordAudio = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    sessionIdRef.current += 1
    fallbackLaneRef.current.stop()
    nativeSinkRef.current.stop()
    queueRef.current?.resetInflight()
    queueRef.current = null
    chunksRef.current = []
    currentIndexRef.current = 0
    currentWordRef.current = null
    phaseRef.current = 'idle'
    laneRef.current = 'none'
    nativeReadyReportedRef.current = false
    firstAudioGateRef.current.reset()
    revokeObjectUrls()
    clearAudioFollowRef.current()
    emitSnapshot({ error: null })
  }, [emitSnapshot, revokeObjectUrls])

  const markFirstAudio = useCallback((
    startedAt: number,
    sessionId: number,
    lane: 'fallback' | 'native',
    chunk: TtsAudioChunk,
    reason?: 'voice-switch',
  ) => {
    if (!firstAudioGateRef.current.shouldReport(sessionId, sessionIdRef.current)) return
    queuePerformanceTelemetry({
      eventName: 'tts.first_audio_v2',
      bookId,
      provider: providerRef.current,
      durationMs: elapsedMs(startedAt),
      cacheHit: chunk.cacheHit,
      cacheStorage: chunk.cacheStorage,
      metadata: {
        lane,
        reason: reason ?? 'tap',
        chunkIndex: chunk.index,
        chunkChars: chunk.text.length,
      },
    })
  }, [bookId])

  const markNativeHandoff = useCallback((
    startedAt: number,
    sessionId: number,
    chunk: TtsAudioChunk,
    reason?: 'voice-switch',
  ) => {
    if (sessionId !== sessionIdRef.current) return
    const ready = queueRef.current?.readyRunFrom(chunk.index) ?? { count: 0, seconds: 0 }
    queuePerformanceTelemetry({
      eventName: 'tts.native_handoff_v2',
      bookId,
      provider: providerRef.current,
      durationMs: elapsedMs(startedAt),
      cacheHit: chunk.cacheHit,
      cacheStorage: chunk.cacheStorage,
      metadata: {
        reason: reason ?? 'tap',
        chunkIndex: chunk.index,
        chunkChars: chunk.text.length,
        readyChunks: ready.count,
        bufferedSeconds: Math.round(ready.seconds * 10) / 10,
      },
    })
  }, [bookId])

  const fetchNativeChunk = useCallback(async (
    chunk: TtsAudioChunk,
    signal: AbortSignal,
    background: boolean,
  ): Promise<NativeAudioResult | null> => {
    const selectedProvider = providerRef.current
    const selectedVoice = voiceRef.current
    const ctx = nativeSinkRef.current.ensureContext()

    if (selectedProvider === 'kokoro') {
      if (!selectedVoice || !isModelReady()) return null
      const { lengthScale } = pacingFor('kokoro')
      const speed = lengthScale > 0 ? 1 / lengthScale : 1
      const synthesized = await synthesizeKokoroLocal(chunk.text, selectedVoice, speed, signal)
      if (!synthesized || signal.aborted) return null

      const buffer = await decodeBlob(ctx, synthesized.blob)
      return {
        url: null,
        buffer,
        cues: [],
        durationSec: synthesized.duration ?? buffer.duration,
        cacheHit: synthesized.cacheHit,
        cacheStorage: synthesized.cacheHit ? 'indexeddb' : 'generated',
      }
    }

    if (!bookId || selectedProvider === BROWSER_TTS_PROVIDER_ID) return null

    const cooldownMs = liveAudioCooldownRemainingMs(selectedProvider)
    if (cooldownMs > 0) {
      queuePerformanceTelemetry({
        eventName: 'tts.live_audio_backoff_v2',
        bookId,
        provider: selectedProvider,
        value: Math.ceil(cooldownMs / 1000),
        metadata: {
          chunkIndex: chunk.index,
          chunkChars: chunk.text.length,
          background,
        },
      })
      return null
    }

    const { lengthScale, sentenceSilence } = pacingFor(selectedProvider)
    const payload: LiveAudioPayload = {
      provider: selectedProvider,
      voice: selectedVoice,
      model: null,
      output_format: 'mp3',
      narration_style: '',
      length_scale: lengthScale,
      sentence_silence: sentenceSilence,
      pageNumber: 1,
      start: chunk.start,
      end: chunk.end,
      text: chunk.text,
    }
    const fetchStartedAt = performanceNow()
    let liveAudio
    try {
      liveAudio = await requestLiveAudio(bookId, payload)
    } catch (error) {
      queuePerformanceTelemetry({
        eventName: 'tts.live_audio_error_v2',
        bookId,
        provider: selectedProvider,
        durationMs: elapsedMs(fetchStartedAt),
        metadata: {
          chunkIndex: chunk.index,
          chunkChars: chunk.text.length,
          background,
          rateLimited: liveAudioCooldownRemainingMs(selectedProvider) > 0,
        },
      })
      throw error
    }
    if (signal.aborted) return null

    queuePerformanceTelemetry({
      eventName: 'tts.live_audio_fetch_v2',
      bookId,
      provider: selectedProvider,
      durationMs: elapsedMs(fetchStartedAt),
      cacheHit: liveAudio.cacheHit,
      cacheStorage: liveAudio.cacheStorage,
      metadata: {
        chunkIndex: chunk.index,
        chunkChars: chunk.text.length,
        background,
      },
    })

    const { blob, cues } = await loadLiveAudioBlob(liveAudio, signal)
    if (signal.aborted) return null
    const buffer = await decodeBlob(ctx, blob)
    const url = URL.createObjectURL(blob)
    objectUrlsRef.current.add(url)
    return {
      url,
      buffer,
      cues,
      durationSec: liveAudio.duration ?? buffer.duration,
      cacheHit: liveAudio.cacheHit,
      cacheStorage: liveAudio.cacheStorage,
    }
  }, [bookId])

  const startNativeAt = useCallback((
    index: number,
    ctrl: AbortController,
    startedAt: number,
    sessionId: number,
    reason?: 'voice-switch',
  ) => {
    const queue = queueRef.current
    const chunk = queue?.allChunks[index]
    if (!queue || !chunk?.buffer || ctrl.signal.aborted || sessionId !== sessionIdRef.current) return false

    const previousLane = laneRef.current
    fallbackLaneRef.current.stop()
    laneRef.current = 'native'
    phaseRef.current = 'playing'
    const scheduledCount = nativeSinkRef.current.playReadyRun({
      chunks: queue.allChunks,
      startIndex: index,
      rate: rateRef.current,
      tapOffset: index === 0 ? chunk.start : null,
      signal: ctrl.signal,
      onChunkStart: (startedChunk, startedIndex) => {
        currentIndexRef.current = startedIndex
        queue.prefetchFrom(startedIndex + 1, PREFETCH_AHEAD_TARGET[providerRef.current] ?? DEFAULT_PREFETCH_AHEAD, ctrl.signal)
        if (startedIndex === index) {
          if (previousLane === 'fallback') {
            markNativeHandoff(startedAt, sessionId, startedChunk, reason)
          }
          markFirstAudio(startedAt, sessionId, 'native', startedChunk, reason)
        }
        emitSnapshot()
      },
      onProgress: (activeChunk, currentTime, follow) => {
        syncAudioFollowCueRef.current(activeChunk, currentTime, follow)
      },
      onRunDrained: (nextIndex) => {
        if (ctrl.signal.aborted || sessionId !== sessionIdRef.current) return
        if (nextIndex >= chunksRef.current.length) {
          stopWordAudio()
          return
        }
        const nextChunk = queue.allChunks[nextIndex]
        if (nextChunk?.buffer) {
          startNativeAtRef.current(nextIndex, ctrl, startedAt, sessionId, reason)
          return
        }

        queue.prefetchFrom(nextIndex, PREFETCH_AHEAD_TARGET[providerRef.current] ?? DEFAULT_PREFETCH_AHEAD, ctrl.signal)
        if (fallbackLaneRef.current.canSpeak()) {
          queuePerformanceTelemetry({
            eventName: 'tts.native_underrun_bridge_v2',
            bookId,
            provider: providerRef.current,
            metadata: {
              chunkIndex: nextIndex,
              chunkStatus: nextChunk?.status ?? 'missing',
            },
          })
          void speakFallbackAtRef.current(nextIndex, ctrl, startedAt, sessionId, reason)
          return
        }
        phaseRef.current = 'buffering'
        emitSnapshot()
        void queue.ensure(nextIndex, ctrl.signal, false).then((result) => {
          if (ctrl.signal.aborted || sessionId !== sessionIdRef.current || !result?.buffer) return
          startNativeAtRef.current(nextIndex, ctrl, startedAt, sessionId, reason)
        })
      },
    })
    return scheduledCount > 0
  }, [bookId, emitSnapshot, markFirstAudio, markNativeHandoff, stopWordAudio])

  const speakFallbackAt = useCallback((
    index: number,
    ctrl: AbortController,
    startedAt: number,
    sessionId: number,
    reason?: 'voice-switch',
  ): boolean => {
    const chunk = chunksRef.current[index]
    const queue = queueRef.current
    if (!chunk || ctrl.signal.aborted || sessionId !== sessionIdRef.current) return false

    laneRef.current = 'fallback'
    phaseRef.current = 'playing'
    currentIndexRef.current = index
    queue?.prefetchFrom(index, PREFETCH_AHEAD_TARGET[providerRef.current] ?? DEFAULT_PREFETCH_AHEAD, ctrl.signal)
    syncAudioFollowCueRef.current(chunk, 0, true)
    emitSnapshot()

    return fallbackLaneRef.current.speakChunk({
      chunk: { index, text: chunk.text },
      rate: rateRef.current,
      signal: ctrl.signal,
      onStart: () => {
        markFirstAudio(startedAt, sessionId, 'fallback', chunk, reason)
        phaseRef.current = 'playing'
        laneRef.current = 'fallback'
        emitSnapshot()
      },
      onEnd: () => {
        if (ctrl.signal.aborted || sessionId !== sessionIdRef.current) return
        const nextIndex = index + 1
        if (nextIndex >= chunksRef.current.length) {
          stopWordAudio()
          return
        }
        if (queue?.shouldStartNativeFrom(nextIndex)) {
          if (startNativeAtRef.current(nextIndex, ctrl, startedAt, sessionId, reason)) return
        }
        void speakFallbackAtRef.current(nextIndex, ctrl, startedAt, sessionId, reason)
      },
      onError: () => {
        if (ctrl.signal.aborted || sessionId !== sessionIdRef.current) return
        showToastRef.current('Browser speech stopped. Tap a word to start again.')
        stopWordAudio()
      },
    })
  }, [emitSnapshot, markFirstAudio, stopWordAudio])

  startNativeAtRef.current = startNativeAt
  speakFallbackAtRef.current = speakFallbackAt

  const playWord = useCallback(async (
    word: string,
    startOffset: number,
    reason?: 'voice-switch',
  ) => {
    stopWordAudio()
    const startedAt = performanceNow()
    const sessionId = sessionIdRef.current + 1
    sessionIdRef.current = sessionId
    const ctrl = new AbortController()
    abortRef.current = ctrl
    currentWordRef.current = word
    currentIndexRef.current = 0
    nativeReadyReportedRef.current = false
    firstAudioGateRef.current.reset()
    phaseRef.current = 'buffering'
    laneRef.current = 'none'

    if (providerRef.current === 'kokoro') startWarmup()

    const chunks = buildTtsChunks({
      bookText,
      startOffset,
      provider: providerRef.current,
      presynthGrid: presynthGridRef.current,
      kokoroModelReady: isModelReady(),
    })
    if (!chunks.length) {
      showToastRef.current('There is no readable text at this position.')
      stopWordAudio()
      return
    }

    chunksRef.current = chunks
    const queue = new TtsNativeQueue(chunks, fetchNativeChunk)
    queueRef.current = queue
    const unsubscribe = queue.subscribe(() => {
      if (sessionId !== sessionIdRef.current) return
      const nextIndex = currentIndexRef.current
      emitSnapshot()
      if (
        laneRef.current === 'fallback' &&
        !nativeReadyReportedRef.current &&
        queue.shouldStartNativeFrom(nextIndex)
      ) {
        nativeReadyReportedRef.current = true
        queuePerformanceTelemetry({
          eventName: 'tts.native_ready_v2',
          bookId,
          provider: providerRef.current,
          metadata: {
            currentIndex: nextIndex,
            readyChunks: queue.readyRunFrom(nextIndex).count,
          },
        })
      }
    })
    ctrl.signal.addEventListener('abort', unsubscribe, { once: true })

    queuePerformanceTelemetry({
      eventName: 'tts.play_start_v2',
      bookId,
      provider: providerRef.current,
      metadata: {
        reason: reason ?? 'tap',
        startOffset,
        selectedChars: word.length,
        chunkCount: chunks.length,
        browserFallback: fallbackLaneRef.current.canSpeak(),
        kokoroModelReady: isModelReady(),
      },
    })
    emitSnapshot()

    if (providerRef.current !== BROWSER_TTS_PROVIDER_ID) {
      queue.prefetchFrom(0, PREFETCH_AHEAD_TARGET[providerRef.current] ?? DEFAULT_PREFETCH_AHEAD, ctrl.signal)
    }

    if (fallbackLaneRef.current.canSpeak()) {
      const started = speakFallbackAt(0, ctrl, startedAt, sessionId, reason)
      if (started) return
    }

    if (providerRef.current === BROWSER_TTS_PROVIDER_ID) {
      showToastRef.current('Browser speech is not supported by this browser.')
      stopWordAudio()
      return
    }

    try {
      const first = await queue.ensure(0, ctrl.signal, false)
      if (ctrl.signal.aborted || sessionId !== sessionIdRef.current) return
      if (!first?.buffer) throw new Error('Audio provider did not return playable audio.')
      startNativeAt(0, ctrl, startedAt, sessionId, reason)
    } catch (error) {
      if (!ctrl.signal.aborted) {
        showToastRef.current(audioErrorMessage(error))
        stopWordAudio()
      }
    }
  }, [bookId, bookText, emitSnapshot, fetchNativeChunk, presynthGridRef, speakFallbackAt, startNativeAt, stopWordAudio])

  const toggleWordAudio = useCallback(() => {
    if (phaseRef.current === 'buffering') {
      stopWordAudio()
      return
    }
    if (phaseRef.current === 'playing') {
      if (laneRef.current === 'fallback') fallbackLaneRef.current.pause()
      else void nativeSinkRef.current.pause()
      phaseRef.current = 'paused'
      emitSnapshot()
      return
    }
    if (phaseRef.current !== 'paused') return
    if (laneRef.current === 'fallback') fallbackLaneRef.current.resume()
    else void nativeSinkRef.current.resume()
    phaseRef.current = 'playing'
    emitSnapshot()
  }, [emitSnapshot, stopWordAudio])

  const isAudioActive = useCallback(() => (
    phaseRef.current === 'playing' ||
    phaseRef.current === 'buffering' ||
    fallbackLaneRef.current.isActive ||
    nativeSinkRef.current.active
  ), [])

  useEffect(() => {
    if (phaseRef.current !== 'idle' && currentWordRef.current) {
      const currentChunk = chunksRef.current[currentIndexRef.current] ?? chunksRef.current[0]
      if (currentChunk) void playWord(currentWordRef.current, currentChunk.start, 'voice-switch')
    }
  // Provider and voice changes intentionally restart the active session once.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, voice])

  useEffect(() => () => {
    stopWordAudio()
    nativeSinkRef.current.close()
  }, [stopWordAudio])

  useEffect(() => {
    nativeSinkRef.current.setRate(rate)
    const queue = queueRef.current
    if (providerRef.current === BROWSER_TTS_PROVIDER_ID || !queue || !abortRef.current) return
    const currentIndex = currentIndexRef.current
    queue.prefetchFrom(currentIndex + 1, PREFETCH_AHEAD_TARGET[providerRef.current] ?? DEFAULT_PREFETCH_AHEAD, abortRef.current.signal)
  }, [rate])

  return {
    wordAudioPhase: snapshot.phase,
    wordAudioCurIdx: snapshot.currentIndex,
    wordAudioTotal: snapshot.totalChunks,
    playWord,
    toggleWordAudio,
    stopWordAudio,
    isAudioActive,
  }
}
