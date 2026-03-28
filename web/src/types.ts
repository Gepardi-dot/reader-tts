export type VoiceOption = {
  id: string
  label: string
  gender?: 'male' | 'female' | 'neutral'
  genderSource?: 'provider' | 'estimated'
  style?: string
  tags?: string[]
  models?: string[]
}

export type ProviderModelOption = {
  id: string
  label: string
  description: string
  storytelling?: boolean
}

export type ProviderCatalog = {
  id: 'piper' | 'google' | 'openai' | 'polly' | 'qwen'
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
  provider: 'piper' | 'google' | 'openai' | 'polly' | 'qwen'
  voice: string | null
  model?: string | null
  sampleText: string
  audioUrl: string
  message: string
}

export type DictionarySense = {
  partOfSpeech?: string | null
  definition: string
  examples: string[]
  registerLabel?: string | null
  notes?: string | null
}

export type DictionaryLookupResult = {
  term: string
  normalizedTerm: string
  available: boolean
  exact: boolean
  source?: string | null
  pronunciation?: string | null
  entries: DictionarySense[]
  message?: string | null
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
  timingUrl?: string | null
}

export type AudioTimingCue = {
  start: number
  end: number
  timeStart: number
  timeEnd: number
}

export type AudioTimingManifest = {
  version: number
  audioUrl: string
  textLength: number
  duration: number
  cues: AudioTimingCue[]
}

export type LiveAudioSegment = {
  provider: 'piper' | 'google' | 'openai' | 'polly' | 'qwen'
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
