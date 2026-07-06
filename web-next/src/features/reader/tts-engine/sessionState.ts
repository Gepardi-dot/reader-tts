import type { TtsPhase, TtsPlaybackLane, TtsSnapshot } from './types'

export interface TtsSessionHandle {
  id: number
  controller: AbortController
  signal: AbortSignal
  selectionKey: string
}

export class TtsSessionState {
  private sessionId = 0
  private controller: AbortController | null = null
  private currentPhase: TtsPhase = 'idle'
  private currentLane: TtsPlaybackLane = 'none'
  private chunkIndex = 0
  private activeWord: string | null = null
  private activeSelectionKey: string | null = null

  get id() {
    return this.sessionId
  }

  get abortController() {
    return this.controller
  }

  get phase() {
    return this.currentPhase
  }

  get lane() {
    return this.currentLane
  }

  get currentIndex() {
    return this.chunkIndex
  }

  get currentWord() {
    return this.activeWord
  }

  get selectionKey() {
    return this.activeSelectionKey
  }

  begin({ word, selectionKey }: { word: string; selectionKey: string }): TtsSessionHandle {
    this.abortCurrent()
    this.sessionId += 1
    this.controller = new AbortController()
    this.currentPhase = 'buffering'
    this.currentLane = 'none'
    this.chunkIndex = 0
    this.activeWord = word
    this.activeSelectionKey = selectionKey

    return {
      id: this.sessionId,
      controller: this.controller,
      signal: this.controller.signal,
      selectionKey,
    }
  }

  stop() {
    this.abortCurrent()
    this.sessionId += 1
    this.currentPhase = 'idle'
    this.currentLane = 'none'
    this.chunkIndex = 0
    this.activeWord = null
    this.activeSelectionKey = null
  }

  isCurrent(sessionId: number, signal?: AbortSignal | null) {
    return sessionId === this.sessionId && !signal?.aborted
  }

  isCurrentSelection(sessionId: number, selectionKey: string, signal?: AbortSignal | null) {
    return this.isCurrent(sessionId, signal) && this.activeSelectionKey === selectionKey
  }

  setPlaying(lane: TtsPlaybackLane) {
    this.currentPhase = 'playing'
    this.currentLane = lane
  }

  setBuffering() {
    this.currentPhase = 'buffering'
  }

  setPaused() {
    this.currentPhase = 'paused'
  }

  setCurrentIndex(index: number) {
    this.chunkIndex = Math.max(0, Math.floor(index))
  }

  isAudibleOrLoading() {
    return this.currentPhase === 'playing' || this.currentPhase === 'buffering'
  }

  snapshot({
    provider,
    totalChunks,
    nativeReadyChunks,
    bufferedSeconds,
    patch = {},
  }: {
    provider: string
    totalChunks: number
    nativeReadyChunks: number
    bufferedSeconds: number
    patch?: Partial<TtsSnapshot>
  }): TtsSnapshot {
    return {
      phase: this.currentPhase,
      lane: this.currentLane,
      currentIndex: this.chunkIndex,
      totalChunks,
      word: this.activeWord,
      provider,
      nativeReadyChunks,
      bufferedSeconds,
      error: null,
      ...patch,
    }
  }

  private abortCurrent() {
    this.controller?.abort()
    this.controller = null
  }
}
