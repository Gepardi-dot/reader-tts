import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
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
  audioSelectionKey,
  nativePrefetchStartIndexForFallback,
} from '../audioPlayback'
import { audioErrorMessage } from './liveAudio'
import { BrowserSpeechLane } from './browserSpeechLane'
import { ClockedAudioSink } from './clockedAudioSink'
import { createNativeAudioSource } from './nativeAudioSource'
import { TtsNativeQueue } from './nativeQueue'
import { buildTtsChunks } from './segmenter'
import { TtsSessionState } from './sessionState'
import { FirstAudioGate } from './sessionTelemetry'
import type {
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
  const queueRef = useRef<TtsNativeQueue | null>(null)
  const chunksRef = useRef<TtsAudioChunk[]>([])
  const sessionStateRef = useRef(new TtsSessionState())
  const fallbackLaneRef = useRef(new BrowserSpeechLane())
  const nativeSinkRef = useRef(new ClockedAudioSink())
  const firstAudioGateRef = useRef(new FirstAudioGate())
  const objectUrlsRef = useRef(new Set<string>())
  const rateRef = useRef(rate)
  const providerRef = useRef(provider)
  const voiceRef = useRef(voice)
  const selectionKeyRef = useRef(audioSelectionKey(provider, voice))
  const syncAudioFollowCueRef = useRef(syncAudioFollowCue)
  const clearAudioFollowRef = useRef(clearAudioFollow)
  const showToastRef = useRef(showToast)
  const nativeReadyReportedRef = useRef(false)
  const startNativeAtRef = useRef<StartNativeAt>(() => false)
  const speakFallbackAtRef = useRef<SpeakFallbackAt>(() => false)
  rateRef.current = rate
  providerRef.current = provider
  voiceRef.current = voice
  selectionKeyRef.current = audioSelectionKey(provider, voice)
  syncAudioFollowCueRef.current = syncAudioFollowCue
  clearAudioFollowRef.current = clearAudioFollow
  showToastRef.current = showToast

  const emitSnapshot = useCallback((patch: Partial<TtsSnapshot> = {}) => {
    const queue = queueRef.current
    const session = sessionStateRef.current
    const ready = queue?.readyRunFrom(session.currentIndex) ?? { count: 0, seconds: 0 }
    const next = session.snapshot({
      provider: providerRef.current,
      totalChunks: chunksRef.current.length,
      nativeReadyChunks: ready.count,
      bufferedSeconds: ready.seconds,
      patch,
    })
    setSnapshot(next)
  }, [])

  const revokeObjectUrls = useCallback(() => {
    for (const url of objectUrlsRef.current) URL.revokeObjectURL(url)
    objectUrlsRef.current.clear()
  }, [])

  const stopWordAudio = useCallback(() => {
    sessionStateRef.current.stop()
    fallbackLaneRef.current.stop()
    nativeSinkRef.current.stop()
    queueRef.current?.resetInflight()
    queueRef.current = null
    chunksRef.current = []
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
    if (!firstAudioGateRef.current.shouldReport(sessionId, sessionStateRef.current.id)) return
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
    if (!sessionStateRef.current.isCurrent(sessionId)) return
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

  const fetchNativeChunk = useMemo(() => createNativeAudioSource({
    bookId,
    getProvider: () => providerRef.current,
    getVoice: () => voiceRef.current,
    getSelectionKey: () => selectionKeyRef.current,
    ensureAudioContext: () => nativeSinkRef.current.ensureContext(),
    trackObjectUrl: (url) => objectUrlsRef.current.add(url),
  }), [bookId])

  const startNativeAt = useCallback((
    index: number,
    ctrl: AbortController,
    startedAt: number,
    sessionId: number,
    reason?: 'voice-switch',
  ) => {
    const session = sessionStateRef.current
    const queue = queueRef.current
    const chunk = queue?.allChunks[index]
    if (!queue || !chunk?.buffer || !session.isCurrent(sessionId, ctrl.signal)) return false

    const previousLane = session.lane
    fallbackLaneRef.current.stop()
    session.setPlaying('native')
    const scheduledCount = nativeSinkRef.current.playReadyRun({
      chunks: queue.allChunks,
      startIndex: index,
      rate: rateRef.current,
      tapOffset: index === 0 ? chunk.start : null,
      signal: ctrl.signal,
      onChunkStart: (startedChunk, startedIndex) => {
        if (!session.isCurrent(sessionId, ctrl.signal)) return
        session.setCurrentIndex(startedIndex)
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
        if (!session.isCurrent(sessionId, ctrl.signal)) return
        syncAudioFollowCueRef.current(activeChunk, currentTime, follow)
      },
      onRunDrained: (nextIndex) => {
        if (!session.isCurrent(sessionId, ctrl.signal)) return
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
        session.setBuffering()
        emitSnapshot()
        void queue.ensure(nextIndex, ctrl.signal, false).then((result) => {
          if (!session.isCurrent(sessionId, ctrl.signal) || !result?.buffer) return
          startNativeAtRef.current(nextIndex, ctrl, startedAt, sessionId, reason)
        }).catch((error) => {
          if (!session.isCurrent(sessionId, ctrl.signal)) return
          showToastRef.current(audioErrorMessage(error))
          stopWordAudio()
        })
      },
    })
    return scheduledCount > 0
  }, [emitSnapshot, markFirstAudio, markNativeHandoff, stopWordAudio])

  const speakFallbackAt = useCallback((
    index: number,
    ctrl: AbortController,
    startedAt: number,
    sessionId: number,
    reason?: 'voice-switch',
  ): boolean => {
    const session = sessionStateRef.current
    const chunk = chunksRef.current[index]
    const queue = queueRef.current
    if (!chunk || !session.isCurrent(sessionId, ctrl.signal)) return false

    session.setPlaying('fallback')
    session.setCurrentIndex(index)
    queue?.prefetchFrom(
      nativePrefetchStartIndexForFallback(providerRef.current, index),
      PREFETCH_AHEAD_TARGET[providerRef.current] ?? DEFAULT_PREFETCH_AHEAD,
      ctrl.signal,
    )
    syncAudioFollowCueRef.current(chunk, 0, true)
    emitSnapshot()

    return fallbackLaneRef.current.speakChunk({
      chunk: { index, text: chunk.text },
      rate: rateRef.current,
      signal: ctrl.signal,
      onStart: () => {
        if (!session.isCurrent(sessionId, ctrl.signal)) return
        markFirstAudio(startedAt, sessionId, 'fallback', chunk, reason)
        session.setPlaying('fallback')
        emitSnapshot()
      },
      onEnd: () => {
        if (!session.isCurrent(sessionId, ctrl.signal)) return
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
        if (!session.isCurrent(sessionId, ctrl.signal)) return
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
    const startedSession = sessionStateRef.current.begin({
      word,
      selectionKey: selectionKeyRef.current,
    })
    const sessionId = startedSession.id
    const startSelectionKey = startedSession.selectionKey
    const ctrl = startedSession.controller
    nativeReadyReportedRef.current = false
    firstAudioGateRef.current.reset()

    if (providerRef.current === 'kokoro') startWarmup()

    const chunks = buildTtsChunks({
      bookText,
      startOffset,
      provider: providerRef.current,
      presynthGrid: presynthGridRef.current,
      kokoroModelReady: isModelReady(),
    })
    if (selectionKeyRef.current !== startSelectionKey) return
    if (!chunks.length) {
      showToastRef.current('There is no readable text at this position.')
      stopWordAudio()
      return
    }

    chunksRef.current = chunks
    const queue = new TtsNativeQueue(chunks, fetchNativeChunk)
    queueRef.current = queue
    const unsubscribe = queue.subscribe(() => {
      const session = sessionStateRef.current
      if (!session.isCurrent(sessionId, ctrl.signal)) return
      const nextIndex = session.currentIndex
      if (session.lane === 'native') {
        nativeSinkRef.current.extendReadyRun(queue.allChunks)
      }
      emitSnapshot()
      if (
        session.lane === 'fallback' &&
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
        browserFallback: providerRef.current === BROWSER_TTS_PROVIDER_ID && fallbackLaneRef.current.canSpeak(),
        kokoroModelReady: isModelReady(),
      },
    })
    emitSnapshot()

    if (providerRef.current === BROWSER_TTS_PROVIDER_ID && fallbackLaneRef.current.canSpeak()) {
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
      if (!sessionStateRef.current.isCurrent(sessionId, ctrl.signal)) return
      if (selectionKeyRef.current !== startSelectionKey) return
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
    const session = sessionStateRef.current
    if (session.phase === 'buffering') {
      stopWordAudio()
      return
    }
    if (session.phase === 'playing') {
      if (session.lane === 'fallback') fallbackLaneRef.current.pause()
      else void nativeSinkRef.current.pause()
      session.setPaused()
      emitSnapshot()
      return
    }
    if (session.phase !== 'paused') return
    if (session.lane === 'fallback') fallbackLaneRef.current.resume()
    else void nativeSinkRef.current.resume()
    session.setPlaying(session.lane)
    emitSnapshot()
  }, [emitSnapshot, stopWordAudio])

  const isAudioActive = useCallback(() => (
    sessionStateRef.current.isAudibleOrLoading() ||
    fallbackLaneRef.current.isActive ||
    nativeSinkRef.current.active
  ), [])

  useEffect(() => {
    const session = sessionStateRef.current
    if (session.phase !== 'idle' && session.currentWord) {
      const currentChunk = chunksRef.current[session.currentIndex] ?? chunksRef.current[0]
      if (currentChunk) void playWord(session.currentWord, currentChunk.start, 'voice-switch')
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
    const controller = sessionStateRef.current.abortController
    if (providerRef.current === BROWSER_TTS_PROVIDER_ID || !queue || !controller) return
    const currentIndex = sessionStateRef.current.currentIndex
    queue.prefetchFrom(currentIndex + 1, PREFETCH_AHEAD_TARGET[providerRef.current] ?? DEFAULT_PREFETCH_AHEAD, controller.signal)
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
