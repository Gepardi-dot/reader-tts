import type {
  AudioPreference,
  Book,
  BookProgress,
  ContinueReadingCard,
  LearningEvent,
  LearningHomePayload,
  ProviderCatalog,
  ReaderPayload,
  VocabularyDeckDashboard,
  VocabularyDeckSummary,
  VocabularyLessonPlan,
  VocabularyPracticeSessionPayload,
  VocabularySessionCard,
} from '@/shared/types/api'

const mockBook: Book = {
  id: 'mock-book-1',
  title: 'The Secret Garden',
  fileName: 'secret-garden.pdf',
  uploadedAt: new Date().toISOString(),
  pageCount: 184,
  textCharacters: 84532,
  sourceUrl: '#',
  excerpt: 'When Mary Lennox was sent to Misselthwaite Manor to live with her uncle...',
  highlightCount: 12,
  latestAudio: null,
}

const mockProgress: BookProgress = {
  reading: {
    pageNumber: 9,
    totalPages: 37,
    textStart: 16800,
    textEnd: 19120,
    textLength: 84532,
    updatedAt: new Date().toISOString(),
  },
  audio: null,
}

export const mockContinueBook: ContinueReadingCard = {
  book: mockBook,
  progress: mockProgress,
  completionRatio: 0.24,
  ctaLabel: 'Resume chapter',
}

export const mockDeck: VocabularyDeckSummary = {
  id: 'deck-reader',
  title: 'Reader Vocabulary',
  description: 'Collected from highlights and passage imports.',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  noteCount: 36,
  cardCount: 48,
  dueNow: 7,
  dueToday: 11,
  newAvailable: 5,
  newCardCap: 6,
  newIntroducedToday: 1,
  reviewsCompletedToday: 8,
  suspendedCards: 0,
  nextDueAt: new Date(Date.now() + 1000 * 60 * 90).toISOString(),
  cardsByState: {
    new: 12,
    learning: 9,
    review: 23,
    relearning: 4,
  },
}

export const mockActivity: LearningEvent[] = [
  {
    id: 'evt-1',
    type: 'review_completed',
    xpDelta: 12,
    createdAt: new Date().toISOString(),
    bookId: mockBook.id,
    deckId: mockDeck.id,
    cardId: 'card-1',
    label: 'Review closed cleanly',
    detail: 'You marked "moor" as Good after one correction turn.',
  },
  {
    id: 'evt-2',
    type: 'lesson_completed',
    xpDelta: 20,
    createdAt: new Date(Date.now() - 1000 * 60 * 55).toISOString(),
    bookId: mockBook.id,
    deckId: mockDeck.id,
    cardId: 'card-2',
    label: 'Lesson finished',
    detail: 'Production accepted for "wretched".',
  },
]

export const mockLearningHome: LearningHomePayload = {
  hero: {
    streakDays: 6,
    xpToday: 62,
    xpGoal: 80,
    reviewsToday: 8,
    lessonsToday: 2,
  },
  continueBook: mockContinueBook,
  defaultDeck: mockDeck,
  lessonQueue: {
    queued: 5,
    topic: 'Mood words',
    sourceBookTitle: mockBook.title,
  },
  recentActivity: mockActivity,
}

export const mockProviders: ProviderCatalog[] = [
  {
    id: 'polly',
    name: 'Amazon Polly',
    available: true,
    recommended: true,
    description: 'Fast hosted narration for steady reading sessions.',
    voices: [
      { id: 'Matthew', label: 'Matthew', gender: 'male' },
      { id: 'Joanna', label: 'Joanna', gender: 'female' },
    ],
    defaultVoice: 'Matthew',
    models: [],
    defaultModel: null,
    voiceMetaNote: null,
  },
  {
    id: 'google',
    name: 'Google Gemini TTS',
    available: true,
    recommended: false,
    description: 'Expressive hosted synthesis for sentence practice.',
    voices: [{ id: 'Aoede', label: 'Aoede', gender: 'female' }],
    defaultVoice: 'Aoede',
    models: [{ id: 'gemini-2.5-flash-preview-tts', label: 'Flash TTS', description: 'Fast sentence synthesis' }],
    defaultModel: 'gemini-2.5-flash-preview-tts',
    voiceMetaNote: null,
  },
]

const baseSessionCard: VocabularySessionCard = {
  id: 'card-1',
  deckId: mockDeck.id,
  noteId: 'note-1',
  deckTitle: mockDeck.title,
  cardType: 'basic',
  state: 'learning',
  cue: 'wretched',
  answer: 'very unhappy or in poor condition',
  extra: 'Imported from The Secret Garden',
  hint: null,
  explanation: 'Used to describe a person or state that feels miserable.',
  exampleSentence: 'He looked wretched in the cold rain.',
  imageUrl: null,
  audioUrl: null,
  pronunciation: '/RETCH-id/',
  tags: ['reader', 'mood'],
  topic: 'Mood words',
  dueAt: new Date().toISOString(),
  productionTarget: 'wretched',
  requiresProduction: true,
  productionCount: 0,
  sourceBookId: mockBook.id,
  sourceBookTitle: mockBook.title,
  ratingPreview: {
    again: { dueAt: new Date(Date.now() + 1000 * 60 * 10).toISOString(), label: '10m', state: 'learning' },
    hard: { dueAt: new Date(Date.now() + 1000 * 60 * 60).toISOString(), label: '1h', state: 'learning' },
    good: { dueAt: new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString(), label: '1d', state: 'review' },
    easy: { dueAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 4).toISOString(), label: '4d', state: 'review' },
  },
  debug: {
    dueAt: new Date().toISOString(),
    lastReviewAt: null,
    retrievability: null,
    scheduledDays: 0,
    elapsedDays: 0,
    stability: null,
    difficulty: null,
    reps: 0,
    lapses: 0,
    learningStepIndex: 0,
  },
}

export const mockPracticeSession: VocabularyPracticeSessionPayload = {
  deck: mockDeck,
  items: [
    baseSessionCard,
    {
      ...baseSessionCard,
      id: 'card-2',
      noteId: 'note-2',
      cue: 'moor',
      answer: 'an open stretch of uncultivated land',
      exampleSentence: 'The wind swept over the dark moor.',
      productionTarget: 'moor',
      requiresProduction: false,
    },
  ],
}

export const mockLessonPlan: VocabularyLessonPlan = {
  provider: 'fallback',
  term: 'wretched',
  pronunciation: '/RETCH-id/',
  definition: 'very unhappy or in poor condition',
  contextTitle: 'Cold corridor scene',
  contextParagraph:
    'Imagine a child standing in a long stone corridor, soaked through, irritated, and far from home. The scene feels thin, drafty, and joyless.',
  usageFocus: ['physical discomfort', 'emotional misery', 'plain English paraphrase'],
  recallPrompt: 'Explain what "wretched" means before checking the answer.',
  usagePrompt: 'Describe how the mood of the corridor makes the word fit.',
  speakingPrompt: 'Say the word once slowly, then use it in one short original sentence.',
  productionPrompt: 'Write three short sentences using the word in clear, believable ways.',
}

export const mockDeckDashboard: VocabularyDeckDashboard = {
  deck: mockDeck,
  analytics: {
    dueToday: 11,
    newToday: 5,
    reviewsCompletedToday: 8,
    rollingRetention7d: 0.82,
    rollingRetention30d: 0.78,
    lapseRate: 0.12,
    averageResponseMs: 3100,
    cardsLearned: 24,
    cardsByState: mockDeck.cardsByState,
    projectedReviewLoad: [
      { date: new Date().toISOString(), count: 11 },
      { date: new Date(Date.now() + 86400000).toISOString(), count: 8 },
      { date: new Date(Date.now() + 2 * 86400000).toISOString(), count: 6 },
      { date: new Date(Date.now() + 3 * 86400000).toISOString(), count: 9 },
      { date: new Date(Date.now() + 4 * 86400000).toISOString(), count: 4 },
      { date: new Date(Date.now() + 5 * 86400000).toISOString(), count: 7 },
      { date: new Date(Date.now() + 6 * 86400000).toISOString(), count: 5 },
    ],
    spacingPreview: [
      { step: 1, label: '10m', state: 'learning' },
      { step: 2, label: '1d', state: 'review' },
      { step: 3, label: '4d', state: 'review' },
      { step: 4, label: '11d', state: 'review' },
    ],
  },
  notes: [],
  recentReviews: [],
}

export const mockReaderPayload: ReaderPayload = {
  book: mockBook,
  text: `When Mary Lennox was sent to Misselthwaite Manor to live with her uncle everybody said she was the most disagreeable-looking child ever seen.\n\nIt was true, too. She had a little thin face and a little thin body, thin light hair and a sour expression.\n\nBut the house itself changed the air around her. Corridors stretched quietly. Doors held back secrets. The moor kept its own counsel.`,
  highlights: [
    {
      id: 'hl-1',
      start: 196,
      end: 213,
      color: 'amber',
      kind: 'vocabulary',
      text: 'a sour expression',
      note: 'tone cue',
      createdAt: new Date().toISOString(),
    },
  ],
}

export const mockAudioPreference: AudioPreference = {
  providerId: 'polly',
  voiceId: 'Matthew',
  modelId: null,
  outputFormat: 'mp3',
  narrationStyle: '',
  lengthScale: 1,
  sentenceSilence: 0.2,
}
