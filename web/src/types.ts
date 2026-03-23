export type VoiceOption = {
  id: string
  label: string
  gender?: 'male' | 'female' | 'neutral'
  genderSource?: 'provider' | 'estimated'
  style?: string
  tags?: string[]
}

export type ProviderModelOption = {
  id: string
  label: string
  description: string
  storytelling?: boolean
}

export type ProviderCatalog = {
  id: 'piper' | 'google' | 'openai' | 'polly'
  name: string
  available: boolean
  recommended: boolean
  description: string
  voices: VoiceOption[]
  defaultVoice: string | null
  models: ProviderModelOption[]
  defaultModel: string | null
  voiceMetaNote: string | null
}

export type ProviderTestResult = {
  provider: 'piper' | 'google' | 'openai' | 'polly'
  voice: string | null
  model?: string | null
  sampleText: string
  audioUrl: string
  message: string
}

export type HighlightColor = 'amber' | 'rose' | 'sky'

export type Highlight = {
  id: string
  start: number
  end: number
  color: HighlightColor
  text: string
  note: string | null
  createdAt: string
}

export type PollyHealth = {
  connected: boolean
  region: string
  engine: string
  languageCode: string
  profile: string | null
  defaultVoice: string | null
  voiceCount: number
  accountId: string | null
  arn: string | null
  message: string
}

export type AudioVersion = {
  provider: string
  voice: string
  model?: string
  format: string
  createdAt: string
  url: string
}

export type LiveAudioSegment = {
  provider: 'piper' | 'google' | 'openai' | 'polly'
  voice: string | null
  model?: string | null
  format: 'mp3' | 'wav'
  url: string
  start: number
  end: number
  pageNumber: number
  cached: boolean
}

export type ReadingProgress = {
  pageNumber: number
  totalPages: number
  textStart?: number
  textEnd?: number
  textLength?: number
  updatedAt: string
}

export type StoredAudioProgress = {
  url: string
  currentTime: number
  wasPlaying: boolean
  updatedAt: string
}

export type BookProgress = {
  reading: ReadingProgress | null
  audio: StoredAudioProgress | null
}

export type Book = {
  id: string
  title: string
  fileName: string
  uploadedAt: string
  pageCount: number
  textCharacters: number
  sourceUrl: string
  excerpt: string
  highlightCount: number
  latestAudio: AudioVersion | null
}

export type ReaderPayload = {
  book: Book
  text: string
  highlights: Highlight[]
}

export type JobStatus = {
  id: string
  bookId: string
  provider: string
  status: 'queued' | 'running' | 'cancelling' | 'cancelled' | 'completed' | 'failed'
  progress: number
  totalChunks: number
  completedChunks: number
  message: string
  createdAt: string
  finishedAt: string | null
  error: string | null
  result: {
    audioUrl: string
    book: Book
  } | null
}
