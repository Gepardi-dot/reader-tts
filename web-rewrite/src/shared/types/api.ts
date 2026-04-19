export type VoiceOption = {
  id: string
  label: string
  gender?: 'male' | 'female' | 'neutral'
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
  id: 'piper' | 'google' | 'openai' | 'polly' | 'qwen' | 'qwen_local'
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
  provider: ProviderCatalog['id']
  voice: string | null
  model?: string | null
  sampleText: string
  audioUrl: string
  message: string
}

export type HighlightColor = 'amber' | 'rose' | 'sky'
export type HighlightKind = 'highlight' | 'note' | 'vocabulary'

export type Highlight = {
  id: string
  start: number
  end: number
  color: HighlightColor
  kind: HighlightKind
  text: string
  note: string | null
  createdAt: string
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

export type VocabularyRating = 'again' | 'hard' | 'good' | 'easy'
export type VocabularyCardState = 'new' | 'learning' | 'review' | 'relearning'
export type VocabularyCardType = 'basic' | 'reverse' | 'cloze'

export type VocabularyDeckSummary = {
  id: string
  title: string
  description: string | null
  createdAt: string
  updatedAt: string
  noteCount: number
  cardCount: number
  dueNow: number
  dueToday: number
  newAvailable: number
  newCardCap: number
  newIntroducedToday: number
  reviewsCompletedToday: number
  suspendedCards: number
  nextDueAt: string | null
  cardsByState: Record<VocabularyCardState, number>
}

export type VocabularyNote = {
  id: string
  deckId: string
  noteType: 'basic' | 'basic_reverse' | 'cloze'
  front: string
  back: string | null
  extra: string | null
  hint: string | null
  explanation: string | null
  exampleSentence: string | null
  imageUrl: string | null
  audioUrl: string | null
  tags: string[]
  topic: string | null
  sourceBookId: string | null
  sourceBookTitle: string | null
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
  cards: Array<{
    id: string
    cardType: VocabularyCardType
    state: VocabularyCardState
    cue: string
    answer: string
    dueAt: string
    lastReviewAt: string | null
    scheduledDays: number
    reps: number
    lapses: number
    isSuspended: boolean
  }>
}

export type VocabularyDeckDashboard = {
  deck: VocabularyDeckSummary
  analytics: {
    dueToday: number
    newToday: number
    reviewsCompletedToday: number
    rollingRetention7d: number | null
    rollingRetention30d: number | null
    lapseRate: number | null
    averageResponseMs: number | null
    cardsLearned: number
    cardsByState: Record<VocabularyCardState, number>
    projectedReviewLoad: Array<{ date: string; count: number }>
    spacingPreview: Array<{ step: number; label: string; state: VocabularyCardState }>
  }
  notes: VocabularyNote[]
  recentReviews: Array<{
    id: string
    cardId: string
    rating: VocabularyRating
    reviewedAt: string
    stateBefore: VocabularyCardState
    stateAfter: Exclude<VocabularyCardState, 'new'>
    responseMs: number | null
    answerMode: string
    cue: string
    topic: string | null
    cardType: VocabularyCardType
    typedResponse: string | null
  }>
}

export type VocabularySessionCard = {
  id: string
  deckId: string
  noteId: string
  deckTitle: string
  cardType: VocabularyCardType
  state: VocabularyCardState
  cue: string
  answer: string
  extra: string | null
  hint: string | null
  explanation: string | null
  exampleSentence: string | null
  imageUrl: string | null
  audioUrl: string | null
  pronunciation: string | null
  tags: string[]
  topic: string | null
  dueAt: string
  productionTarget: string
  requiresProduction: boolean
  productionCount: number
  sourceBookId?: string | null
  sourceBookTitle?: string | null
  ratingPreview: Record<
    VocabularyRating,
    {
      dueAt: string
      label: string
      state: Exclude<VocabularyCardState, 'new'>
    }
  >
  debug: {
    dueAt: string
    lastReviewAt: string | null
    retrievability: number | null
    scheduledDays: number
    elapsedDays: number
    stability: number | null
    difficulty: number | null
    reps: number
    lapses: number
    learningStepIndex: number | null
  }
}

export type VocabularyPracticeSessionPayload = {
  deck: VocabularyDeckSummary
  items: VocabularySessionCard[]
}

export type VocabularySessionPayload = {
  deck: VocabularyDeckSummary
  summary: VocabularyDeckSummary
  currentCard: VocabularySessionCard | null
}

export type VocabularyLessonPlan = {
  provider: 'gemma' | 'openai' | 'fallback'
  term: string
  pronunciation: string | null
  definition: string
  contextTitle: string
  contextParagraph: string
  usageFocus: string[]
  recallPrompt: string
  usagePrompt: string
  speakingPrompt: string
  productionPrompt: string
}

export type VocabularyCoachResponse = {
  provider: 'gemma' | 'openai' | 'fallback'
  feedbackTitle: string
  feedbackBody: string
  correction: string
  nextPrompt: string
  suggestedRating: VocabularyRating | null
  canRate: boolean
  verdict: 'correct' | 'close' | 'incorrect'
  turnCount: number
  context?: {
    source: 'ai' | 'gemma' | 'dictionary_fallback'
    contextTitle: string
    contextParagraph: string
    usageFocus: string[]
  }
}

export type VocabularyProductionResult = {
  accepted: boolean
  feedback: string
  sentenceNotes: string[]
}

export type VocabularyReviewResult = {
  reviewedCard: VocabularySessionCard
  summary: VocabularyDeckSummary
  nextCard: VocabularySessionCard | null
}

export type LearningProgressStats = {
  streakDays: number
  xpToday: number
  xpGoal: number
  reviewsToday: number
  lessonsToday: number
}

export type ContinueReadingCard = {
  book: Book
  progress: BookProgress | null
  completionRatio: number
  ctaLabel: string
}

export type LearningEvent = {
  id: string
  type: string
  xpDelta: number
  createdAt: string
  bookId: string | null
  deckId: string | null
  cardId: string | null
  label: string
  detail: string | null
}

export type LearningHomePayload = {
  hero: LearningProgressStats
  continueBook: ContinueReadingCard | null
  defaultDeck: VocabularyDeckSummary | null
  lessonQueue: {
    queued: number
    topic: string | null
    sourceBookTitle: string | null
  } | null
  recentActivity: LearningEvent[]
}

export type AudioPreference = {
  providerId: ProviderCatalog['id'] | null
  voiceId: string | null
  modelId: string | null
  outputFormat: 'mp3' | 'wav'
  narrationStyle: string
  lengthScale: number
  sentenceSilence: number
}
