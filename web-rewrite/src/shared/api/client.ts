import type {
  AudioPreference,
  Book,
  BookProgress,
  Highlight,
  HighlightColor,
  HighlightKind,
  LearningEvent,
  LearningHomePayload,
  LiveAudioSegment,
  ProviderCatalog,
  ProviderTestResult,
  ReaderPayload,
  VocabularyCoachResponse,
  VocabularyDeckDashboard,
  VocabularyDeckSummary,
  VocabularyLessonPlan,
  VocabularyPracticeSessionPayload,
  VocabularyProductionResult,
  VocabularyReviewResult,
  VocabularySessionPayload,
} from '@/shared/types/api'
import {
  mockAudioPreference,
  mockDeck,
  mockDeckDashboard,
  mockLearningHome,
  mockLessonPlan,
  mockPracticeSession,
  mockProviders,
  mockReaderPayload,
} from './mockData'

const USE_MOCKS = import.meta.env.VITE_USE_MOCKS === '1'

// ── Auth helpers ──────────────────────────────────────────────────────────────

const AUTH_KEY_STORAGE_KEY = 'storybook-auth-key'

export function getStoredAuthKey(): string | null {
  try {
    return window.localStorage.getItem(AUTH_KEY_STORAGE_KEY) || null
  } catch {
    return null
  }
}

export function setStoredAuthKey(key: string): void {
  try {
    window.localStorage.setItem(AUTH_KEY_STORAGE_KEY, key)
  } catch {
    // ignore
  }
}

export function clearStoredAuthKey(): void {
  try {
    window.localStorage.removeItem(AUTH_KEY_STORAGE_KEY)
  } catch {
    // ignore
  }
}

/** Thrown (and `storybook-auth-error` event dispatched) on HTTP 401. */
export class AuthError extends Error {
  constructor() {
    super('Access key required. Please enter your app access key.')
    this.name = 'AuthError'
  }
}

// ── Base HTTP client ──────────────────────────────────────────────────────────

function configuredApiOrigin() {
  const configured = import.meta.env.VITE_API_ORIGIN?.trim()
  return configured ? configured.replace(/\/$/, '') : ''
}

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const url = input.startsWith('http') ? input : `${configuredApiOrigin()}${input}`

  // Inject stored auth key into every request
  const authKey = getStoredAuthKey()
  const headers = new Headers(init?.headers)
  if (authKey) {
    headers.set('Authorization', `Bearer ${authKey}`)
  }

  const response = await fetch(url, { ...init, headers })
  const isJson = response.headers.get('content-type')?.includes('application/json') ?? false
  const payload = isJson ? await response.json() : null

  if (!response.ok) {
    if (response.status === 401) {
      window.dispatchEvent(new CustomEvent('storybook-auth-error'))
      throw new AuthError()
    }
    const detail =
      typeof payload?.detail === 'string'
        ? payload.detail
        : typeof payload?.message === 'string'
          ? payload.message
          : `Request failed with status ${response.status}.`
    throw new Error(detail)
  }

  return payload as T
}

function wait<T>(value: T, delay = 180): Promise<T> {
  return new Promise((resolve) => window.setTimeout(() => resolve(value), delay))
}

export function getStoredAudioPreference(): AudioPreference {
  try {
    const raw = window.localStorage.getItem('storybook-rewrite-audio-preference')
    if (!raw) {
      return mockAudioPreference
    }
    const parsed = JSON.parse(raw) as Partial<AudioPreference>
    return {
      providerId: parsed.providerId ?? null,
      voiceId: parsed.voiceId ?? null,
      modelId: parsed.modelId ?? null,
      outputFormat: parsed.outputFormat === 'wav' ? 'wav' : 'mp3',
      narrationStyle: typeof parsed.narrationStyle === 'string' ? parsed.narrationStyle : '',
      lengthScale: typeof parsed.lengthScale === 'number' ? parsed.lengthScale : 1,
      sentenceSilence: typeof parsed.sentenceSilence === 'number' ? parsed.sentenceSilence : 0.2,
    }
  } catch {
    return mockAudioPreference
  }
}

export function persistAudioPreference(preference: AudioPreference) {
  window.localStorage.setItem('storybook-rewrite-audio-preference', JSON.stringify(preference))
}

export async function getLearningHome() {
  if (USE_MOCKS) {
    return wait(mockLearningHome)
  }
  return request<LearningHomePayload>('/api/learning/home')
}

export async function postLearningEvent(payload: {
  type: string
  xpDelta?: number
  bookId?: string | null
  deckId?: string | null
  cardId?: string | null
  label?: string | null
  detail?: string | null
}) {
  if (USE_MOCKS) {
    return wait<LearningEvent>({
      id: crypto.randomUUID(),
      type: payload.type,
      xpDelta: payload.xpDelta ?? 0,
      bookId: payload.bookId ?? null,
      deckId: payload.deckId ?? null,
      cardId: payload.cardId ?? null,
      label: payload.label ?? payload.type,
      detail: payload.detail ?? null,
      createdAt: new Date().toISOString(),
    })
  }
  return request<LearningEvent>('/api/learning/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

export async function getBooks() {
  if (USE_MOCKS) {
    return wait<Book[]>([mockLearningHome.continueBook?.book ?? mockReaderPayload.book])
  }
  const payload = await request<{ items: Book[] }>('/api/books')
  return payload.items
}

export async function getBookReader(bookId: string) {
  if (USE_MOCKS) {
    return wait<ReaderPayload>({ ...mockReaderPayload, book: { ...mockReaderPayload.book, id: bookId } })
  }
  return request<ReaderPayload>(`/api/books/${bookId}/reader`)
}

export async function getBookProgress(bookId: string) {
  if (USE_MOCKS) {
    return wait<BookProgress>(mockLearningHome.continueBook?.progress ?? { reading: null, audio: null })
  }
  return request<BookProgress>(`/api/books/${bookId}/progress`)
}

export async function updateReadingProgress(bookId: string, payload: {
  pageNumber: number
  totalPages: number
  textStart: number
  textEnd: number
  textLength: number
  updatedAt?: string
}) {
  if (USE_MOCKS) {
    return wait<BookProgress>({
      reading: { ...payload, updatedAt: payload.updatedAt ?? new Date().toISOString() },
      audio: null,
    })
  }
  return request<BookProgress>(`/api/books/${bookId}/progress/reading`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

export async function updateAudioProgress(bookId: string, payload: {
  audioUrl: string
  currentTime: number
  wasPlaying: boolean
  updatedAt?: string
}) {
  if (USE_MOCKS) {
    return wait<BookProgress>({
      reading: mockLearningHome.continueBook?.progress?.reading ?? null,
      audio: {
        url: payload.audioUrl,
        currentTime: payload.currentTime,
        wasPlaying: payload.wasPlaying,
        updatedAt: payload.updatedAt ?? new Date().toISOString(),
      },
    })
  }
  return request<BookProgress>(`/api/books/${bookId}/progress/audio`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

export async function getProviders() {
  if (USE_MOCKS) {
    return wait<{ defaultNarrationStyle: string; providers: ProviderCatalog[] }>({
      defaultNarrationStyle: '',
      providers: mockProviders,
    })
  }
  return request<{ defaultNarrationStyle: string; providers: ProviderCatalog[] }>('/api/providers')
}

export async function createLiveAudioSegment(
  bookId: string,
  payload: {
    provider: string
    voice?: string | null
    model?: string | null
    output_format: 'mp3' | 'wav'
    narration_style: string
    length_scale: number
    sentence_silence: number
    pageNumber: number
    start: number
    end: number
    text: string
  },
) {
  if (USE_MOCKS) {
    return wait<LiveAudioSegment>({
      provider: 'polly',
      voice: 'Matthew',
      model: null,
      format: payload.output_format,
      url: 'https://www2.cs.uic.edu/~i101/SoundFiles/BabyElephantWalk60.wav',
      start: payload.start,
      end: payload.end,
      pageNumber: payload.pageNumber,
      cached: false,
    })
  }
  return request<LiveAudioSegment>(`/api/books/${bookId}/live-audio`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

export async function createHighlight(
  bookId: string,
  payload: {
    start: number
    end: number
    color: HighlightColor
    kind: HighlightKind
    text: string
    note?: string
  },
) {
  if (USE_MOCKS) {
    return wait<Highlight>({
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      note: payload.note ?? null,
      ...payload,
    })
  }
  return request<Highlight>(`/api/books/${bookId}/highlights`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

export async function deleteHighlight(bookId: string, highlightId: string) {
  if (USE_MOCKS) {
    return wait({ ok: true })
  }
  return request<{ ok: boolean }>(`/api/books/${bookId}/highlights/${highlightId}`, {
    method: 'DELETE',
  })
}

export async function getDecks() {
  if (USE_MOCKS) {
    return wait<VocabularyDeckSummary[]>([mockDeck])
  }
  const payload = await request<{ items: VocabularyDeckSummary[] }>('/api/vocabulary/decks')
  return payload.items
}

export async function createDeck(payload: { title: string; description?: string | null }) {
  if (USE_MOCKS) {
    return wait<VocabularyDeckSummary>({
      ...mockDeck,
      id: crypto.randomUUID().slice(0, 12),
      title: payload.title,
      description: payload.description ?? null,
    })
  }
  return request<VocabularyDeckSummary>('/api/vocabulary/decks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

export async function getDeckDashboard(deckId: string) {
  if (USE_MOCKS) {
    return wait<VocabularyDeckDashboard>({ ...mockDeckDashboard, deck: { ...mockDeckDashboard.deck, id: deckId } })
  }
  return request<VocabularyDeckDashboard>(`/api/vocabulary/decks/${deckId}`)
}

export async function importArchiveItems(
  deckId: string,
  payload: {
    items: Array<{
      sourceId: string
      sourceText: string
      note?: string | null
      bookId: string
      bookTitle: string
      createdAt?: string
    }>
  },
) {
  if (USE_MOCKS) {
    return wait({ imported: payload.items.length })
  }
  return request<{ imported: number }>(`/api/vocabulary/decks/${deckId}/imports/archive`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

export async function createPracticeSession(deckId: string, payload?: {
  focus?: 'mixed' | 'new' | 'weak'
  limit?: number
  cardIds?: string[]
}) {
  if (USE_MOCKS) {
    return wait<VocabularyPracticeSessionPayload>(mockPracticeSession)
  }
  return request<VocabularyPracticeSessionPayload>(`/api/vocabulary/decks/${deckId}/practice-sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  })
}

export async function getSession(deckId: string, params?: { avoidNoteId?: string; avoidTopic?: string }) {
  if (USE_MOCKS) {
    return wait<VocabularySessionPayload>({
      deck: mockDeck,
      summary: mockDeck,
      currentCard: mockPracticeSession.items[0] ?? null,
    })
  }
  const query = new URLSearchParams()
  if (params?.avoidNoteId) {
    query.set('avoidNoteId', params.avoidNoteId)
  }
  if (params?.avoidTopic) {
    query.set('avoidTopic', params.avoidTopic)
  }
  const suffix = query.toString() ? `?${query.toString()}` : ''
  return request<VocabularySessionPayload>(`/api/vocabulary/decks/${deckId}/session${suffix}`)
}

export async function submitReview(cardId: string, payload: {
  rating: 'again' | 'hard' | 'good' | 'easy'
  responseMs?: number
  answerMode?: 'typed' | 'self_report' | 'reveal'
  typedResponse?: string
}) {
  if (USE_MOCKS) {
    return wait<VocabularyReviewResult>({
      reviewedCard: mockPracticeSession.items[0],
      summary: mockDeck,
      nextCard: mockPracticeSession.items[1] ?? null,
    })
  }
  return request<VocabularyReviewResult>(`/api/vocabulary/cards/${cardId}/reviews`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

export async function generateVocabularyLesson(cardId: string) {
  if (USE_MOCKS) {
    return wait(mockLessonPlan)
  }
  return request<VocabularyLessonPlan>(`/api/vocabulary/cards/${cardId}/lesson`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
}

export async function coachCard(cardId: string, payload: {
  mode: 'review' | 'lesson'
  step: 'answer' | 'retry' | 'usage'
  turnIndex: number
  learnerResponse?: string | null
  history?: Array<{ role: 'assistant' | 'learner'; text: string; step: string }>
}) {
  if (USE_MOCKS) {
    return wait<VocabularyCoachResponse>({
      provider: 'fallback',
      feedbackTitle: payload.mode === 'review' ? 'Close enough to rate.' : 'Lesson response is grounded.',
      feedbackBody:
        payload.mode === 'review'
          ? 'You captured the emotional direction. Tighten the wording if you want a cleaner recall.'
          : 'You connected the scene to the definition without copying the card.',
      correction: mockPracticeSession.items[0].answer,
      nextPrompt: payload.mode === 'review' ? 'Choose a rating when you are ready.' : 'Write the production sentences.',
      suggestedRating: 'good',
      canRate: true,
      verdict: 'close',
      turnCount: payload.turnIndex,
      context: {
        source: 'dictionary_fallback',
        contextTitle: 'Scene anchor',
        contextParagraph: 'The corridor stays cold, hostile, and emotionally thin.',
        usageFocus: ['tone', 'plain meaning'],
      },
    })
  }
  return request<VocabularyCoachResponse>(`/api/vocabulary/cards/${cardId}/coach`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

export async function submitProduction(cardId: string, payload: { sentences: string[] }) {
  if (USE_MOCKS) {
    return wait<VocabularyProductionResult>({
      accepted: true,
      feedback: 'The sentences are distinct and believable.',
      sentenceNotes: ['Sentence 1 lands the meaning quickly.', 'Sentence 2 uses the word in a plausible scene.'],
    })
  }
  return request<VocabularyProductionResult>(`/api/vocabulary/cards/${cardId}/production`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

export async function uploadBook(file: File, title?: string | null) {
  if (USE_MOCKS) {
    return wait<Book>(
      {
        ...mockReaderPayload.book,
        id: crypto.randomUUID().slice(0, 12),
        title: title?.trim() || file.name.replace(/\.pdf$/i, ''),
        fileName: file.name,
      },
      500,
    )
  }

  const formData = new FormData()
  formData.append('file', file)
  if (title?.trim()) {
    formData.append('title', title.trim())
  }

  return request<Book>('/api/books', {
    method: 'POST',
    body: formData,
  })
}

export async function deleteBook(bookId: string) {
  if (USE_MOCKS) {
    return wait({ ok: true })
  }
  return request<{ ok: boolean }>(`/api/books/${bookId}`, { method: 'DELETE' })
}

export async function testProvider(payload: {
  provider: ProviderCatalog['id']
  voice?: string | null
  model?: string | null
  sampleText: string
  outputFormat: 'mp3' | 'wav'
  narrationStyle: string
  lengthScale: number
  sentenceSilence: number
}) {
  if (USE_MOCKS) {
    return wait<ProviderTestResult>({
      provider: payload.provider,
      voice: payload.voice ?? null,
      model: payload.model ?? null,
      sampleText: payload.sampleText,
      audioUrl: 'https://www2.cs.uic.edu/~i101/SoundFiles/BabyElephantWalk60.wav',
      message: 'Preview rendered in mock mode.',
    })
  }
  return request<ProviderTestResult>('/api/providers/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: payload.provider,
      voice: payload.voice ?? undefined,
      model: payload.model ?? undefined,
      sampleText: payload.sampleText,
      output_format: payload.outputFormat,
      narration_style: payload.narrationStyle,
      length_scale: payload.lengthScale,
      sentence_silence: payload.sentenceSilence,
    }),
  })
}
