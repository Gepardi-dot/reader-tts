export type TtsPhase = 'idle' | 'buffering' | 'playing' | 'paused'
export type TtsChunkStatus = 'idle' | 'fetching' | 'ready' | 'error'
export type TtsPlaybackLane = 'none' | 'fallback' | 'native'

export interface TtsCue {
  start: number
  end: number
  timeStart: number
  timeEnd: number
}

export interface TtsAudioChunk {
  id: string
  index: number
  start: number
  end: number
  text: string
  status: TtsChunkStatus
  url: string | null
  buffer: AudioBuffer | null
  cues: TtsCue[]
  durationSec: number | null
  cacheHit?: boolean | null
  cacheStorage?: string | null
}

export type AudioPhase = TtsPhase

export interface PreviewAudioChunk {
  start: number
  end: number
  text: string
  status: TtsChunkStatus
  url: string | null
  buffer: AudioBuffer | null
}

export interface TtsSnapshot {
  phase: TtsPhase
  lane: TtsPlaybackLane
  currentIndex: number
  totalChunks: number
  word: string | null
  provider: string
  nativeReadyChunks: number
  bufferedSeconds: number
  error: string | null
}

export interface NativeAudioResult {
  url: string | null
  buffer: AudioBuffer | null
  cues: TtsCue[]
  durationSec: number | null
  cacheHit?: boolean | null
  cacheStorage?: string | null
}

export interface TtsGridChunk {
  start: number
  end: number
}
