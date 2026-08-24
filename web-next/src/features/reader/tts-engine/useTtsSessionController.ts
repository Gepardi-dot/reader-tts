import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { audioSelectionKey } from '../audioPlayback'
import { TtsRuntime } from './ttsRuntime'
import type { TtsAudioChunk, TtsGridChunk, TtsPhase } from './types'

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
  wordAudioStatusText: string | null
  playWord: (word: string, startOffset: number, reason?: 'voice-switch') => Promise<void>
  toggleWordAudio: () => void
  stopWordAudio: () => void
  isAudioActive: () => boolean
  /** Preheat Kokoro SegmentCache around a reading offset (legacy on-device). */
  prepareKokoroWindow: (input: {
    bookText: string
    offset: number
    voice: string
    maxSegments?: number
    signal?: AbortSignal
  }) => Promise<void>
  /** Speculative live-audio warm so Play is often instant (hosted Kokoro/Gemini). */
  warmCloudAtOffset: (startOffset: number) => void
}

/**
 * Thin React adapter around the imperative TtsRuntime.
 * No audio timing lives here — only subscription and command forwarding.
 *
 * Note: React Strict Mode runs mount→cleanup→mount. Dispose must not leave
 * effects calling methods on a nulled runtime; always re-create via ensure().
 */
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
  const runtimeRef = useRef<TtsRuntime | null>(null)
  const ensureRuntime = () => {
    if (!runtimeRef.current) runtimeRef.current = new TtsRuntime()
    return runtimeRef.current
  }
  ensureRuntime()

  const bookTextRef = useRef(bookText)
  const providerRef = useRef(provider)
  const voiceRef = useRef(voice)
  const rateRef = useRef(rate)
  const bookIdRef = useRef(bookId)
  bookTextRef.current = bookText
  providerRef.current = provider
  voiceRef.current = voice
  rateRef.current = rate
  bookIdRef.current = bookId

  const [, setTick] = useState(0)
  const selectionKey = audioSelectionKey(provider, voice)

  useEffect(() => {
    const runtime = ensureRuntime()
    runtime.setHooks({
      syncAudioFollowCue,
      clearAudioFollow,
      showToast,
    })
    return runtime.subscribe(() => setTick((n) => n + 1))
  }, [syncAudioFollowCue, clearAudioFollow, showToast])

  useEffect(() => {
    ensureRuntime().setRate(rate)
  }, [rate])

  useEffect(() => () => {
    runtimeRef.current?.dispose()
    runtimeRef.current = null
  }, [])

  useEffect(() => {
    const unlock = () => ensureRuntime().unlockAudio()
    window.addEventListener('pointerdown', unlock, { once: true, passive: true })
    window.addEventListener('keydown', unlock, { once: true })
    return () => {
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
    }
  }, [])

  const playWord = useCallback(async (
    word: string,
    startOffset: number,
    reason?: 'voice-switch',
  ) => {
    ensureRuntime().unlockAudio()
    await ensureRuntime().start({
      word,
      startOffset,
      bookText: bookTextRef.current,
      bookId: bookIdRef.current,
      provider: providerRef.current,
      voice: voiceRef.current,
      rate: rateRef.current,
      presynthGrid: presynthGridRef.current,
      reason: reason ?? 'tap',
    })
  }, [presynthGridRef])

  // Voice/provider change restarts an active session with the new selection.
  const prevSelectionRef = useRef(selectionKey)
  useEffect(() => {
    if (prevSelectionRef.current === selectionKey) return
    prevSelectionRef.current = selectionKey
    const runtime = runtimeRef.current
    if (!runtime) return
    const snap = runtime.getSnapshot()
    if (snap.phase === 'idle' || !snap.word) return
    const startOffset = runtime.chunkStart(snap.currentIndex) ?? 0
    void playWord(snap.word, startOffset, 'voice-switch')
  }, [selectionKey, playWord])

  const stopWordAudio = useCallback(() => {
    runtimeRef.current?.stop()
  }, [])

  const toggleWordAudio = useCallback(() => {
    runtimeRef.current?.toggle()
  }, [])

  const isAudioActive = useCallback(() => (
    runtimeRef.current?.isAudibleOrLoading() ?? false
  ), [])

  const prepareKokoroWindow = useCallback(async (input: {
    bookText: string
    offset: number
    voice: string
    maxSegments?: number
    signal?: AbortSignal
  }) => {
    await ensureRuntime().prepareKokoroWindow(input)
  }, [])

  const warmAbortRef = useRef<AbortController | null>(null)
  const warmCloudAtOffset = useCallback((startOffset: number) => {
    warmAbortRef.current?.abort()
    const ctrl = new AbortController()
    warmAbortRef.current = ctrl
    void ensureRuntime().warmCloudAtOffset({
      bookId: bookIdRef.current,
      bookText: bookTextRef.current,
      startOffset,
      provider: providerRef.current,
      voice: voiceRef.current,
      rate: rateRef.current,
      signal: ctrl.signal,
    })
  }, [])

  useEffect(() => () => {
    warmAbortRef.current?.abort()
  }, [])

  const snapshot = ensureRuntime().getSnapshot()

  return {
    wordAudioPhase: snapshot.phase,
    wordAudioCurIdx: snapshot.currentIndex,
    wordAudioTotal: snapshot.totalChunks,
    wordAudioStatusText: snapshot.statusText ?? null,
    playWord,
    toggleWordAudio,
    stopWordAudio,
    isAudioActive,
    prepareKokoroWindow,
    warmCloudAtOffset,
  }
}
