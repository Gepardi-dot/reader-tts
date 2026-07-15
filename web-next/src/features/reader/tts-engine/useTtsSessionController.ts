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
  playWord: (word: string, startOffset: number, reason?: 'voice-switch') => Promise<void>
  toggleWordAudio: () => void
  stopWordAudio: () => void
  isAudioActive: () => boolean
}

/**
 * Thin React adapter around the imperative TtsRuntime.
 * No audio timing lives here — only subscription and command forwarding.
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
  if (!runtimeRef.current) runtimeRef.current = new TtsRuntime()

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
    const runtime = runtimeRef.current!
    runtime.setHooks({
      syncAudioFollowCue,
      clearAudioFollow,
      showToast,
    })
    return runtime.subscribe(() => setTick((n) => n + 1))
  }, [syncAudioFollowCue, clearAudioFollow, showToast])

  useEffect(() => {
    runtimeRef.current?.setRate(rate)
  }, [rate])

  useEffect(() => () => {
    runtimeRef.current?.dispose()
    runtimeRef.current = null
  }, [])

  const playWord = useCallback(async (
    word: string,
    startOffset: number,
    reason?: 'voice-switch',
  ) => {
    const runtime = runtimeRef.current
    if (!runtime) return
    await runtime.start({
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

  const snapshot = runtimeRef.current?.getSnapshot()

  return {
    wordAudioPhase: snapshot?.phase ?? 'idle',
    wordAudioCurIdx: snapshot?.currentIndex ?? 0,
    wordAudioTotal: snapshot?.totalChunks ?? 0,
    playWord,
    toggleWordAudio,
    stopWordAudio,
    isAudioActive,
  }
}
