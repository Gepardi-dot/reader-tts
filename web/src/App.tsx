import { Suspense, lazy, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import './App.css'
import { HighlightsShelf } from './components/HighlightsShelf'
import { LibraryCover } from './components/LibraryCover'
import { ReaderDesk } from './components/ReaderDesk'
import { paginateReaderText } from './components/readerPagination'
import type {
  Book,
  BookProgress,
  Highlight,
  JobStatus,
  LiveAudioSegment,
  PollyHealth,
  ProviderCatalog,
  ProviderTestResult,
  ReaderPayload,
  ReadingProgress,
  StoredAudioProgress,
  VoiceOption,
} from './types'
import {
  apiRequest,
  cancelJob,
  clearBookAudioProgress,
  createLiveAudioSegment,
  createHighlight,
  deleteBook,
  deleteHighlight,
  fetchBookProgress,
  fetchBookReader,
  fetchBooks,
  fetchPollyHealth,
  fetchProviders,
  testProvider,
  updateBookAudioProgress,
  updateBookReadingProgress,
} from './api'

const BookStage = lazy(async () =>
  import('./components/BookStage').then((module) => ({ default: module.BookStage })),
)

type ReaderTab = 'reader' | 'pdf' | 'highlights'
type AppRoute = { kind: 'library' } | { kind: 'book'; bookId: string }

type StoredSession = {
  lastRoute: AppRoute
  readerTabs: Record<string, ReaderTab>
}

type StoredUiPreferences = {
  readerForm: ReaderForm
  readerFontScales: Record<string, number>
}

type SentenceCue = {
  start: number
  end: number
  text: string
}

type SpokenRange = {
  start: number
  end: number
  text: string
}

type ReaderForm = {
  provider: 'piper' | 'google' | 'openai' | 'polly'
  voice: string
  model: string
  outputFormat: 'mp3' | 'm4b' | 'wav'
  narrationStyle: string
  lengthScale: number
  sentenceSilence: number
}

type LivePlaybackMode = 'page' | 'selection' | null

type LivePlaybackRequest = {
  pageNumber: number
  start: number
  end: number
  text: string
}

const initialForm: ReaderForm = {
  provider: 'piper',
  voice: '',
  model: '',
  outputFormat: 'mp3',
  narrationStyle: '',
  lengthScale: 1,
  sentenceSilence: 0.2,
}

const READING_PROGRESS_KEY = 'storybook-reader-progress'
const SESSION_STATE_KEY = 'storybook-reader-session'
const AUDIO_PROGRESS_KEY = 'storybook-audio-progress'
const UI_PREFERENCES_KEY = 'storybook-ui-preferences'
const LIVE_PREFETCH_PAGES = 2

function formatDate(iso: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(iso))
}

function upsertBook(collection: Book[], incoming: Book) {
  const others = collection.filter((book) => book.id !== incoming.id)
  return [incoming, ...others].sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt))
}

function patchBook(collection: Book[], bookId: string, changes: Partial<Book>) {
  return collection.map((book) => (book.id === bookId ? { ...book, ...changes } : book))
}

function chunkItems<T>(items: T[], size: number) {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}

function parseRoute(pathname: string): AppRoute {
  const match = pathname.match(/^\/book\/([^/]+)$/)
  if (match) {
    return { kind: 'book', bookId: decodeURIComponent(match[1]) }
  }
  return { kind: 'library' }
}

function readStoredProgress(): Record<string, ReadingProgress> {
  if (typeof window === 'undefined') {
    return {}
  }

  try {
    const raw = window.localStorage.getItem(READING_PROGRESS_KEY)
    if (!raw) {
      return {}
    }
    return JSON.parse(raw) as Record<string, ReadingProgress>
  } catch {
    return {}
  }
}

function readStoredSession(): StoredSession {
  if (typeof window === 'undefined') {
    return {
      lastRoute: { kind: 'library' },
      readerTabs: {},
    }
  }

  try {
    const raw = window.localStorage.getItem(SESSION_STATE_KEY)
    if (!raw) {
      return {
        lastRoute: { kind: 'library' },
        readerTabs: {},
      }
    }

    const parsed = JSON.parse(raw) as Partial<StoredSession>
    return {
      lastRoute: parsed.lastRoute && parsed.lastRoute.kind === 'book'
        ? { kind: 'book', bookId: parsed.lastRoute.bookId }
        : { kind: 'library' },
      readerTabs: parsed.readerTabs ?? {},
    }
  } catch {
    return {
      lastRoute: { kind: 'library' },
      readerTabs: {},
    }
  }
}

function readStoredAudioProgress(): Record<string, StoredAudioProgress> {
  if (typeof window === 'undefined') {
    return {}
  }

  try {
    const raw = window.localStorage.getItem(AUDIO_PROGRESS_KEY)
    if (!raw) {
      return {}
    }
    return JSON.parse(raw) as Record<string, StoredAudioProgress>
  } catch {
    return {}
  }
}

function isStoredProvider(value: unknown): value is ReaderForm['provider'] {
  return value === 'piper' || value === 'google' || value === 'openai' || value === 'polly'
}

function isStoredOutputFormat(value: unknown): value is ReaderForm['outputFormat'] {
  return value === 'mp3' || value === 'm4b' || value === 'wav'
}

function clampPreference(value: unknown, minimum: number, maximum: number, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback
}

function readStoredUiPreferences(): StoredUiPreferences {
  const fallback: StoredUiPreferences = {
    readerForm: initialForm,
    readerFontScales: {},
  }

  if (typeof window === 'undefined') {
    return fallback
  }

  try {
    const raw = window.localStorage.getItem(UI_PREFERENCES_KEY)
    if (!raw) {
      return fallback
    }

    const parsed = JSON.parse(raw) as Partial<StoredUiPreferences> & {
      readerForm?: Partial<ReaderForm>
    }
    const readerForm: Partial<ReaderForm> = parsed.readerForm ?? {}
    const readerFontScales: Record<string, number> = {}

    for (const [bookId, value] of Object.entries(parsed.readerFontScales ?? {})) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        continue
      }
      readerFontScales[bookId] = clampPreference(value, 0.9, 1.25, 1)
    }

    return {
      readerForm: {
        provider: isStoredProvider(readerForm.provider) ? readerForm.provider : initialForm.provider,
        voice: typeof readerForm.voice === 'string' ? readerForm.voice : initialForm.voice,
        model: typeof readerForm.model === 'string' ? readerForm.model : initialForm.model,
        outputFormat: isStoredOutputFormat(readerForm.outputFormat)
          ? readerForm.outputFormat
          : initialForm.outputFormat,
        narrationStyle:
          typeof readerForm.narrationStyle === 'string'
            ? readerForm.narrationStyle
            : initialForm.narrationStyle,
        lengthScale: clampPreference(readerForm.lengthScale, 0.6, 1.5, initialForm.lengthScale),
        sentenceSilence: clampPreference(readerForm.sentenceSilence, 0, 1, initialForm.sentenceSilence),
      },
      readerFontScales,
    }
  } catch {
    return fallback
  }
}

function writeStoredValue(key: string, value: unknown) {
  if (typeof window === 'undefined') {
    return
  }

  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Ignore localStorage failures and keep the UI usable.
  }
}

function progressTimestamp(value: { updatedAt: string } | null | undefined) {
  if (!value) {
    return 0
  }

  const parsed = Date.parse(value.updatedAt)
  return Number.isFinite(parsed) ? parsed : 0
}

function pickNewestProgress<T extends { updatedAt: string }>(localValue: T | null | undefined, remoteValue: T | null | undefined) {
  if (!localValue) {
    return remoteValue ?? null
  }

  if (!remoteValue) {
    return localValue
  }

  return progressTimestamp(remoteValue) > progressTimestamp(localValue) ? remoteValue : localValue
}

function sameReadingProgress(left: ReadingProgress | null | undefined, right: ReadingProgress | null | undefined) {
  if (!left || !right) {
    return left === right
  }

  return (
    left.pageNumber === right.pageNumber &&
    left.totalPages === right.totalPages &&
    left.textStart === right.textStart &&
    left.textEnd === right.textEnd &&
    left.textLength === right.textLength &&
    left.updatedAt === right.updatedAt
  )
}

function sameReadingPosition(left: ReadingProgress | null | undefined, right: ReadingProgress | null | undefined) {
  if (!left || !right) {
    return left === right
  }

  return (
    left.pageNumber === right.pageNumber &&
    left.totalPages === right.totalPages &&
    left.textStart === right.textStart &&
    left.textEnd === right.textEnd &&
    left.textLength === right.textLength
  )
}

function sameStoredAudioProgress(left: StoredAudioProgress | null | undefined, right: StoredAudioProgress | null | undefined) {
  if (!left || !right) {
    return left === right
  }

  return (
    left.url === right.url &&
    left.currentTime === right.currentTime &&
    left.wasPlaying === right.wasPlaying &&
    left.updatedAt === right.updatedAt
  )
}

function readInitialRoute(pathname: string): AppRoute {
  const explicitRoute = parseRoute(pathname)
  if (explicitRoute.kind === 'book') {
    return explicitRoute
  }

  return readStoredSession().lastRoute
}

function getLibraryColumns() {
  if (typeof window === 'undefined') {
    return 3
  }
  if (window.innerWidth <= 720) {
    return 1
  }
  if (window.innerWidth <= 1120) {
    return 2
  }
  return 3
}

function trimTextRange(text: string, start: number, end: number) {
  let nextStart = start
  let nextEnd = end

  while (nextStart < nextEnd && /\s/.test(text[nextStart] ?? '')) {
    nextStart += 1
  }

  while (nextEnd > nextStart && /\s/.test(text[nextEnd - 1] ?? '')) {
    nextEnd -= 1
  }

  return { start: nextStart, end: nextEnd }
}

function buildSentenceCues(text: string) {
  if (!text.trim()) {
    return [] as SentenceCue[]
  }

  const boundaryPattern = /(?:[.!?]["')\]]*(?=\s+|$))|\n{2,}/g
  const cues: SentenceCue[] = []
  let cursor = 0

  for (const match of text.matchAll(boundaryPattern)) {
    const boundaryStart = match.index ?? 0
    const boundaryEnd = boundaryStart + match[0].length
    const trimmed = trimTextRange(text, cursor, boundaryEnd)

    if (trimmed.end > trimmed.start) {
      cues.push({
        start: trimmed.start,
        end: trimmed.end,
        text: text.slice(trimmed.start, trimmed.end),
      })
    }

    cursor = boundaryEnd
  }

  const tail = trimTextRange(text, cursor, text.length)
  if (tail.end > tail.start) {
    cues.push({
      start: tail.start,
      end: tail.end,
      text: text.slice(tail.start, tail.end),
    })
  }

  return cues
}

function findSentenceCueAtOffset(cues: SentenceCue[], offset: number) {
  let low = 0
  let high = cues.length - 1

  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const cue = cues[middle]

    if (offset < cue.start) {
      high = middle - 1
      continue
    }

    if (offset >= cue.end) {
      low = middle + 1
      continue
    }

    return cue
  }

  if (!cues.length) {
    return null
  }

  return cues[Math.max(0, Math.min(low, cues.length - 1))]
}

function formatPlaybackTime(seconds: number) {
  const totalSeconds = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const remainingSeconds = totalSeconds % 60

  if (hours > 0) {
    return [hours, minutes, remainingSeconds]
      .map((value, index) => (index === 0 ? String(value) : String(value).padStart(2, '0')))
      .join(':')
  }

  return [minutes, remainingSeconds]
    .map((value) => String(value).padStart(2, '0'))
    .join(':')
}

function summarizeSelection(text: string, limit = 52) {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return 'your selection'
  }

  if (normalized.length <= limit) {
    return `"${normalized}"`
  }

  return `"${normalized.slice(0, Math.max(0, limit - 3)).trimEnd()}..."`
}

function voiceGenderLabel(voice: VoiceOption) {
  if (voice.gender === 'female') {
    return voice.genderSource === 'estimated' ? 'Female*' : 'Female'
  }
  if (voice.gender === 'male') {
    return voice.genderSource === 'estimated' ? 'Male*' : 'Male'
  }
  if (voice.gender === 'neutral') {
    return voice.genderSource === 'estimated' ? 'Neutral*' : 'Neutral'
  }
  return null
}

export default function App() {
  const [books, setBooks] = useState<Book[]>([])
  const [providers, setProviders] = useState<ProviderCatalog[]>([])
  const [route, setRoute] = useState<AppRoute>(() => readInitialRoute(window.location.pathname))
  const [readerTabs, setReaderTabs] = useState<Record<string, ReaderTab>>(() => readStoredSession().readerTabs)
  const [readingProgress, setReadingProgress] = useState<Record<string, ReadingProgress>>(() =>
    readStoredProgress(),
  )
  const [libraryColumns, setLibraryColumns] = useState<number>(() => getLibraryColumns())
  const [form, setForm] = useState<ReaderForm>(() => readStoredUiPreferences().readerForm)
  const [readerFontScales, setReaderFontScales] = useState<Record<string, number>>(
    () => readStoredUiPreferences().readerFontScales,
  )
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [statusMessage, setStatusMessage] = useState<string>('')
  const [errorMessage, setErrorMessage] = useState<string>('')
  const [activeJob, setActiveJob] = useState<JobStatus | null>(null)
  const [testingProvider, setTestingProvider] = useState(false)
  const [previewingVoiceId, setPreviewingVoiceId] = useState<string | null>(null)
  const [providerSample, setProviderSample] = useState<ProviderTestResult | null>(null)
  const [pollyHealth, setPollyHealth] = useState<PollyHealth | null>(null)
  const [pollyHealthLoading, setPollyHealthLoading] = useState(false)
  const [readerPayload, setReaderPayload] = useState<ReaderPayload | null>(null)
  const [readerLoading, setReaderLoading] = useState(false)
  const [readerTab, setReaderTab] = useState<ReaderTab>('reader')
  const [narrationOpen, setNarrationOpen] = useState(false)
  const [removingHighlightId, setRemovingHighlightId] = useState<string | null>(null)
  const [deletingBookId, setDeletingBookId] = useState<string | null>(null)
  const [cancellingJob, setCancellingJob] = useState(false)
  const [audioDockOpen, setAudioDockOpen] = useState(false)
  const [audioJumpMessage, setAudioJumpMessage] = useState('')
  const [pendingAudioSeek, setPendingAudioSeek] = useState<number | null>(null)
  const [pendingAudioPlay, setPendingAudioPlay] = useState(false)
  const [spokenRange, setSpokenRange] = useState<SpokenRange | null>(null)
  const [liveAudioMode, setLiveAudioMode] = useState<LivePlaybackMode>(null)
  const [liveAudioLoading, setLiveAudioLoading] = useState(false)
  const [liveAudioCurrent, setLiveAudioCurrent] = useState<LiveAudioSegment | null>(null)
  const [liveAudioQueue, setLiveAudioQueue] = useState<LiveAudioSegment[]>([])
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null)
  const storedAudioProgressRef = useRef<Record<string, StoredAudioProgress>>(readStoredAudioProgress())
  const restoreAudioProgressRef = useRef<StoredAudioProgress | null>(null)
  const pageHidePersistRef = useRef<() => void>(() => {})
  const skipDisplayedPageSyncOnNextPlayRef = useRef(false)
  const lastRemoteReadingSyncRef = useRef<Record<string, ReadingProgress | null>>({})
  const lastRemoteAudioSyncRef = useRef<Record<string, StoredAudioProgress | null>>({})
  const liveSessionIdRef = useRef(0)
  const liveNextPageIndexRef = useRef(0)
  const livePrefetchingRef = useRef(false)
  const liveAudioCurrentRef = useRef<LiveAudioSegment | null>(null)
  const liveAudioQueueRef = useRef<LiveAudioSegment[]>([])
  const liveRequestConfigRef = useRef<{
    provider: ReaderForm['provider']
    voice?: string
    model?: string
    narrationStyle: string
    lengthScale: number
    sentenceSilence: number
  } | null>(null)

  const selectedBookId = route.kind === 'book' ? route.bookId : ''
  const selectedBook = route.kind === 'book' ? books.find((book) => book.id === route.bookId) ?? null : null
  const currentProvider =
    providers.find((provider) => provider.id === form.provider) ?? providers[0] ?? null
  const sentenceCues = useMemo(() => buildSentenceCues(readerPayload?.text ?? ''), [readerPayload?.text])
  const readerPages = useMemo(() => paginateReaderText(readerPayload?.text ?? ''), [readerPayload?.text])
  const currentAudioSrc =
    liveAudioMode !== null ? liveAudioCurrent?.url : selectedBook?.latestAudio?.url
  const selectedReaderFontScale = selectedBookId ? readerFontScales[selectedBookId] ?? 1 : 1

  useEffect(() => {
    liveAudioCurrentRef.current = liveAudioCurrent
  }, [liveAudioCurrent])

  useEffect(() => {
    liveAudioQueueRef.current = liveAudioQueue
  }, [liveAudioQueue])

  function cancelLivePlayback() {
    audioPlayerRef.current?.pause()
    liveSessionIdRef.current += 1
    liveNextPageIndexRef.current = 0
    livePrefetchingRef.current = false
    liveRequestConfigRef.current = null
    liveAudioCurrentRef.current = null
    liveAudioQueueRef.current = []
    setLiveAudioMode(null)
    setLiveAudioLoading(false)
    setLiveAudioCurrent(null)
    setLiveAudioQueue([])
    setPendingAudioPlay(false)
    setPendingAudioSeek(null)
  }

  function livePageRequestAtIndex(pageIndex: number): LivePlaybackRequest | null {
    const page = readerPages[pageIndex]
    if (!page) {
      return null
    }

    return {
      pageNumber: pageIndex + 1,
      start: page.start,
      end: page.end,
      text: page.text,
    }
  }

  function liveRequestFromSelection(start: number) {
    const pageIndex = findReaderPageIndexForOffset(start)
    if (pageIndex < 0) {
      return null
    }

    const page = readerPages[pageIndex]
    const text = readerPayload?.text ?? ''
    const requestStart = Math.max(page.start, start)
    const requestEnd = page.end
    if (!text || requestEnd <= requestStart) {
      return null
    }

    return {
      pageIndex,
      request: {
        pageNumber: pageIndex + 1,
        start: requestStart,
        end: requestEnd,
        text: text.slice(requestStart, requestEnd),
      } satisfies LivePlaybackRequest,
    }
  }

  function findReaderPageIndexForOffset(offset: number) {
    for (let index = 0; index < readerPages.length; index += 1) {
      const page = readerPages[index]
      if (offset >= page.start && offset < page.end) {
        return index
      }
    }

    return readerPages.length ? readerPages.length - 1 : -1
  }

  function syncReaderToPage(pageNumber: number) {
    if (!selectedBookId) {
      return
    }

    const page = readerPages[pageNumber - 1]
    if (!page) {
      return
    }

    updateReadingProgress(selectedBookId, {
      pageNumber,
      totalPages: readerPages.length,
      textStart: page.start,
      textEnd: page.end,
      textLength: readerPayload?.text.length ?? page.end,
    })
  }

  async function requestLiveAudio(request: LivePlaybackRequest) {
    if (!selectedBookId) {
      throw new Error('Open a book first.')
    }

    const config = liveRequestConfigRef.current
    if (!config) {
      throw new Error('Live audio settings are unavailable.')
    }

    return createLiveAudioSegment(selectedBookId, {
      provider: config.provider,
      voice: config.voice,
      model: config.model,
      output_format: 'mp3',
      narration_style: config.narrationStyle,
      length_scale: config.lengthScale,
      sentence_silence: config.sentenceSilence,
      pageNumber: request.pageNumber,
      start: request.start,
      end: request.end,
      text: request.text,
    })
  }

  function activateLiveSegment(segment: LiveAudioSegment, message: string) {
    setLiveAudioLoading(false)
    setLiveAudioCurrent(segment)
    liveAudioCurrentRef.current = segment
    setPendingAudioSeek(null)
    setPendingAudioPlay(true)
    setAudioDockOpen(true)
    setAudioJumpMessage(message)
    setStatusMessage(message)
    setErrorMessage('')
    syncReaderToPage(segment.pageNumber)
  }

  async function prefetchLiveSegments(sessionId: number) {
    if (livePrefetchingRef.current || !liveRequestConfigRef.current) {
      return
    }

    livePrefetchingRef.current = true

    try {
      while (
        sessionId === liveSessionIdRef.current &&
        liveAudioQueueRef.current.length < LIVE_PREFETCH_PAGES &&
        liveNextPageIndexRef.current < readerPages.length
      ) {
        const request = livePageRequestAtIndex(liveNextPageIndexRef.current)
        liveNextPageIndexRef.current += 1
        if (!request) {
          continue
        }

        const segment = await requestLiveAudio(request)
        if (sessionId !== liveSessionIdRef.current) {
          return
        }

        setLiveAudioQueue((previous) => {
          const next = [...previous, segment]
          liveAudioQueueRef.current = next
          return next
        })
      }
    } catch (error) {
      if (sessionId === liveSessionIdRef.current) {
        setErrorMessage(error instanceof Error ? error.message : 'Live audio prefetch failed.')
      }
    } finally {
      livePrefetchingRef.current = false
    }
  }

  async function startLivePlayback(
    request: LivePlaybackRequest,
    options: {
      mode: Exclude<LivePlaybackMode, null>
      label: string
      nextPageIndex: number
    },
  ) {
    if (!selectedBook || !readerPages.length) {
      setErrorMessage('Open a book with extracted reader text first.')
      return
    }

    if (!currentProvider?.available || !voiceOptions.length) {
      setErrorMessage('Choose a ready voice provider in Audio controls before starting Live read.')
      return
    }

    cancelLivePlayback()
    const sessionId = liveSessionIdRef.current
    liveNextPageIndexRef.current = options.nextPageIndex
    liveRequestConfigRef.current = {
      provider: form.provider,
      voice: form.voice || undefined,
      model: form.model || undefined,
      narrationStyle: form.narrationStyle,
      lengthScale: form.lengthScale,
      sentenceSilence: form.sentenceSilence,
    }

    restoreAudioProgressRef.current = null
    setLiveAudioMode(options.mode)
    setLiveAudioLoading(true)
    setNarrationOpen(false)
    setAudioDockOpen(true)
    setAudioJumpMessage(`Generating live audio for ${options.label}...`)
    setStatusMessage(`Generating live audio for ${options.label}...`)
    setErrorMessage('')

    try {
      const segment = await requestLiveAudio(request)
      if (sessionId !== liveSessionIdRef.current) {
        return
      }

      activateLiveSegment(segment, `Reading ${options.label} now.`)
      if (options.nextPageIndex < readerPages.length) {
        void prefetchLiveSegments(sessionId)
      }
    } catch (error) {
      if (sessionId !== liveSessionIdRef.current) {
        return
      }

      setLiveAudioMode(null)
      setLiveAudioLoading(false)
      setLiveAudioCurrent(null)
      setLiveAudioQueue([])
      setErrorMessage(error instanceof Error ? error.message : 'Live audio could not be generated.')
    }
  }

  function primeSavedAudioProgress(bookId: string, latestAudioUrl: string | null | undefined) {
    restoreAudioProgressRef.current = null

    if (!latestAudioUrl) {
      return
    }

    const savedProgress = storedAudioProgressRef.current[bookId]
    if (!savedProgress || savedProgress.url !== latestAudioUrl || savedProgress.currentTime <= 0.5) {
      return
    }

    restoreAudioProgressRef.current = savedProgress
    setAudioDockOpen(true)
    setAudioJumpMessage(
      savedProgress.wasPlaying
        ? `Resuming from ${formatPlaybackTime(savedProgress.currentTime)}.`
        : `Ready at ${formatPlaybackTime(savedProgress.currentTime)}.`,
    )
  }

  function syncReadingProgressToServer(
    bookId: string,
    progress: ReadingProgress,
    options?: { force?: boolean; keepalive?: boolean },
  ) {
    const previous = lastRemoteReadingSyncRef.current[bookId] ?? null
    if (!options?.force && previous && sameReadingPosition(previous, progress)) {
      return
    }

    lastRemoteReadingSyncRef.current = {
      ...lastRemoteReadingSyncRef.current,
      [bookId]: progress,
    }

    void updateBookReadingProgress(
      bookId,
      {
        pageNumber: progress.pageNumber,
        totalPages: progress.totalPages,
        textStart: progress.textStart ?? 0,
        textEnd: progress.textEnd ?? 0,
        textLength: progress.textLength ?? 0,
        updatedAt: progress.updatedAt,
      },
      { keepalive: options?.keepalive },
    ).catch((error) => {
      console.error('Failed to sync reading progress.', error)
      const next = { ...lastRemoteReadingSyncRef.current }
      delete next[bookId]
      lastRemoteReadingSyncRef.current = next
    })
  }

  function syncAudioProgressToServer(
    bookId: string,
    progress: StoredAudioProgress | null,
    options?: { force?: boolean; keepalive?: boolean },
  ) {
    const previous = lastRemoteAudioSyncRef.current[bookId] ?? null
    if (
      !options?.force &&
      progress &&
      previous &&
      previous.url === progress.url &&
      previous.wasPlaying === progress.wasPlaying &&
      Math.abs(previous.currentTime - progress.currentTime) < 5
    ) {
      return
    }

    if (!options?.force && !progress && previous === null) {
      return
    }

    lastRemoteAudioSyncRef.current = {
      ...lastRemoteAudioSyncRef.current,
      [bookId]: progress,
    }

    const request = progress
      ? updateBookAudioProgress(
          bookId,
          {
            audioUrl: progress.url,
            currentTime: progress.currentTime,
            wasPlaying: progress.wasPlaying,
            updatedAt: progress.updatedAt,
          },
          { keepalive: options?.keepalive },
        )
      : clearBookAudioProgress(bookId, { keepalive: options?.keepalive })

    void request.catch((error) => {
      console.error('Failed to sync audio progress.', error)
      const next = { ...lastRemoteAudioSyncRef.current }
      delete next[bookId]
      lastRemoteAudioSyncRef.current = next
    })
  }

  const loadReaderPayload = useEffectEvent(async (bookId: string) => {
    try {
      setReaderLoading(true)
      const [payload, progressResult] = await Promise.all([
        fetchBookReader(bookId),
        fetchBookProgress(bookId)
          .then((progress) => ({ ok: true as const, progress }))
          .catch((error) => ({ ok: false as const, error })),
      ])

      const remoteProgress: BookProgress = progressResult.ok
        ? progressResult.progress
        : { reading: null, audio: null }
      const latestAudioUrl = payload.book.latestAudio?.url ?? null
      const normalizeAudioProgress = (progress: StoredAudioProgress | null) =>
        latestAudioUrl && progress?.url === latestAudioUrl ? progress : null
      const remoteAudio = normalizeAudioProgress(remoteProgress.audio)
      if (progressResult.ok) {
        lastRemoteReadingSyncRef.current = {
          ...lastRemoteReadingSyncRef.current,
          [bookId]: remoteProgress.reading,
        }
        lastRemoteAudioSyncRef.current = {
          ...lastRemoteAudioSyncRef.current,
          [bookId]: remoteAudio,
        }
      } else {
        console.error('Failed to fetch remote progress.', progressResult.error)
      }

      const localReading = readingProgress[bookId] ?? null
      const mergedReading = pickNewestProgress(localReading, remoteProgress.reading)
      if (mergedReading && !sameReadingProgress(localReading, mergedReading)) {
        setReadingProgress((previous) =>
          sameReadingProgress(previous[bookId] ?? null, mergedReading)
            ? previous
            : {
                ...previous,
                [bookId]: mergedReading,
              },
        )
      }
      if (
        progressResult.ok &&
        localReading &&
        mergedReading === localReading &&
        (!remoteProgress.reading || progressTimestamp(localReading) > progressTimestamp(remoteProgress.reading))
      ) {
        syncReadingProgressToServer(bookId, localReading, { force: true })
      }

      const rawLocalAudio = storedAudioProgressRef.current[bookId] ?? null
      const localAudio = normalizeAudioProgress(rawLocalAudio)
      if (rawLocalAudio && !localAudio) {
        storeAudioProgress(bookId, null, { syncRemote: false })
      }
      if (progressResult.ok && remoteProgress.audio && !remoteAudio) {
        syncAudioProgressToServer(bookId, null, { force: true })
      }

      const mergedAudio = pickNewestProgress(localAudio, remoteAudio)
      if (!sameStoredAudioProgress(localAudio, mergedAudio)) {
        storeAudioProgress(bookId, mergedAudio, { syncRemote: false })
      }
      if (
        progressResult.ok &&
        localAudio &&
        mergedAudio === localAudio &&
        (!remoteAudio || progressTimestamp(localAudio) > progressTimestamp(remoteAudio))
      ) {
        syncAudioProgressToServer(bookId, localAudio, { force: true })
      }

      setReaderPayload(payload)
      setBooks((previous) => upsertBook(previous, payload.book))
      primeSavedAudioProgress(bookId, latestAudioUrl)
    } catch (error) {
      setReaderPayload(null)
      setErrorMessage(error instanceof Error ? error.message : 'Failed to open this book in reader mode.')
    } finally {
      setReaderLoading(false)
    }
  })

  useEffect(() => {
    void bootstrap()
  }, [])

  useEffect(() => {
    const handlePopState = () => setRoute(parseRoute(window.location.pathname))
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  useEffect(() => {
    const handleResize = () => setLibraryColumns(getLibraryColumns())
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  useEffect(() => {
    window.localStorage.setItem(READING_PROGRESS_KEY, JSON.stringify(readingProgress))
  }, [readingProgress])

  useEffect(() => {
    writeStoredValue(SESSION_STATE_KEY, {
      lastRoute: route,
      readerTabs,
    } satisfies StoredSession)
  }, [readerTabs, route])

  useEffect(() => {
    writeStoredValue(UI_PREFERENCES_KEY, {
      readerForm: form,
      readerFontScales,
    } satisfies StoredUiPreferences)
  }, [form, readerFontScales])

  useEffect(() => {
    if (!selectedBookId) {
      setReaderTab('reader')
      return
    }

    setReaderTab(readerTabs[selectedBookId] ?? 'reader')
  }, [readerTabs, selectedBookId])

  useEffect(() => {
    if (!selectedBookId) {
      return
    }

    setReaderTabs((previous) =>
      previous[selectedBookId] === readerTab
        ? previous
        : {
            ...previous,
            [selectedBookId]: readerTab,
          },
    )
  }, [readerTab, selectedBookId])

  useEffect(() => {
    if (!currentProvider) {
      return
    }

    const nextVoice =
      form.voice && currentProvider.voices.some((voice) => voice.id === form.voice)
        ? form.voice
        : currentProvider.defaultVoice ?? ''
    const nextModel =
      form.model && currentProvider.models.some((model) => model.id === form.model)
        ? form.model
        : currentProvider.defaultModel ?? ''

    if (nextVoice !== form.voice || nextModel !== form.model) {
      setForm((previous) => ({
        ...previous,
        voice: nextVoice,
        model: nextModel,
      }))
    }
  }, [currentProvider, form.model, form.voice])

  useEffect(() => {
    setProviderSample(null)
  }, [form.provider, form.voice, form.model, form.narrationStyle, form.lengthScale, form.sentenceSilence])

  useEffect(() => {
    if (form.provider !== 'polly') {
      return
    }

    void loadPollyHealth()
  }, [form.provider])

  useEffect(() => {
    if (!selectedBookId) {
      setReaderPayload(null)
      return
    }

    void loadReaderPayload(selectedBookId)
  }, [selectedBookId])

  useEffect(() => {
    const handlePageHide = () => pageHidePersistRef.current()

    window.addEventListener('pagehide', handlePageHide)
    window.addEventListener('beforeunload', handlePageHide)

    return () => {
      window.removeEventListener('pagehide', handlePageHide)
      window.removeEventListener('beforeunload', handlePageHide)
    }
  }, [])

  useEffect(() => {
    cancelLivePlayback()
    setAudioDockOpen(false)
    setAudioJumpMessage('')
    setPendingAudioSeek(null)
    setPendingAudioPlay(false)
    setSpokenRange(null)
    restoreAudioProgressRef.current = null

    if (!selectedBookId) {
      return
    }

    primeSavedAudioProgress(selectedBookId, selectedBook?.latestAudio?.url)
  }, [selectedBookId, selectedBook?.latestAudio?.url])

  useEffect(() => {
    if (
      !activeJob ||
      activeJob.status === 'completed' ||
      activeJob.status === 'failed' ||
      activeJob.status === 'cancelled'
    ) {
      return
    }

    const timer = window.setTimeout(async () => {
      try {
        const next = await apiRequest<JobStatus>(`/api/jobs/${activeJob.id}`)
        const completedBook = next.result?.book
        setActiveJob(next)
        if (next.status === 'completed' && completedBook) {
          setBooks((previous) => upsertBook(previous, completedBook))
          setReaderPayload((previous) =>
            previous && previous.book.id === completedBook.id
              ? { ...previous, book: completedBook }
              : previous,
          )
        }
        if (next.status === 'cancelled') {
          setStatusMessage(next.message)
        }
        if (next.status === 'failed' && next.error) {
          setErrorMessage(next.error)
        }
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : 'Failed to refresh job status.')
      }
    }, 1500)

    return () => window.clearTimeout(timer)
  }, [activeJob])

  useEffect(() => {
    if (loading || route.kind !== 'book') {
      return
    }

    if (books.some((book) => book.id === route.bookId)) {
      return
    }

    window.history.replaceState({}, '', '/')
    setRoute({ kind: 'library' })
    setStatusMessage('Returned to the library because the last open book is no longer available.')
  }, [books, loading, route])

  async function bootstrap() {
    try {
      setLoading(true)
      const [providerResponse, bookResponse] = await Promise.all([
        fetchProviders(),
        fetchBooks(),
      ])

      setProviders(providerResponse.providers)
      setBooks(bookResponse.items)
      const resolvedProvider =
        providerResponse.providers.find((provider) => provider.id === form.provider) ??
        providerResponse.providers[0] ??
        null
      setForm((previous) => ({
        ...previous,
        provider: resolvedProvider?.id ?? previous.provider,
        narrationStyle: previous.narrationStyle || providerResponse.defaultNarrationStyle,
      }))
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to load the app.')
    } finally {
      setLoading(false)
    }
  }

  function navigateToLibrary() {
    persistCurrentAudioProgress(true)
    window.history.pushState({}, '', '/')
    setNarrationOpen(false)
    setRoute({ kind: 'library' })
  }

  function navigateToBook(bookId: string) {
    persistCurrentAudioProgress(true)
    window.history.pushState({}, '', `/book/${encodeURIComponent(bookId)}`)
    setReaderTab(readerTabs[bookId] ?? 'reader')
    setNarrationOpen(false)
    setRoute({ kind: 'book', bookId })
  }

  function updateReadingProgress(
    bookId: string,
    payload: {
      pageNumber: number
      totalPages: number
      textStart: number
      textEnd: number
      textLength: number
    },
  ) {
    const current = readingProgress[bookId]
    if (
      current &&
      current.pageNumber === payload.pageNumber &&
      current.totalPages === payload.totalPages &&
      current.textStart === payload.textStart &&
      current.textEnd === payload.textEnd &&
      current.textLength === payload.textLength
    ) {
      return
    }

    const nextProgress: ReadingProgress = {
      pageNumber: payload.pageNumber,
      totalPages: payload.totalPages,
      textStart: payload.textStart,
      textEnd: payload.textEnd,
      textLength: payload.textLength,
      updatedAt: new Date().toISOString(),
    }

    setReadingProgress((previous) => ({
      ...previous,
      [bookId]: nextProgress,
    }))
    syncReadingProgressToServer(bookId, nextProgress)
  }

  function updateReaderFontScale(bookId: string, fontScale: number) {
    const nextScale = Math.min(1.25, Math.max(0.9, fontScale))
    setReaderFontScales((previous) =>
      previous[bookId] === nextScale
        ? previous
        : {
            ...previous,
            [bookId]: nextScale,
          },
    )
  }

  function currentReadingFraction() {
    if (!currentProgress) {
      return 0
    }

    if (
      typeof currentProgress.textStart === 'number' &&
      typeof currentProgress.textLength === 'number' &&
      currentProgress.textLength > 0
    ) {
      return Math.max(0, Math.min(1, currentProgress.textStart / currentProgress.textLength))
    }

    if (currentProgress.totalPages <= 0) {
      return 0
    }

    return Math.max(0, Math.min(1, (currentProgress.pageNumber - 1) / currentProgress.totalPages))
  }

  function currentReadingLabel() {
    return currentProgress
      ? `page ${currentProgress.pageNumber} of ${currentProgress.totalPages}`
      : 'the beginning of the book'
  }

  function readingFractionFromOffset(textOffset: number) {
    const textLength = readerPayload?.text.length ?? currentProgress?.textLength ?? 0
    if (textLength <= 0) {
      return currentReadingFraction()
    }

    return Math.max(0, Math.min(1, textOffset / textLength))
  }

  function applyAudioSeek(audio: HTMLAudioElement, fraction: number) {
    if (!Number.isFinite(audio.duration) || audio.duration <= 0) {
      return false
    }

    const safeDuration = Math.max(audio.duration - 0.25, 0)
    audio.currentTime = Math.min(safeDuration, Math.max(0, audio.duration * fraction))
    return true
  }

  function syncAudioToDisplayedPage(audio: HTMLAudioElement | null) {
    if (!audio || !currentProgress || !Number.isFinite(audio.duration) || audio.duration <= 0) {
      return false
    }

    const targetFraction = currentReadingFraction()
    const targetTime = Math.max(0, audio.duration * targetFraction)
    if (Math.abs(audio.currentTime - targetTime) < 1.5) {
      return false
    }

    if (!applyAudioSeek(audio, targetFraction)) {
      return false
    }

    const pageLabel = currentReadingLabel()
    setAudioDockOpen(true)
    setAudioJumpMessage(`Starting from ${pageLabel}.`)
    setStatusMessage(`Starting playback from ${pageLabel}.`)
    return true
  }

  function storeAudioProgress(
    bookId: string,
    progress: StoredAudioProgress | null,
    options?: { syncRemote?: boolean; keepalive?: boolean; forceRemoteSync?: boolean },
  ) {
    const current = storedAudioProgressRef.current[bookId] ?? null
    if (sameStoredAudioProgress(current, progress)) {
      if (options?.syncRemote !== false && options?.forceRemoteSync) {
        syncAudioProgressToServer(bookId, progress, {
          force: true,
          keepalive: options?.keepalive,
        })
      }
      return
    }

    const next = { ...storedAudioProgressRef.current }

    if (progress) {
      next[bookId] = progress
    } else {
      delete next[bookId]
    }

    storedAudioProgressRef.current = next
    writeStoredValue(AUDIO_PROGRESS_KEY, next)
    if (options?.syncRemote !== false) {
      syncAudioProgressToServer(bookId, progress, {
        force: options?.forceRemoteSync,
        keepalive: options?.keepalive,
      })
    }
  }

  function persistCurrentAudioProgress(force = false, keepalive = false) {
    if (liveAudioMode !== null || !selectedBookId || !selectedBook?.latestAudio) {
      return
    }

    const audio = audioPlayerRef.current
    if (!audio || !Number.isFinite(audio.currentTime)) {
      return
    }

    if (audio.ended) {
      storeAudioProgress(selectedBookId, null, { forceRemoteSync: true, keepalive })
      return
    }

    if (!force && audio.currentTime <= 0) {
      return
    }

    const currentTime = Math.max(0, audio.currentTime)
    const nextProgress: StoredAudioProgress = {
      url: selectedBook.latestAudio.url,
      currentTime,
      wasPlaying: !audio.paused,
      updatedAt: new Date().toISOString(),
    }
    const previous = storedAudioProgressRef.current[selectedBookId]

    if (
      !force &&
      previous &&
      previous.url === nextProgress.url &&
      Math.abs(previous.currentTime - nextProgress.currentTime) < 1 &&
      previous.wasPlaying === nextProgress.wasPlaying
    ) {
      return
    }

    storeAudioProgress(selectedBookId, nextProgress, {
      forceRemoteSync: force,
      keepalive,
    })
  }

  pageHidePersistRef.current = () => {
    persistCurrentAudioProgress(true, true)
  }

  function restoreSavedAudioProgress(audio: HTMLAudioElement) {
    const savedProgress = restoreAudioProgressRef.current
    if (!savedProgress || !Number.isFinite(audio.duration) || audio.duration <= 0) {
      return false
    }

    const safeDuration = Math.max(audio.duration - 0.25, 0)
    const safeTime = Math.min(safeDuration, Math.max(0, savedProgress.currentTime))
    if (safeTime <= 0) {
      restoreAudioProgressRef.current = null
      return false
    }

    audio.currentTime = safeTime
    skipDisplayedPageSyncOnNextPlayRef.current = true
    setAudioDockOpen(true)
    setAudioJumpMessage(
      savedProgress.wasPlaying
        ? `Resuming from ${formatPlaybackTime(safeTime)}.`
        : `Ready at ${formatPlaybackTime(safeTime)}.`,
    )
    restoreAudioProgressRef.current = null
    return savedProgress.wasPlaying
  }

  async function startPlaybackAtFraction(fraction: number, label: string, missingAudioMessage: string) {
    if (!selectedBook?.latestAudio) {
      setErrorMessage(missingAudioMessage)
      setStatusMessage('Use Audio controls if you want to generate narration for this book.')
      return
    }

    cancelLivePlayback()
    setNarrationOpen(false)
    setAudioDockOpen(true)
    setAudioJumpMessage(`Starting from ${label}.`)
    setStatusMessage(`Starting playback from ${label}.`)
    setErrorMessage('')

    const audio = audioPlayerRef.current
    if (!audio) {
      setPendingAudioSeek(fraction)
      setPendingAudioPlay(true)
      return
    }

    if (!applyAudioSeek(audio, fraction)) {
      setPendingAudioSeek(fraction)
      setPendingAudioPlay(true)
      if (audio.readyState === 0) {
        audio.load()
      }
      return
    }

    setPendingAudioSeek(null)
    setPendingAudioPlay(false)

    try {
      skipDisplayedPageSyncOnNextPlayRef.current = true
      await audio.play()
    } catch {
      setErrorMessage('Playback could not start automatically. Use the player controls to continue.')
    }
  }

  async function handlePlayFromSelection(payload: { start: number; end: number; text: string }) {
    if (!selectedBook?.latestAudio) {
      const selectionRequest = liveRequestFromSelection(payload.start)
      if (!selectionRequest) {
        setErrorMessage('The selected text could not be mapped to a readable live segment.')
        return
      }

      await startLivePlayback(
        selectionRequest.request,
        {
          mode: 'selection',
          label: summarizeSelection(payload.text),
          nextPageIndex: selectionRequest.pageIndex + 1,
        },
      )
      return
    }

    const fraction = readingFractionFromOffset(payload.start)
    const label = summarizeSelection(payload.text)
    await startPlaybackAtFraction(
      fraction,
      label,
      'Generate an audiobook first, then you can start playback from the selected text.',
    )
  }

  async function handleStartLiveReadCurrentPage() {
    const pageIndex = currentProgress
      ? Math.max(0, Math.min(readerPages.length - 1, currentProgress.pageNumber - 1))
      : 0
    const request = livePageRequestAtIndex(pageIndex)
    if (!request) {
      setErrorMessage('The displayed page is not ready for live narration yet.')
      return
    }

    await startLivePlayback(request, {
      mode: 'page',
      label: `page ${request.pageNumber}`,
      nextPageIndex: pageIndex + 1,
    })
  }

  async function handleAudioMetadataReady() {
    const audio = audioPlayerRef.current
    if (!audio) {
      return
    }

    if (pendingAudioSeek !== null) {
      const didSeek = applyAudioSeek(audio, pendingAudioSeek)
      setPendingAudioSeek(null)

      if (!didSeek || !pendingAudioPlay) {
        setPendingAudioPlay(false)
        return
      }

      try {
        skipDisplayedPageSyncOnNextPlayRef.current = true
        await audio.play()
      } catch {
        setErrorMessage('Playback could not start automatically. Use the player controls to continue.')
      } finally {
        setPendingAudioPlay(false)
      }
      return
    }

    if (liveAudioMode !== null && pendingAudioPlay) {
      try {
        skipDisplayedPageSyncOnNextPlayRef.current = true
        await audio.play()
      } catch {
        setErrorMessage('Playback could not start automatically. Use the player controls to continue.')
      } finally {
        setPendingAudioPlay(false)
      }
      return
    }

    const shouldAutoplay = restoreSavedAudioProgress(audio)
    if (!shouldAutoplay) {
      syncSpokenRangeFromAudio()
      return
    }

    try {
      skipDisplayedPageSyncOnNextPlayRef.current = true
      await audio.play()
    } catch {
      setStatusMessage('Playback position was restored. Press play to continue from where you left off.')
    }
  }

  function syncSpokenRangeFromAudio() {
    const audio = audioPlayerRef.current
    const textLength = readerPayload?.text.length ?? 0
    const liveSegment = liveAudioCurrentRef.current

    if (!audio || !sentenceCues.length || textLength <= 0 || !Number.isFinite(audio.duration) || audio.duration <= 0) {
      setSpokenRange(null)
      return
    }

    const fraction = Math.max(0, Math.min(1, audio.currentTime / audio.duration))
    const estimatedOffset = liveSegment
      ? Math.max(
          liveSegment.start,
          Math.min(
            Math.max(liveSegment.start, liveSegment.end - 1),
            liveSegment.start + Math.floor((liveSegment.end - liveSegment.start) * fraction),
          ),
        )
      : Math.min(
          Math.max(0, textLength - 1),
          Math.max(0, Math.floor(textLength * fraction)),
        )
    const cue = findSentenceCueAtOffset(sentenceCues, estimatedOffset)

    if (!cue) {
      setSpokenRange(null)
      return
    }

    setSpokenRange((current) =>
      current && current.start === cue.start && current.end === cue.end && current.text === cue.text
        ? current
        : cue,
    )
  }

  function handleAudioPlay() {
    setNarrationOpen(false)
    setAudioDockOpen(true)
    syncSpokenRangeFromAudio()

    if (liveAudioMode !== null) {
      if (skipDisplayedPageSyncOnNextPlayRef.current) {
        skipDisplayedPageSyncOnNextPlayRef.current = false
      }
      return
    }

    if (skipDisplayedPageSyncOnNextPlayRef.current) {
      skipDisplayedPageSyncOnNextPlayRef.current = false
    } else {
      syncAudioToDisplayedPage(audioPlayerRef.current)
    }

    persistCurrentAudioProgress(true)
  }

  function handleAudioPause() {
    syncSpokenRangeFromAudio()
    if (liveAudioMode !== null) {
      return
    }
    persistCurrentAudioProgress(true)
  }

  function handleAudioTimeUpdate() {
    syncSpokenRangeFromAudio()
    if (liveAudioMode !== null) {
      return
    }
    persistCurrentAudioProgress()
  }

  function handleAudioSeeked() {
    syncSpokenRangeFromAudio()
    if (liveAudioMode !== null) {
      return
    }
    persistCurrentAudioProgress(true)
  }

  function handleAudioEnded() {
    if (liveAudioMode !== null) {
      setSpokenRange(null)

      const queuedSegment = liveAudioQueueRef.current[0] ?? null
      if (queuedSegment) {
        setLiveAudioQueue((previous) => {
          const next = previous.slice(1)
          liveAudioQueueRef.current = next
          return next
        })
        activateLiveSegment(queuedSegment, `Reading page ${queuedSegment.pageNumber} now.`)
        if (liveNextPageIndexRef.current < readerPages.length) {
          void prefetchLiveSegments(liveSessionIdRef.current)
        }
        return
      }

      if (liveNextPageIndexRef.current < readerPages.length) {
        const request = livePageRequestAtIndex(liveNextPageIndexRef.current)
        liveNextPageIndexRef.current += 1

        if (request) {
          const sessionId = liveSessionIdRef.current
          setLiveAudioLoading(true)
          setAudioJumpMessage('Buffering next page...')
          setStatusMessage('Buffering next page...')
          void requestLiveAudio(request)
            .then((segment) => {
              if (sessionId !== liveSessionIdRef.current) {
                return
              }

              activateLiveSegment(segment, `Reading page ${segment.pageNumber} now.`)
              void prefetchLiveSegments(sessionId)
            })
            .catch((error) => {
              if (sessionId !== liveSessionIdRef.current) {
                return
              }

              setLiveAudioLoading(false)
              setErrorMessage(error instanceof Error ? error.message : 'The next live page could not be generated.')
              setAudioJumpMessage('Live read paused.')
            })
          return
        }
      }

      setLiveAudioLoading(false)
      setAudioJumpMessage('Live read finished.')
      setStatusMessage('Live read finished.')
      if (selectedBook?.latestAudio) {
        cancelLivePlayback()
      }
      return
    }

    setSpokenRange(null)
    setAudioJumpMessage('Playback finished.')
    if (selectedBookId) {
      storeAudioProgress(selectedBookId, null, { forceRemoteSync: true })
    }
  }

  async function handleUpload(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formData = new FormData(event.currentTarget)
    const file = formData.get('pdf')
    if (!(file instanceof File)) {
      setErrorMessage('Choose a PDF first.')
      return
    }

    try {
      setUploading(true)
      setErrorMessage('')
      setStatusMessage(`Uploading ${file.name} and extracting readable text.`)
      const payload = new FormData()
      payload.append('file', file)
      const book = await apiRequest<Book>('/api/books', {
        method: 'POST',
        body: payload,
      })
      setBooks((previous) => upsertBook(previous, book))
      navigateToLibrary()
      setStatusMessage(`Imported ${book.title}.`)
      event.currentTarget.reset()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Upload failed.')
    } finally {
      setUploading(false)
    }
  }

  async function handleGenerate() {
    if (!selectedBook) {
      setErrorMessage('Upload or select a book first.')
      return
    }

    if (jobBusy) {
      setErrorMessage('Wait for the current audiobook job to finish or cancel it first.')
      return
    }

    try {
      setSubmitting(true)
      setErrorMessage('')
      setStatusMessage('Starting narration job.')
      const payload = await apiRequest<JobStatus>(`/api/books/${selectedBook.id}/jobs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          provider: form.provider,
          voice: form.voice || undefined,
          model: form.model || undefined,
          output_format: form.outputFormat,
          narration_style: form.narrationStyle,
          length_scale: form.lengthScale,
          sentence_silence: form.sentenceSilence,
        }),
      })
      setActiveJob(payload)
      setStatusMessage('Narration is in progress. You can keep reading while it runs.')
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to start narration.')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleProviderTest(voiceId?: string) {
    if (!currentProvider) {
      return
    }

    const chosenVoice = voiceId || form.voice || undefined

    try {
      setTestingProvider(true)
      setPreviewingVoiceId(chosenVoice ?? null)
      setErrorMessage('')
      if (voiceId) {
        setForm((previous) => ({ ...previous, voice: voiceId }))
      }
      setStatusMessage(`Testing ${currentProvider.name} with a short sample.`)
      const payload = await testProvider({
        provider: form.provider,
        voice: chosenVoice,
        model: form.model || undefined,
        narration_style: form.narrationStyle,
        length_scale: form.lengthScale,
        sentence_silence: form.sentenceSilence,
      })
      setProviderSample(payload)
      setStatusMessage(payload.message)
    } catch (error) {
      setProviderSample(null)
      setErrorMessage(error instanceof Error ? error.message : 'Provider test failed.')
    } finally {
      setTestingProvider(false)
      setPreviewingVoiceId(null)
    }
  }

  async function handleCancelActiveJob() {
    if (!activeJob || !jobBusy) {
      return
    }

    try {
      setCancellingJob(true)
      setErrorMessage('')
      const payload = await cancelJob(activeJob.id)
      setActiveJob(payload)
      setStatusMessage(payload.message)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to cancel narration.')
    } finally {
      setCancellingJob(false)
    }
  }

  async function loadPollyHealth() {
    try {
      setPollyHealthLoading(true)
      const payload = await fetchPollyHealth()
      setPollyHealth(payload)
    } catch (error) {
      setPollyHealth({
        connected: false,
        region: 'Unknown',
        engine: 'unknown',
        languageCode: 'unknown',
        profile: null,
        defaultVoice: null,
        voiceCount: 0,
        accountId: null,
        arn: null,
        message: error instanceof Error ? error.message : 'Failed to load Polly health.',
      })
    } finally {
      setPollyHealthLoading(false)
    }
  }

  async function handleCreateHighlight(payload: {
    start: number
    end: number
    color: Highlight['color']
    text: string
    note?: string
  }) {
    if (!readerPayload) {
      return
    }

    try {
      const created = await createHighlight(readerPayload.book.id, payload)
      const nextHighlights = [
        ...readerPayload.highlights.filter(
          (item) => !(payload.start < item.end && payload.end > item.start),
        ),
        created,
      ].sort((left, right) => left.start - right.start)
      const nextCount = nextHighlights.length

      setReaderPayload({
        ...readerPayload,
        highlights: nextHighlights,
        book: {
          ...readerPayload.book,
          highlightCount: nextCount,
        },
      })
      setBooks((previous) =>
        patchBook(previous, readerPayload.book.id, {
          highlightCount: nextCount,
        }),
      )
      setStatusMessage('Saved highlight to this book.')
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to save highlight.')
      throw error
    }
  }

  async function handleDeleteHighlight(highlightId: string) {
    if (!readerPayload) {
      return
    }

    try {
      setRemovingHighlightId(highlightId)
      await deleteHighlight(readerPayload.book.id, highlightId)
      const nextHighlights = readerPayload.highlights.filter((item) => item.id !== highlightId)
      const nextCount = Math.max(0, readerPayload.book.highlightCount - 1)
      setReaderPayload({
        ...readerPayload,
        highlights: nextHighlights,
        book: {
          ...readerPayload.book,
          highlightCount: nextCount,
        },
      })
      setBooks((previous) =>
        patchBook(previous, readerPayload.book.id, {
          highlightCount: nextCount,
        }),
      )
      setStatusMessage('Removed highlight.')
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to remove highlight.')
    } finally {
      setRemovingHighlightId(null)
    }
  }

  async function handleDeleteBook(book: Book) {
    try {
      setDeletingBookId(book.id)
      setErrorMessage('')
      await deleteBook(book.id)

      const remainingBooks = books.filter((item) => item.id !== book.id)
      setBooks(remainingBooks)
      setReaderFontScales((previous) => {
        if (!(book.id in previous)) {
          return previous
        }
        const next = { ...previous }
        delete next[book.id]
        return next
      })

      if (selectedBookId === book.id) {
        setReaderPayload(null)
        setProviderSample(null)
        setActiveJob((previous) => (previous?.bookId === book.id ? null : previous))
        navigateToLibrary()
      }

      setStatusMessage(`Removed ${book.title} from your library.`)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to delete the book.')
    } finally {
      setDeletingBookId(null)
    }
  }

  function setProvider(provider: 'piper' | 'google' | 'openai' | 'polly') {
    const match = providers.find((item) => item.id === provider)
    setForm((previous) => ({
      ...previous,
      provider,
      voice: match?.defaultVoice ?? '',
      model: match?.defaultModel ?? '',
    }))
  }

  const voiceOptions: VoiceOption[] = currentProvider?.voices ?? []
  const modelOptions = currentProvider?.models ?? []
  const selectedModel = modelOptions.find((model) => model.id === form.model) ?? null
  const currentProgress = selectedBook ? readingProgress[selectedBook.id] : null
  const liveReadAvailable =
    Boolean(selectedBook) && Boolean(currentProvider?.available) && voiceOptions.length > 0 && readerPages.length > 0
  const canPlayFromReaderSelection = Boolean(selectedBook?.latestAudio) || liveReadAvailable
  const showAudioDock =
    audioDockOpen && (Boolean(currentAudioSrc) || liveAudioLoading || (liveAudioMode !== null && !selectedBook?.latestAudio))
  const audioBarTitle =
    liveAudioMode !== null
      ? `${liveAudioCurrent?.provider ?? form.provider} • live`
      : selectedBook?.latestAudio
        ? `${selectedBook.latestAudio.provider} • ${selectedBook.latestAudio.format}`
        : 'Narration'
  const audioBarSubtitle =
    audioJumpMessage ||
    (liveAudioMode !== null
      ? 'Live read starts from the displayed page and buffers ahead while you listen.'
      : 'Press play to start from the displayed page, or select text and use Play here.')
  const jobBusy =
    activeJob !== null &&
    activeJob.status !== 'completed' &&
    activeJob.status !== 'failed' &&
    activeJob.status !== 'cancelled'
  const libraryTiles = [{ kind: 'upload' as const }, ...books.map((book) => ({ kind: 'book' as const, book }))]
  const minimumShelfRows = 4
  const paddedLibraryTiles = [
    ...libraryTiles,
    ...Array.from({ length: Math.max(0, minimumShelfRows * libraryColumns - libraryTiles.length) }, () => null),
  ]
  const shelfRows = chunkItems(paddedLibraryTiles, libraryColumns)
  const resumeBook =
    books
      .map((book) => ({ book, progress: readingProgress[book.id] }))
      .filter((item) => item.progress)
      .sort((left, right) => (right.progress?.updatedAt ?? '').localeCompare(left.progress?.updatedAt ?? ''))[0]
      ?.book ?? books[0] ?? null
  const narrationPanel = (
    <aside className="panel status-panel narration-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Narration</p>
          <h2>Audio controls</h2>
        </div>
        <div className="narration-panel__header-actions">
          {currentProvider ? (
            <span className={`badge ${currentProvider.available ? 'ok' : 'muted'}`}>
              {currentProvider.available ? 'Ready' : 'Needs setup'}
            </span>
          ) : null}
          <button
            aria-label="Close narration controls"
            className="secondary-button secondary-button--compact narration-panel__close"
            onClick={() => setNarrationOpen(false)}
            type="button"
          >
            Close
          </button>
        </div>
      </div>

      <div className="provider-toggle" role="tablist" aria-label="Voice providers">
        {providers.map((provider) => (
          <button
            className={provider.id === form.provider ? 'active' : ''}
            key={provider.id}
            onClick={() => setProvider(provider.id)}
            type="button"
          >
            <strong>{provider.name}</strong>
            <small>{provider.description}</small>
          </button>
        ))}
      </div>

      {form.provider === 'polly' && pollyHealth ? (
        <div className="health-card">
          <div className="health-card__header">
            <div>
              <p className="eyebrow">AWS Status</p>
              <strong>{pollyHealth.connected ? 'Polly connected' : 'Polly not ready'}</strong>
            </div>
            <button
              className="secondary-button secondary-button--compact"
              disabled={pollyHealthLoading}
              onClick={() => void loadPollyHealth()}
              type="button"
            >
              {pollyHealthLoading ? 'Refreshing...' : 'Refresh AWS status'}
            </button>
          </div>
          <p className="sample-text">{pollyHealth.message}</p>
          <div className="health-grid">
            <div>
              <span>Account</span>
              <strong>{pollyHealth.accountId ?? 'Unavailable'}</strong>
            </div>
            <div>
              <span>Region</span>
              <strong>{pollyHealth.region}</strong>
            </div>
            <div>
              <span>Engine</span>
              <strong>{pollyHealth.engine}</strong>
            </div>
            <div>
              <span>Voices</span>
              <strong>{pollyHealth.voiceCount}</strong>
            </div>
          </div>
          {pollyHealth.profile || pollyHealth.defaultVoice ? (
            <div className="health-grid">
              <div>
                <span>Profile</span>
                <strong>{pollyHealth.profile ?? 'default chain'}</strong>
              </div>
              <div>
                <span>Default voice</span>
                <strong>{pollyHealth.defaultVoice ?? 'Unavailable'}</strong>
              </div>
            </div>
          ) : null}
          {pollyHealth.arn ? <small className="health-arn">{pollyHealth.arn}</small> : null}
        </div>
      ) : null}

      <div className="voice-picker">
        <div className="voice-picker__header">
          <span>Voice</span>
          {form.voice ? (
            <small>
              Selected:{' '}
              {voiceOptions.find((voice) => voice.id === form.voice)?.label ?? form.voice}
            </small>
          ) : null}
        </div>
        <div className="voice-list">
          {voiceOptions.map((voice) => {
            const isActive = voice.id === form.voice
            const isPreviewing = previewingVoiceId === voice.id && testingProvider
            const genderLabel = voiceGenderLabel(voice)

            return (
              <div className={`voice-item ${isActive ? 'active' : ''}`} key={voice.id}>
                <button
                  className="voice-item__select"
                  onClick={() => setForm((previous) => ({ ...previous, voice: voice.id }))}
                  type="button"
                >
                  <strong>{voice.label}</strong>
                  <small>{voice.style ?? (isActive ? 'Selected' : 'Use this voice')}</small>
                  {genderLabel || voice.tags?.length ? (
                    <div className="voice-tags">
                      {genderLabel ? <span className="voice-tag">{genderLabel}</span> : null}
                      {voice.tags?.map((tag) => (
                        <span className="voice-tag" key={tag}>
                          {tag}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </button>
                <button
                  className="secondary-button secondary-button--compact voice-item__preview"
                  disabled={testingProvider && !isPreviewing}
                  onClick={() => void handleProviderTest(voice.id)}
                  title={`Play a sample for ${voice.label}`}
                  type="button"
                >
                  {isPreviewing ? 'Playing...' : 'Play sample'}
                </button>
              </div>
            )
          })}
          {!voiceOptions.length ? (
            <div className="empty-card voice-picker__empty">
              <strong>No voices available</strong>
              <p>Configure this provider first to browse and preview its voices.</p>
            </div>
          ) : null}
        </div>
        {currentProvider?.voiceMetaNote ? <small className="voice-picker__note">{currentProvider.voiceMetaNote}</small> : null}
      </div>

      <div className="controls-grid">
        {modelOptions.length ? (
          <label>
            <span>Model</span>
            <select
              onChange={(event) =>
                setForm((previous) => ({
                  ...previous,
                  model: event.target.value,
                }))
              }
              value={form.model}
            >
              {modelOptions.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </select>
            {selectedModel ? (
              <small>
                {selectedModel.description}
                {selectedModel.storytelling ? ' Storytelling-friendly.' : ''}
              </small>
            ) : null}
          </label>
        ) : null}

        <label>
          <span>Output</span>
          <select
            onChange={(event) =>
              setForm((previous) => ({
                ...previous,
                outputFormat: event.target.value as ReaderForm['outputFormat'],
              }))
            }
            value={form.outputFormat}
          >
            <option value="mp3">MP3</option>
            <option value="m4b">M4B</option>
            <option value="wav">WAV</option>
          </select>
        </label>

        <label>
          <span>Speech speed</span>
          <input
            max={1.5}
            min={0.6}
            onChange={(event) =>
              setForm((previous) => ({
                ...previous,
                lengthScale: Number(event.target.value),
              }))
            }
            step={0.05}
            type="range"
            value={form.lengthScale}
          />
          <small>{form.lengthScale.toFixed(2)}x length scale</small>
        </label>

        <label>
          <span>Sentence pause</span>
          <input
            max={1}
            min={0}
            onChange={(event) =>
              setForm((previous) => ({
                ...previous,
                sentenceSilence: Number(event.target.value),
              }))
            }
            step={0.05}
            type="range"
            value={form.sentenceSilence}
          />
          <small>{form.sentenceSilence.toFixed(2)} seconds</small>
        </label>
      </div>

      <label className="style-field">
        <span>Narration style</span>
        <textarea
          onChange={(event) =>
            setForm((previous) => ({
              ...previous,
              narrationStyle: event.target.value,
            }))
          }
          rows={4}
          value={form.narrationStyle}
        />
        <small>
          Google and OpenAI use this directly. Piper and Polly ignore narration prompting and
          read the cleaned text with provider-native controls.
        </small>
      </label>

      <div className="action-row">
        <button
          className="secondary-button"
          disabled={testingProvider || submitting || jobBusy || !currentProvider?.available || !voiceOptions.length}
          onClick={() => void handleProviderTest()}
          type="button"
        >
          {testingProvider ? 'Testing voice...' : 'Test current voice'}
        </button>

        <button
          className="secondary-button"
          disabled={!liveReadAvailable || testingProvider || submitting || jobBusy}
          onClick={() => void handleStartLiveReadCurrentPage()}
          type="button"
        >
          {liveAudioLoading && liveAudioMode === 'page' ? 'Starting live...' : 'Live read current page'}
        </button>

        <button
          className="primary-button"
          disabled={
            !selectedBook ||
            submitting ||
            jobBusy ||
            testingProvider ||
            !currentProvider?.available ||
            !voiceOptions.length
          }
          onClick={() => void handleGenerate()}
          type="button"
        >
          {submitting ? 'Starting...' : 'Generate audiobook'}
        </button>
      </div>

      {providerSample ? (
        <div className="audio-card">
          <div className="audio-card__header">
            <div>
              <p className="eyebrow">Provider test</p>
              <strong>
                {providerSample.provider} • {providerSample.voice || 'default voice'}
              </strong>
              {providerSample.model ? <small>{providerSample.model}</small> : null}
            </div>
          </div>
          <p className="sample-text">{providerSample.sampleText}</p>
          <audio autoPlay controls preload="metadata" src={providerSample.audioUrl} />
          <a className="text-link" href={providerSample.audioUrl}>
            Open sample audio
          </a>
        </div>
      ) : null}

      {selectedBook?.latestAudio ? (
        <div className="audio-card">
          <div className="audio-card__header">
            <div>
              <p className="eyebrow">Latest export</p>
              <strong>
                {selectedBook.latestAudio.provider} • {selectedBook.latestAudio.format}
              </strong>
              {selectedBook.latestAudio.model ? <small>{selectedBook.latestAudio.model}</small> : null}
            </div>
            <small>{formatDate(selectedBook.latestAudio.createdAt)}</small>
          </div>
          <audio controls preload="metadata" src={selectedBook.latestAudio.url} />
          <a className="text-link" href={selectedBook.latestAudio.url}>
            Open audio file
          </a>
        </div>
      ) : (
        <div className="empty-card">
          <strong>No audio yet</strong>
          <p>The generated track will appear here with a built-in player.</p>
        </div>
      )}

      {activeJob ? (
        <div className={`job-card ${activeJob.status}`}>
          <div className="job-card__row">
            <strong>{activeJob.status.toUpperCase()}</strong>
            <span>{activeJob.progress.toFixed(0)}%</span>
          </div>
          <div aria-hidden className="progress-track">
            <span style={{ width: `${activeJob.progress}%` }} />
          </div>
          <p>{activeJob.message}</p>
          {activeJob.error ? <small>{activeJob.error}</small> : null}
          {jobBusy ? (
            <div className="job-card__actions">
              <button
                className="secondary-button secondary-button--compact"
                disabled={cancellingJob || activeJob.status === 'cancelling'}
                onClick={() => void handleCancelActiveJob()}
                type="button"
              >
                {cancellingJob || activeJob.status === 'cancelling' ? 'Cancelling...' : 'Cancel generation'}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {statusMessage ? <p className="status-line">{statusMessage}</p> : null}
      {errorMessage ? <p className="error-line">{errorMessage}</p> : null}
    </aside>
  )

  return (
    <main className={`app-shell ${route.kind === 'library' ? 'app-shell--library' : ''}`}>
      {route.kind === 'library' ? (
        <section className="library-screen">
          <div className="library-appbar">
            <button className="library-appbar__icon" type="button" aria-label="Menu">
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <path d="M4 7h16M4 12h16M4 17h16" />
              </svg>
            </button>
            <div className="library-appbar__title">
              <strong>All Books</strong>
              <span>▾</span>
            </div>
            <div className="library-appbar__actions">
              <button className="library-appbar__icon" type="button" aria-label="Search">
                <svg aria-hidden="true" viewBox="0 0 24 24">
                  <circle cx="11" cy="11" r="6.5" />
                  <path d="M16 16l4.5 4.5" />
                </svg>
              </button>
              <button className="library-appbar__icon" type="button" aria-label="Filter">
                <svg aria-hidden="true" viewBox="0 0 24 24">
                  <path d="M4 6h16l-6.5 7.5V19l-3 1v-6.5z" />
                </svg>
              </button>
              <button className="library-appbar__icon" type="button" aria-label="More options">
                <svg aria-hidden="true" viewBox="0 0 24 24">
                  <circle cx="12" cy="5" r="1.75" />
                  <circle cx="12" cy="12" r="1.75" />
                  <circle cx="12" cy="19" r="1.75" />
                </svg>
              </button>
            </div>
          </div>

          <div className="library-bookshelf">
            {shelfRows.map((row, rowIndex) => (
              <div className="bookshelf-row" key={`row-${rowIndex}`}>
                <div className="bookshelf-row__items">
                  {row.map((item, itemIndex) =>
                    item === null ? (
                      <div aria-hidden className="library-book library-book--ghost" key={`ghost-${rowIndex}-${itemIndex}`} />
                    ) : item.kind === 'upload' ? (
                      <form className="library-book library-book--upload" key="upload" onSubmit={handleUpload}>
                        <label className="library-book__cover library-book__cover--upload" htmlFor="library-upload-input">
                          <input accept=".pdf,application/pdf" id="library-upload-input" name="pdf" type="file" />
                          <span className="library-book__plus">+</span>
                          <span className="library-book__upload-title">
                            {uploading ? 'Importing...' : 'Add Book'}
                          </span>
                          <small>Drop PDF or browse</small>
                        </label>
                        <button className="primary-button library-book__import" disabled={uploading} type="submit">
                          {uploading ? 'Working...' : 'Import PDF'}
                        </button>
                      </form>
                    ) : (
                      <article className="library-book" key={item.book.id}>
                        <button
                          className="library-book__cover"
                          onClick={() => navigateToBook(item.book.id)}
                          type="button"
                        >
                          <LibraryCover sourceUrl={item.book.sourceUrl} title={item.book.title} />
                          <span className="library-book__dots">
                            <i />
                            <i />
                            <i />
                          </span>
                        </button>
                        <button
                          aria-label={`Delete ${item.book.title}`}
                          className="library-book__delete"
                          disabled={deletingBookId === item.book.id}
                          onClick={() => void handleDeleteBook(item.book)}
                          type="button"
                        >
                          {deletingBookId === item.book.id ? '...' : 'Delete'}
                        </button>
                      </article>
                    )
                  )}
                </div>
                <div aria-hidden className="bookshelf-row__plank" />
              </div>
            ))}

            {!books.length && !loading ? (
              <div className="empty-card empty-card--shelf">
                <strong>Your shelf is empty</strong>
                <p>Import a PDF to start building your personal library.</p>
              </div>
            ) : null}

            {resumeBook ? (
              <button className="library-fab" onClick={() => navigateToBook(resumeBook.id)} type="button">
                <svg aria-hidden="true" viewBox="0 0 24 24">
                  <path d="M4.5 6.5c0-1.1.9-2 2-2H12v13H6.5c-1.1 0-2-.9-2-2z" />
                  <path d="M19.5 6.5c0-1.1-.9-2-2-2H12v13h5.5c1.1 0 2-.9 2-2z" />
                </svg>
              </button>
            ) : null}
          </div>
        </section>
      ) : (
        <section className={`reader-screen ${showAudioDock ? 'reader-screen--with-audio' : ''}`}>
          <div className="reader-screen__topbar">
            <div className="reader-screen__topbar-main">
              <button className="secondary-button secondary-button--compact" onClick={navigateToLibrary} type="button">
                Back to Library
              </button>
              {selectedBook ? (
                <div className="reader-screen__title">
                  <p className="eyebrow">Now Reading</p>
                  <h2>{selectedBook.title}</h2>
                  <p className="reader-screen__subtitle">{selectedBook.fileName.replace(/\.pdf$/i, '')}</p>
                </div>
              ) : null}
            </div>
            {selectedBook ? (
              <div className="reader-screen__meta">
                <button
                  className="secondary-button secondary-button--compact reader-screen__audio-button"
                  onClick={() => setNarrationOpen(true)}
                  type="button"
                >
                  Audio controls
                </button>
                <span className="badge">{selectedBook.pageCount} pages</span>
                <span className="badge">{selectedBook.highlightCount} highlights</span>
                {currentProgress ? (
                  <span className="badge ok">
                    Page {currentProgress.pageNumber} of {currentProgress.totalPages}
                  </span>
                ) : (
                  <span className="badge muted">Not started</span>
                )}
                {selectedBook.latestAudio ? (
                  <span className="badge ok">Audio ready</span>
                ) : (
                  <span className="badge muted">No audio yet</span>
                )}
              </div>
            ) : null}
          </div>

          {selectedBook?.latestAudio || liveAudioMode !== null || liveAudioLoading ? (
            <div className={`reader-audio-bar ${showAudioDock ? 'active' : ''}`}>
              <div className="reader-audio-bar__meta">
                <p className="eyebrow">{liveAudioMode !== null ? 'Live narration' : 'Narration'}</p>
                <strong>{audioBarTitle}</strong>
                <small>{audioBarSubtitle}</small>
              </div>
              <div className="reader-audio-bar__controls">
                {currentAudioSrc ? (
                  <audio
                    controls
                    onEnded={handleAudioEnded}
                    onLoadedMetadata={() => void handleAudioMetadataReady()}
                    onPause={handleAudioPause}
                    onPlay={handleAudioPlay}
                    onSeeked={handleAudioSeeked}
                    onTimeUpdate={handleAudioTimeUpdate}
                    preload="metadata"
                    ref={audioPlayerRef}
                    src={currentAudioSrc}
                  />
                ) : (
                  <div className="reader-audio-bar__loading">Preparing audio...</div>
                )}
              </div>
            </div>
          ) : null}

          <div className="reader-workspace reader-workspace--clean">
            <div className="panel preview-panel reader-panel">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">Read</p>
                  <h2>{selectedBook?.title ?? 'Book not found'}</h2>
                </div>
                <div className="reader-panel__header">
                  {selectedBook ? (
                    <div className="view-toggle" role="tablist" aria-label="Reading views">
                      <button
                        className={readerTab === 'reader' ? 'active' : ''}
                        onClick={() => setReaderTab('reader')}
                        type="button"
                      >
                        Reader
                      </button>
                      <button
                        className={readerTab === 'pdf' ? 'active' : ''}
                        onClick={() => setReaderTab('pdf')}
                        type="button"
                      >
                        PDF
                      </button>
                      <button
                        className={readerTab === 'highlights' ? 'active' : ''}
                        onClick={() => setReaderTab('highlights')}
                        type="button"
                      >
                        Highlights
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>

              {selectedBook ? (
                readerLoading ? (
                  <div className="empty-stage">
                    <strong>Opening book...</strong>
                    <p>Loading the extracted text and saved highlights.</p>
                  </div>
                ) : readerTab === 'reader' && readerPayload ? (
                  <ReaderDesk
                    canPlayFromSelection={canPlayFromReaderSelection}
                    highlights={readerPayload.highlights}
                    initialFontScale={selectedReaderFontScale}
                    initialPageNumber={currentProgress?.pageNumber ?? 1}
                    onCreateHighlight={handleCreateHighlight}
                    onFontScaleChange={(fontScale) => updateReaderFontScale(readerPayload.book.id, fontScale)}
                    onPlayFromSelection={handlePlayFromSelection}
                    onProgressChange={(payload) => updateReadingProgress(readerPayload.book.id, payload)}
                    spokenRange={spokenRange}
                    text={readerPayload.text}
                    title={readerPayload.book.title}
                  />
                ) : readerTab === 'highlights' && readerPayload ? (
                  <HighlightsShelf
                    highlights={readerPayload.highlights}
                    onDelete={handleDeleteHighlight}
                    removingId={removingHighlightId}
                  />
                ) : readerTab === 'pdf' ? (
                  <Suspense
                    fallback={
                      <div className="empty-stage">
                        <strong>Loading PDF preview...</strong>
                        <p>Preparing the physical page renderer for this book.</p>
                      </div>
                    }
                  >
                    <BookStage
                      key={selectedBook.sourceUrl}
                      pageCount={selectedBook.pageCount}
                      sourceUrl={selectedBook.sourceUrl}
                      title={selectedBook.title}
                    />
                  </Suspense>
                ) : (
                  <div className="empty-stage">
                    <strong>Reader mode is unavailable.</strong>
                    <p>Try reselecting the book to reload its extracted text.</p>
                  </div>
                )
              ) : (
                <div className="empty-stage">
                  <strong>This book is unavailable.</strong>
                  <p>Return to the library and choose another title.</p>
                </div>
              )}
            </div>
          </div>

          {narrationOpen ? (
            <div className="narration-drawer" role="dialog" aria-label="Audio controls" aria-modal="true">
              <button
                aria-label="Close narration controls"
                className="narration-drawer__backdrop"
                onClick={() => setNarrationOpen(false)}
                type="button"
              />
              <div className="narration-drawer__panel">{narrationPanel}</div>
            </div>
          ) : null}
        </section>
      )}

      {loading ? <div className="loading-banner">Loading your library...</div> : null}
    </main>
  )
}
