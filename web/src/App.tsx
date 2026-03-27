import { Suspense, lazy, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import './App.css'
import { HighlightsShelf } from './components/HighlightsShelf'
import { buildHighlightLocations } from './components/highlightLocations'
import { LibraryScreen } from './components/LibraryScreen'
import { ReaderDesk } from './components/ReaderDesk'
import {
  DEFAULT_READER_APPEARANCE,
  READER_FONT_SCALE_MAX,
  READER_FONT_SCALE_MIN,
  type ReaderAppearance,
} from './components/readerAppearance'
import { extractReaderChapters, type ReaderChapter } from './components/readerChapters'
import { paginateReaderText } from './components/readerPagination'
import type {
  AudioTimingManifest,
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
  uploadBookDirectToStorage,
  updateBookAudioProgress,
  updateBookReadingProgress,
  usesHostedFunctionUploadLimit,
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

type StoredLibrarySnapshot = {
  books: Book[]
  providers: ProviderCatalog[]
}

type StoredUiPreferences = {
  readerForm: ReaderForm
  providerDefaults: Partial<Record<AudioControlProviderId, ProviderFormDefaults>>
  readerAppearance: ReaderAppearance
  readerFontScales: Record<string, number>
  audioPlaybackRate: number
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

type AudioTextPosition = {
  offset: number
  range: SpokenRange | null
}

type WeightedSentenceCue = SentenceCue & {
  weightStart: number
  weightEnd: number
}

type ReaderForm = {
  provider: 'piper' | 'google' | 'openai' | 'polly' | 'qwen'
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

type AudioControlProviderId = Extract<ReaderForm['provider'], 'google' | 'polly' | 'qwen'>
type ProviderFormDefaults = Pick<
  ReaderForm,
  'voice' | 'model' | 'outputFormat' | 'narrationStyle' | 'lengthScale' | 'sentenceSilence'
>

type ResolvedLiveConfig = {
  provider: ReaderForm['provider']
  providerName: string
  voice?: string
  model?: string
  outputFormat: 'mp3' | 'wav'
  narrationStyle: string
  lengthScale: number
  sentenceSilence: number
}

const initialForm: ReaderForm = {
  provider: 'polly',
  voice: '',
  model: '',
  outputFormat: 'mp3',
  narrationStyle: '',
  lengthScale: 1,
  sentenceSilence: 0.2,
}

const initialReaderAppearance: ReaderAppearance = DEFAULT_READER_APPEARANCE

const READING_PROGRESS_KEY = 'storybook-reader-progress'
const SESSION_STATE_KEY = 'storybook-reader-session'
const AUDIO_PROGRESS_KEY = 'storybook-audio-progress'
const UI_PREFERENCES_KEY = 'storybook-ui-preferences'
const LIBRARY_SNAPSHOT_KEY = 'storybook-library-snapshot'
const LIVE_PREFETCH_PAGES = 2
const AUDIO_PLAYBACK_RATES = [0.75, 1, 1.25, 1.5, 2] as const

function resolveProviderModel(provider: ProviderCatalog | null, requestedModel?: string | null) {
  if (!provider?.models.length) {
    return undefined
  }

  if (requestedModel && provider.models.some((model) => model.id === requestedModel)) {
    return requestedModel
  }

  return provider.defaultModel ?? provider.models[0]?.id ?? undefined
}

function filterVoicesForModel(voices: VoiceOption[], modelId?: string | null) {
  if (!modelId) {
    return voices
  }

  return voices.filter((voice) => !voice.models?.length || voice.models.includes(modelId))
}

function resolveProviderVoice(
  provider: ProviderCatalog | null,
  requestedVoice?: string | null,
  modelId?: string | null,
) {
  if (!provider) {
    return undefined
  }

  const availableVoices = filterVoicesForModel(provider.voices, modelId)
  if (!availableVoices.length) {
    return undefined
  }

  if (requestedVoice && availableVoices.some((voice) => voice.id === requestedVoice)) {
    return requestedVoice
  }

  if (provider.defaultVoice && availableVoices.some((voice) => voice.id === provider.defaultVoice)) {
    return provider.defaultVoice
  }

  return availableVoices[0]?.id
}

function snapshotProviderFormDefaults(form: ReaderForm): ProviderFormDefaults {
  return {
    voice: form.voice,
    model: form.model,
    outputFormat: form.outputFormat,
    narrationStyle: form.narrationStyle,
    lengthScale: form.lengthScale,
    sentenceSilence: form.sentenceSilence,
  }
}

function normalizeProviderFormDefaults(
  value: Partial<ProviderFormDefaults> | null | undefined,
  fallback: ProviderFormDefaults,
  defaultNarrationStyle = '',
): ProviderFormDefaults {
  return {
    voice: typeof value?.voice === 'string' ? value.voice : fallback.voice,
    model: typeof value?.model === 'string' ? value.model : fallback.model,
    outputFormat: isStoredOutputFormat(value?.outputFormat) ? value.outputFormat : fallback.outputFormat,
    narrationStyle:
      typeof value?.narrationStyle === 'string'
        ? value.narrationStyle
        : fallback.narrationStyle || defaultNarrationStyle,
    lengthScale: clampPreference(value?.lengthScale, 0.6, 1.5, fallback.lengthScale),
    sentenceSilence: clampPreference(value?.sentenceSilence, 0, 1, fallback.sentenceSilence),
  }
}

function restoreFormForProvider(
  provider: ProviderCatalog | null,
  providerId: AudioControlProviderId,
  storedDefaults: Partial<Record<AudioControlProviderId, ProviderFormDefaults>>,
  fallbackForm: ReaderForm,
): ReaderForm {
  const fallbackModel = resolveProviderModel(provider, fallbackForm.model) ?? ''
  const fallbackVoice = resolveProviderVoice(provider, fallbackForm.voice, fallbackModel) ?? ''
  const normalizedDefaults = normalizeProviderFormDefaults(
    storedDefaults[providerId],
    snapshotProviderFormDefaults({
      ...fallbackForm,
      provider: providerId,
      model: fallbackModel,
      voice: fallbackVoice,
    }),
    fallbackForm.narrationStyle,
  )
  const nextModel = resolveProviderModel(provider, normalizedDefaults.model) ?? ''
  const nextVoice = resolveProviderVoice(provider, normalizedDefaults.voice, nextModel) ?? ''

  return {
    ...fallbackForm,
    provider: providerId,
    voice: nextVoice,
    model: nextModel,
    outputFormat: normalizedDefaults.outputFormat,
    narrationStyle: normalizedDefaults.narrationStyle,
    lengthScale: normalizedDefaults.lengthScale,
    sentenceSilence: normalizedDefaults.sentenceSilence,
  }
}

function sameProviderFormDefaults(
  left: ProviderFormDefaults | null | undefined,
  right: ProviderFormDefaults,
) {
  return (
    left?.voice === right.voice &&
    left?.model === right.model &&
    left?.outputFormat === right.outputFormat &&
    left?.narrationStyle === right.narrationStyle &&
    left?.lengthScale === right.lengthScale &&
    left?.sentenceSilence === right.sentenceSilence
  )
}

function resolveLiveConfigForProvider(
  provider: ProviderCatalog | null,
  form: Pick<
    ReaderForm,
    'voice' | 'model' | 'outputFormat' | 'narrationStyle' | 'lengthScale' | 'sentenceSilence'
  >,
): ResolvedLiveConfig | null {
  if (!provider || !provider.available || !provider.voices.length) {
    return null
  }

  const chosenModel = resolveProviderModel(provider, form.model)
  const chosenVoice = resolveProviderVoice(provider, form.voice, chosenModel)

  if (!chosenVoice) {
    return null
  }

  return {
    provider: provider.id,
    providerName: provider.name,
    voice: chosenVoice,
    model: chosenModel,
    outputFormat: form.outputFormat === 'wav' ? 'wav' : 'mp3',
    narrationStyle: form.narrationStyle,
    lengthScale: form.lengthScale,
    sentenceSilence: form.sentenceSilence,
  }
}

function isLiveProviderTemporaryError(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
  return (
    message.includes('quota') ||
    message.includes('rate limit') ||
    message.includes('rate-limit') ||
    message.includes('too many requests') ||
    message.includes('retry in') ||
    message.includes('status 429')
  )
}

function liveProviderFallbackMessage(error: unknown, providerName: string, fallbackProviderName: string) {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
  if (message.includes('quota')) {
    return `${providerName} hit its current API quota. Retrying with ${fallbackProviderName}...`
  }
  return `${providerName} is temporarily unavailable. Retrying with ${fallbackProviderName}...`
}

function liveProviderFallbackStatus(error: unknown, providerName: string, fallbackProviderName: string) {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
  if (message.includes('quota')) {
    return `${providerName} hit its current API quota or rate limit. Retrying with ${fallbackProviderName}.`
  }
  return `${providerName} hit a temporary quota or rate limit. Retrying with ${fallbackProviderName}.`
}

function isAudioControlProviderId(value: unknown): value is AudioControlProviderId {
  return value === 'google' || value === 'polly' || value === 'qwen'
}

function filterAudioControlProviders(items: ProviderCatalog[]) {
  return items.filter((provider) => isAudioControlProviderId(provider.id))
}

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

function readStoredLibrarySnapshot(): StoredLibrarySnapshot {
  const fallback: StoredLibrarySnapshot = {
    books: [],
    providers: [],
  }

  if (typeof window === 'undefined') {
    return fallback
  }

  try {
    const raw = window.localStorage.getItem(LIBRARY_SNAPSHOT_KEY)
    if (!raw) {
      return fallback
    }

    const parsed = JSON.parse(raw) as Partial<StoredLibrarySnapshot>
    return {
      books: Array.isArray(parsed.books) ? (parsed.books as Book[]) : [],
      providers: Array.isArray(parsed.providers)
        ? filterAudioControlProviders(parsed.providers as ProviderCatalog[])
        : [],
    }
  } catch {
    return fallback
  }
}

function isStoredProvider(value: unknown): value is ReaderForm['provider'] {
  return isAudioControlProviderId(value)
}

function isStoredOutputFormat(value: unknown): value is ReaderForm['outputFormat'] {
  return value === 'mp3' || value === 'm4b' || value === 'wav'
}

function isStoredReaderFontFamily(value: unknown): value is ReaderAppearance['fontFamily'] {
  return value === 'serif' || value === 'sans'
}

function isStoredReaderLineHeight(value: unknown): value is ReaderAppearance['lineHeight'] {
  return value === 'compact' || value === 'comfortable' || value === 'airy'
}

function isStoredReaderPageWidth(value: unknown): value is ReaderAppearance['pageWidth'] {
  return value === 'narrow' || value === 'balanced' || value === 'wide'
}

function isStoredReaderTextAlign(value: unknown): value is ReaderAppearance['textAlign'] {
  return value === 'left' || value === 'justify'
}

function clampPreference(value: unknown, minimum: number, maximum: number, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback
}

function readStoredUiPreferences(): StoredUiPreferences {
  const fallback: StoredUiPreferences = {
    readerForm: initialForm,
    providerDefaults: {},
    readerAppearance: initialReaderAppearance,
    readerFontScales: {},
    audioPlaybackRate: 1,
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
      providerDefaults?: Partial<Record<AudioControlProviderId, Partial<ProviderFormDefaults>>>
      readerAppearance?: Partial<ReaderAppearance>
    }
    const readerForm: Partial<ReaderForm> = parsed.readerForm ?? {}
    const providerDefaults: Partial<Record<AudioControlProviderId, ProviderFormDefaults>> = {}
    const readerAppearance: Partial<ReaderAppearance> = parsed.readerAppearance ?? {}
    const readerFontScales: Record<string, number> = {}

    for (const [providerId, value] of Object.entries(parsed.providerDefaults ?? {})) {
      if (!isAudioControlProviderId(providerId) || !value || typeof value !== 'object') {
        continue
      }

      providerDefaults[providerId] = normalizeProviderFormDefaults(
        value,
        snapshotProviderFormDefaults(initialForm),
      )
    }

    for (const [bookId, value] of Object.entries(parsed.readerFontScales ?? {})) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        continue
      }
      readerFontScales[bookId] = clampPreference(value, READER_FONT_SCALE_MIN, READER_FONT_SCALE_MAX, 1)
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
      providerDefaults,
      readerAppearance: {
        fontFamily: isStoredReaderFontFamily(readerAppearance.fontFamily)
          ? readerAppearance.fontFamily
          : initialReaderAppearance.fontFamily,
        lineHeight: isStoredReaderLineHeight(readerAppearance.lineHeight)
          ? readerAppearance.lineHeight
          : initialReaderAppearance.lineHeight,
        pageWidth: isStoredReaderPageWidth(readerAppearance.pageWidth)
          ? readerAppearance.pageWidth
          : initialReaderAppearance.pageWidth,
        textAlign: isStoredReaderTextAlign(readerAppearance.textAlign)
          ? readerAppearance.textAlign
          : initialReaderAppearance.textAlign,
      },
      readerFontScales,
      audioPlaybackRate: clampPreference(parsed.audioPlaybackRate, 0.75, 2, fallback.audioPlaybackRate),
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

function estimateSentenceTimingWeight(text: string) {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return 1
  }

  const tokenCount = normalized.split(/\s+/).length
  const commaCount = (normalized.match(/,/g) ?? []).length
  const pauseMarkCount = (normalized.match(/[;:]/g) ?? []).length
  return Math.max(1, tokenCount + commaCount * 0.35 + pauseMarkCount * 0.5 + 0.25)
}

function buildWeightedSentenceCues(cues: SentenceCue[]) {
  if (!cues.length) {
    return [] as WeightedSentenceCue[]
  }

  const weights = cues.map((cue) => estimateSentenceTimingWeight(cue.text))
  const totalWeight = weights.reduce((sum, value) => sum + value, 0) || cues.length
  let weightCursor = 0

  return cues.map((cue, index) => {
    const weightStart = weightCursor / totalWeight
    weightCursor += weights[index]
    const weightEnd = weightCursor / totalWeight
    return {
      ...cue,
      weightStart,
      weightEnd,
    }
  })
}

function findWeightedSentenceCueAtFraction(cues: WeightedSentenceCue[], fraction: number) {
  let low = 0
  let high = cues.length - 1

  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const cue = cues[middle]

    if (fraction < cue.weightStart) {
      high = middle - 1
      continue
    }

    if (fraction >= cue.weightEnd) {
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

function findTimingCueAtTime(manifest: AudioTimingManifest, time: number) {
  const cues = manifest.cues
  let low = 0
  let high = cues.length - 1

  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const cue = cues[middle]

    if (time < cue.timeStart) {
      high = middle - 1
      continue
    }

    if (time >= cue.timeEnd) {
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

function clampUnitInterval(value: number) {
  if (!Number.isFinite(value)) {
    return 0
  }
  return Math.max(0, Math.min(1, value))
}

function interpolateTextOffset(start: number, end: number, fraction: number) {
  if (end <= start) {
    return start
  }

  return Math.max(
    start,
    Math.min(Math.max(start, end - 1), start + Math.floor((end - start) * clampUnitInterval(fraction))),
  )
}

function createSpokenRange(text: string, start: number, end: number): SpokenRange | null {
  const safeStart = Math.max(0, Math.min(text.length, start))
  const safeEnd = Math.max(safeStart, Math.min(text.length, end))
  if (safeEnd <= safeStart) {
    return null
  }

  return {
    start: safeStart,
    end: safeEnd,
    text: text.slice(safeStart, safeEnd),
  }
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
  const [books, setBooks] = useState<Book[]>(() => readStoredLibrarySnapshot().books)
  const [providers, setProviders] = useState<ProviderCatalog[]>(() => readStoredLibrarySnapshot().providers)
  const [route, setRoute] = useState<AppRoute>(() => readInitialRoute(window.location.pathname))
  const [readerTabs, setReaderTabs] = useState<Record<string, ReaderTab>>(() => readStoredSession().readerTabs)
  const [readingProgress, setReadingProgress] = useState<Record<string, ReadingProgress>>(() =>
    readStoredProgress(),
  )
  const [form, setForm] = useState<ReaderForm>(() => readStoredUiPreferences().readerForm)
  const [providerDefaults, setProviderDefaults] = useState<
    Partial<Record<AudioControlProviderId, ProviderFormDefaults>>
  >(() => readStoredUiPreferences().providerDefaults)
  const [readerAppearance, setReaderAppearance] = useState<ReaderAppearance>(
    () => readStoredUiPreferences().readerAppearance,
  )
  const [readerFontScales, setReaderFontScales] = useState<Record<string, number>>(
    () => readStoredUiPreferences().readerFontScales,
  )
  const [audioPlaybackRate, setAudioPlaybackRate] = useState<number>(() => readStoredUiPreferences().audioPlaybackRate)
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
  const [chapterNavOpen, setChapterNavOpen] = useState(false)
  const [chapterQuery, setChapterQuery] = useState('')
  const [floatingReaderMenuVisible, setFloatingReaderMenuVisible] = useState(false)
  const [readerHighlightFocus, setReaderHighlightFocus] = useState<{
    token: number
    start: number
    end: number
  } | null>(null)
  const [removingHighlightId, setRemovingHighlightId] = useState<string | null>(null)
  const [deletingBookId, setDeletingBookId] = useState<string | null>(null)
  const [cancellingJob, setCancellingJob] = useState(false)
  const [audioDockOpen, setAudioDockOpen] = useState(false)
  const [audioPlaying, setAudioPlaying] = useState(false)
  const [, setAudioJumpMessage] = useState('')
  const [pendingAudioSeek, setPendingAudioSeek] = useState<number | null>(null)
  const [pendingAudioPlay, setPendingAudioPlay] = useState(false)
  const [spokenRange, setSpokenRange] = useState<SpokenRange | null>(null)
  const [readerNarrationFocusToken, setReaderNarrationFocusToken] = useState(0)
  const [audioTimingManifest, setAudioTimingManifest] = useState<AudioTimingManifest | null>(null)
  const [liveAudioMode, setLiveAudioMode] = useState<LivePlaybackMode>(null)
  const [liveAudioLoading, setLiveAudioLoading] = useState(false)
  const [liveAudioError, setLiveAudioError] = useState('')
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
  const liveRequestConfigRef = useRef<ResolvedLiveConfig | null>(null)
  const chapterNavRef = useRef<HTMLDivElement | null>(null)
  const lastReaderScrollYRef = useRef(0)
  const floatingReaderMenuVisibleRef = useRef(false)
  const floatingReaderMenuFrameRef = useRef<number | null>(null)

  const selectedBookId = route.kind === 'book' ? route.bookId : ''
  const selectedBook = route.kind === 'book' ? books.find((book) => book.id === route.bookId) ?? null : null
  const selectedProvider = providers.find((provider) => provider.id === form.provider) ?? null
  const currentProvider =
    providers.find((provider) => provider.id === form.provider) ?? providers[0] ?? null
  const resolvedLiveConfig = useMemo(
    () => resolveLiveConfigForProvider(selectedProvider, form),
    [form, selectedProvider],
  )
  const fallbackLiveConfig = useMemo(() => {
    for (const provider of providers) {
      if (provider.id === selectedProvider?.id) {
        continue
      }
      const resolved = resolveLiveConfigForProvider(provider, form)
      if (resolved) {
        return resolved
      }
    }
    return null
  }, [form, providers, selectedProvider?.id])
  const liveReadUnavailableMessage = useMemo(() => {
    if (!selectedProvider) {
      return 'Select a live voice provider in Audio before using Play here.'
    }
    if (!selectedProvider.available) {
      return `${selectedProvider.name} is not ready in Audio yet.`
    }
    if (!selectedProvider.voices.length) {
      return `No voices are available for ${selectedProvider.name} yet.`
    }
    return 'Live audio settings are not ready yet.'
  }, [selectedProvider])
  const sentenceCues = useMemo(() => buildSentenceCues(readerPayload?.text ?? ''), [readerPayload?.text])
  const weightedSentenceCues = useMemo(() => buildWeightedSentenceCues(sentenceCues), [sentenceCues])
  const readerPages = useMemo(() => paginateReaderText(readerPayload?.text ?? ''), [readerPayload?.text])
  const readerChapters = useMemo(
    () => extractReaderChapters(readerPayload?.text ?? '', readerPages),
    [readerPayload?.text, readerPages],
  )
  const filteredReaderChapters = useMemo(() => {
    const query = chapterQuery.trim().toLowerCase()
    if (!query) {
      return readerChapters
    }

    return readerChapters.filter((chapter) => {
      const title = chapter.title.toLowerCase()
      return title.includes(query) || `page ${chapter.pageNumber}`.includes(query)
    })
  }, [chapterQuery, readerChapters])
  const currentAudioSrc =
    liveAudioMode !== null ? liveAudioCurrent?.url : selectedBook?.latestAudio?.url
  const selectedReaderFontScale = selectedBookId ? readerFontScales[selectedBookId] ?? 1 : 1

  useEffect(() => {
    const audio = audioPlayerRef.current
    if (!audio) {
      return
    }
    audio.defaultPlaybackRate = audioPlaybackRate
    audio.playbackRate = audioPlaybackRate
  }, [audioPlaybackRate, currentAudioSrc])

  useEffect(() => {
    if (!narrationOpen) {
      return
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setNarrationOpen(false)
      }
    }

    window.addEventListener('keydown', handleKeyDown)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [narrationOpen])

  useEffect(() => {
    if (!chapterNavOpen) {
      return
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) {
        return
      }

      if (chapterNavRef.current?.contains(target)) {
        return
      }

      setChapterNavOpen(false)
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setChapterNavOpen(false)
      }
    }

    window.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [chapterNavOpen])

  useEffect(() => {
    floatingReaderMenuVisibleRef.current = floatingReaderMenuVisible
  }, [floatingReaderMenuVisible])

  const syncFloatingReaderMenuVisibility = useEffectEvent((nextVisible: boolean) => {
    if (floatingReaderMenuVisibleRef.current === nextVisible) {
      return
    }

    floatingReaderMenuVisibleRef.current = nextVisible
    setFloatingReaderMenuVisible(nextVisible)
  })

  useEffect(() => {
    if (route.kind !== 'book') {
      syncFloatingReaderMenuVisibility(false)
      lastReaderScrollYRef.current = 0
      return
    }

    const updateVisibilityFromScroll = (currentY: number) => {
      const previousY = lastReaderScrollYRef.current
      const delta = currentY - previousY
      let nextVisible = floatingReaderMenuVisibleRef.current

      if (chapterNavOpen || narrationOpen) {
        nextVisible = currentY > 48
        lastReaderScrollYRef.current = currentY
        syncFloatingReaderMenuVisibility(nextVisible)
        return
      }

      if (currentY < 140) {
        nextVisible = false
      } else if (delta <= -8) {
        nextVisible = true
      } else if (delta >= 12) {
        nextVisible = false
      }

      lastReaderScrollYRef.current = currentY
      syncFloatingReaderMenuVisibility(nextVisible)
    }

    const handleScroll = () => {
      if (floatingReaderMenuFrameRef.current !== null) {
        return
      }

      floatingReaderMenuFrameRef.current = window.requestAnimationFrame(() => {
        floatingReaderMenuFrameRef.current = null
        updateVisibilityFromScroll(window.scrollY)
      })
    }

    lastReaderScrollYRef.current = window.scrollY
    updateVisibilityFromScroll(window.scrollY)
    window.addEventListener('scroll', handleScroll, { passive: true })

    return () => {
      if (floatingReaderMenuFrameRef.current !== null) {
        window.cancelAnimationFrame(floatingReaderMenuFrameRef.current)
        floatingReaderMenuFrameRef.current = null
      }
      window.removeEventListener('scroll', handleScroll)
    }
  }, [chapterNavOpen, narrationOpen, route.kind])

  useEffect(() => {
    liveAudioCurrentRef.current = liveAudioCurrent
  }, [liveAudioCurrent])

  useEffect(() => {
    liveAudioQueueRef.current = liveAudioQueue
  }, [liveAudioQueue])

  useEffect(() => {
    if (liveAudioMode === null || !pendingAudioPlay || !currentAudioSrc) {
      return
    }

    const audio = audioPlayerRef.current
    if (!audio) {
      return
    }

    audio.pause()
    audio.load()
  }, [currentAudioSrc, liveAudioMode, pendingAudioPlay])

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
    setLiveAudioError('')
    setLiveAudioCurrent(null)
    setLiveAudioQueue([])
    setAudioPlaying(false)
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

  function handleSelectChapter(chapter: ReaderChapter) {
    setReaderTab('reader')
    syncReaderToPage(chapter.pageNumber)
    setChapterNavOpen(false)
    setChapterQuery('')
  }

  function handleJumpToHighlight(highlight: Highlight) {
    const location = highlightLocations[highlight.id]
    if (!location) {
      return
    }

    setReaderTab('reader')
    setChapterNavOpen(false)
    setNarrationOpen(false)
    setReaderHighlightFocus((current) => ({
      token: (current?.token ?? 0) + 1,
      start: highlight.start,
      end: highlight.end,
    }))
    syncReaderToPage(location.startPageNumber)
  }

  async function requestLiveAudio(request: LivePlaybackRequest, configOverride?: ResolvedLiveConfig | null) {
    if (!selectedBookId) {
      throw new Error('Open a book first.')
    }

    const config = configOverride ?? liveRequestConfigRef.current
    if (!config) {
      throw new Error('Live audio settings are unavailable.')
    }

    return createLiveAudioSegment(selectedBookId, {
      provider: config.provider,
      voice: config.voice,
      model: config.model,
      output_format: config.outputFormat,
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

    if (!resolvedLiveConfig) {
      setErrorMessage(liveReadUnavailableMessage)
      return
    }

    cancelLivePlayback()
    const sessionId = liveSessionIdRef.current
    liveNextPageIndexRef.current = options.nextPageIndex
    liveRequestConfigRef.current = resolvedLiveConfig

    restoreAudioProgressRef.current = null
    setLiveAudioMode(options.mode)
    setLiveAudioLoading(true)
    setLiveAudioError('')
    setNarrationOpen(false)
    setAudioDockOpen(true)
    setAudioJumpMessage(`Generating live audio for ${options.label} with ${resolvedLiveConfig.providerName}...`)
    setStatusMessage(`Generating live audio for ${options.label} with ${resolvedLiveConfig.providerName}.`)
    setErrorMessage('')

    try {
      const segment = await requestLiveAudio(request, resolvedLiveConfig)
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

      let finalError: unknown = error
      if (fallbackLiveConfig && isLiveProviderTemporaryError(error)) {
        liveRequestConfigRef.current = fallbackLiveConfig
        setAudioJumpMessage(liveProviderFallbackMessage(error, resolvedLiveConfig.providerName, fallbackLiveConfig.providerName))
        setStatusMessage(liveProviderFallbackStatus(error, resolvedLiveConfig.providerName, fallbackLiveConfig.providerName))

        try {
          const fallbackSegment = await requestLiveAudio(request, fallbackLiveConfig)
          if (sessionId !== liveSessionIdRef.current) {
            return
          }

          activateLiveSegment(
            fallbackSegment,
            `Reading ${options.label} with ${fallbackLiveConfig.providerName}.`,
          )
          setStatusMessage(
            `${resolvedLiveConfig.providerName} was unavailable, so playback continued with ${fallbackLiveConfig.providerName}.`,
          )
          if (options.nextPageIndex < readerPages.length) {
            void prefetchLiveSegments(sessionId)
          }
          return
        } catch (fallbackError) {
          if (sessionId !== liveSessionIdRef.current) {
            return
          }
          finalError = fallbackError
        }
      }

      const message = finalError instanceof Error ? finalError.message : 'Live audio could not be generated.'
      setLiveAudioLoading(false)
      setLiveAudioError(message)
      setLiveAudioCurrent(null)
      setLiveAudioQueue([])
      setAudioDockOpen(true)
      setAudioJumpMessage('Live read could not start.')
      setErrorMessage(message)
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
    window.localStorage.setItem(READING_PROGRESS_KEY, JSON.stringify(readingProgress))
  }, [readingProgress])

  useEffect(() => {
    writeStoredValue(SESSION_STATE_KEY, {
      lastRoute: route,
      readerTabs,
    } satisfies StoredSession)
  }, [readerTabs, route])

  useEffect(() => {
    writeStoredValue(LIBRARY_SNAPSHOT_KEY, {
      books,
      providers,
    } satisfies StoredLibrarySnapshot)
  }, [books, providers])

  useEffect(() => {
    if (!isAudioControlProviderId(form.provider)) {
      return
    }

    const currentProviderId: AudioControlProviderId = form.provider
    const nextDefaults: ProviderFormDefaults = {
      voice: form.voice,
      model: form.model,
      outputFormat: form.outputFormat,
      narrationStyle: form.narrationStyle,
      lengthScale: form.lengthScale,
      sentenceSilence: form.sentenceSilence,
    }
    setProviderDefaults((previous) =>
      sameProviderFormDefaults(previous[currentProviderId], nextDefaults)
        ? previous
        : {
            ...previous,
            [currentProviderId]: nextDefaults,
          },
    )
  }, [
    form.lengthScale,
    form.model,
    form.narrationStyle,
    form.outputFormat,
    form.provider,
    form.sentenceSilence,
    form.voice,
  ])

  useEffect(() => {
    const persistedProviderDefaults =
      isAudioControlProviderId(form.provider) &&
      !sameProviderFormDefaults(providerDefaults[form.provider], snapshotProviderFormDefaults(form))
        ? {
            ...providerDefaults,
            [form.provider]: snapshotProviderFormDefaults(form),
          }
        : providerDefaults

    writeStoredValue(UI_PREFERENCES_KEY, {
      readerForm: form,
      providerDefaults: persistedProviderDefaults,
      readerAppearance,
      readerFontScales,
      audioPlaybackRate,
    } satisfies StoredUiPreferences)
  }, [audioPlaybackRate, form, providerDefaults, readerAppearance, readerFontScales])

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

    const nextModel = resolveProviderModel(currentProvider, form.model) ?? ''
    const nextVoice = resolveProviderVoice(currentProvider, form.voice, nextModel) ?? ''

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
      setChapterNavOpen(false)
      setChapterQuery('')
      setFloatingReaderMenuVisible(false)
      setReaderHighlightFocus(null)
      return
    }

    setChapterNavOpen(false)
    setChapterQuery('')
    setFloatingReaderMenuVisible(false)
    setReaderHighlightFocus(null)
    void loadReaderPayload(selectedBookId)
  }, [selectedBookId])

  useEffect(() => {
    const timingUrl = selectedBook?.latestAudio?.timingUrl
    const audioUrl = selectedBook?.latestAudio?.url
    if (!timingUrl || !audioUrl) {
      setAudioTimingManifest(null)
      return
    }

    let cancelled = false
    void apiRequest<AudioTimingManifest>(timingUrl)
      .then((manifest) => {
        if (cancelled) {
          return
        }
        setAudioTimingManifest(manifest.audioUrl === audioUrl ? manifest : null)
      })
      .catch((error) => {
        if (cancelled) {
          return
        }
        console.error('Failed to load audio timing manifest.', error)
        setAudioTimingManifest(null)
      })

    return () => {
      cancelled = true
    }
  }, [selectedBook?.latestAudio?.timingUrl, selectedBook?.latestAudio?.url])

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

  const bootstrap = useEffectEvent(async () => {
    try {
      setLoading(true)
      const [providerResponse, bookResponse] = await Promise.all([
        fetchProviders(),
        fetchBooks(),
      ])

      const nextProviders = filterAudioControlProviders(providerResponse.providers)
      setProviders(nextProviders)
      setBooks(bookResponse.items)
      const resolvedProvider =
        nextProviders.find((provider) => provider.id === form.provider) ??
        nextProviders[0] ??
        null
      if (resolvedProvider) {
        const resolvedProviderId = resolvedProvider.id as AudioControlProviderId
        setForm((previous) =>
          restoreFormForProvider(resolvedProvider, resolvedProviderId, providerDefaults, {
            ...previous,
            provider: resolvedProviderId,
            narrationStyle: previous.narrationStyle || providerResponse.defaultNarrationStyle,
          }),
        )
      } else {
        setForm((previous) => ({
          ...previous,
          narrationStyle: previous.narrationStyle || providerResponse.defaultNarrationStyle,
        }))
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to load the app.')
    } finally {
      setLoading(false)
    }
  })

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
    const nextScale = Math.min(READER_FONT_SCALE_MAX, Math.max(READER_FONT_SCALE_MIN, fontScale))
    setReaderFontScales((previous) =>
      previous[bookId] === nextScale
        ? previous
        : {
            ...previous,
            [bookId]: nextScale,
          },
    )
  }

  function applyAudioSeek(audio: HTMLAudioElement, fraction: number) {
    if (!Number.isFinite(audio.duration) || audio.duration <= 0) {
      return false
    }

    const safeDuration = Math.max(audio.duration - 0.25, 0)
    audio.currentTime = Math.min(safeDuration, Math.max(0, audio.duration * fraction))
    return true
  }

  const resolveAudioTextPosition = (audio: HTMLAudioElement | null): AudioTextPosition | null => {
    const text = readerPayload?.text ?? ''
    const textLength = text.length
    if (!audio || textLength <= 0 || !Number.isFinite(audio.duration) || audio.duration <= 0) {
      return null
    }

    const playbackFraction = clampUnitInterval(audio.currentTime / audio.duration)
    const liveSegment = liveAudioCurrentRef.current

    if (liveSegment) {
      const offset = interpolateTextOffset(liveSegment.start, liveSegment.end, playbackFraction)
      const cue = sentenceCues.length ? findSentenceCueAtOffset(sentenceCues, offset) : null
      return {
        offset,
        range: cue ?? createSpokenRange(text, liveSegment.start, liveSegment.end),
      }
    }

    if (audioTimingManifest?.cues.length) {
      const timingCue = findTimingCueAtTime(audioTimingManifest, audio.currentTime)
      if (timingCue) {
        const cueDuration = Math.max(0, timingCue.timeEnd - timingCue.timeStart)
        const cueFraction =
          cueDuration > 0 ? clampUnitInterval((audio.currentTime - timingCue.timeStart) / cueDuration) : 0
        const offset = interpolateTextOffset(timingCue.start, timingCue.end, cueFraction)
        return {
          offset,
          range: createSpokenRange(text, timingCue.start, timingCue.end),
        }
      }
    }

    if (weightedSentenceCues.length) {
      const cue = findWeightedSentenceCueAtFraction(weightedSentenceCues, playbackFraction)
      if (cue) {
        const cueFractionSpan = cue.weightEnd - cue.weightStart
        const cueFraction =
          cueFractionSpan > 0 ? clampUnitInterval((playbackFraction - cue.weightStart) / cueFractionSpan) : 0
        return {
          offset: interpolateTextOffset(cue.start, cue.end, cueFraction),
          range: cue,
        }
      }
    }

    const estimatedOffset = Math.min(
      Math.max(0, textLength - 1),
      Math.max(0, Math.floor(textLength * playbackFraction)),
    )
    const cue = findSentenceCueAtOffset(sentenceCues, estimatedOffset)
    return {
      offset: estimatedOffset,
      range: cue,
    }
  }

  function syncReaderToAudioPosition(audio: HTMLAudioElement | null) {
    if (!audio || !readerPages.length) {
      return false
    }

    const position = resolveAudioTextPosition(audio)
    if (!position) {
      return false
    }

    const pageIndex = findReaderPageIndexForOffset(position.offset)
    if (pageIndex < 0) {
      return false
    }

    const pageNumber = pageIndex + 1
    if (currentProgress?.pageNumber === pageNumber) {
      return false
    }

    syncReaderToPage(pageNumber)
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

  async function handlePlayFromSelection(payload: { start: number; end: number; text: string }) {
    const selectionRequest = liveRequestFromSelection(payload.start)
    if (!selectionRequest) {
      setErrorMessage('This selection does not map to readable page text yet.')
      return
    }

    if (!resolvedLiveConfig) {
      setErrorMessage(liveReadUnavailableMessage)
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
    const position = resolveAudioTextPosition(audioPlayerRef.current)
    if (!position?.range) {
      setSpokenRange(null)
      return
    }

    const range = position.range

    setSpokenRange((current) =>
      current &&
      current.start === range.start &&
      current.end === range.end &&
      current.text === range.text
        ? current
        : range,
    )
  }

  function handleAudioPlay() {
    setNarrationOpen(false)
    setAudioDockOpen(true)
    setAudioPlaying(true)
    syncSpokenRangeFromAudio()
    setReaderNarrationFocusToken((current) => current + 1)

    if (liveAudioMode !== null) {
      if (skipDisplayedPageSyncOnNextPlayRef.current) {
        skipDisplayedPageSyncOnNextPlayRef.current = false
      }
      syncReaderToAudioPosition(audioPlayerRef.current)
      return
    }

    if (skipDisplayedPageSyncOnNextPlayRef.current) {
      skipDisplayedPageSyncOnNextPlayRef.current = false
    }

    syncReaderToAudioPosition(audioPlayerRef.current)

    persistCurrentAudioProgress(true)
  }

  function handleAudioPause() {
    setAudioPlaying(false)
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
    syncReaderToAudioPosition(audioPlayerRef.current)
    persistCurrentAudioProgress()
  }

  function handleAudioSeeked() {
    syncSpokenRangeFromAudio()
    if (liveAudioMode !== null) {
      return
    }
    syncReaderToAudioPosition(audioPlayerRef.current)
    persistCurrentAudioProgress(true)
  }

  function handleAudioEnded() {
    setAudioPlaying(false)
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

  async function toggleAudioPlayback() {
    const audio = audioPlayerRef.current
    if (!audio) {
      return
    }

    if (audio.paused || audio.ended) {
      try {
        await audio.play()
      } catch {
        setErrorMessage('Playback could not start.')
      }
      return
    }

    audio.pause()
  }

  async function uploadBookFile(file: File, title?: string | null) {
    if (!(file instanceof File)) {
      setErrorMessage('Choose a PDF first.')
      return null
    }

    try {
      setUploading(true)
      setErrorMessage('')
      const requestedTitle = typeof title === 'string' ? title.trim() : ''
      const uploadLabel = requestedTitle || file.name
      const hostedUpload = usesHostedFunctionUploadLimit()
      setStatusMessage(
        hostedUpload
          ? `Uploading ${uploadLabel} to durable storage and extracting readable text.`
          : `Uploading ${uploadLabel} and extracting readable text.`,
      )
      const book = hostedUpload
        ? await uploadBookDirectToStorage(file, requestedTitle || undefined)
        : await (async () => {
            const payload = new FormData()
            payload.append('file', file)
            if (requestedTitle) {
              payload.append('title', requestedTitle)
            }
            return apiRequest<Book>('/api/books', {
              method: 'POST',
              body: payload,
            })
          })()
      setBooks((previous) => upsertBook(previous, book))
      navigateToLibrary()
      setStatusMessage(`Imported ${book.title}.`)
      return book
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Upload failed.')
      return null
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
      const chosenModel = resolveProviderModel(currentProvider, form.model)
      const chosenVoice = resolveProviderVoice(currentProvider, form.voice, chosenModel)
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
          voice: chosenVoice,
          model: chosenModel,
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

    const chosenModel = resolveProviderModel(currentProvider, form.model)
    const chosenVoice = resolveProviderVoice(currentProvider, voiceId || form.voice, chosenModel)

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
        model: chosenModel,
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

  function setProvider(provider: 'piper' | 'google' | 'openai' | 'polly' | 'qwen') {
    const match = providers.find((item) => item.id === provider)
    if (!isAudioControlProviderId(provider)) {
      const nextModel = resolveProviderModel(match ?? null, match?.defaultModel)
      const nextVoice = resolveProviderVoice(match ?? null, match?.defaultVoice, nextModel)
      setForm((previous) => ({
        ...previous,
        provider,
        voice: nextVoice ?? '',
        model: nextModel ?? '',
      }))
      return
    }

    const currentProviderId = isAudioControlProviderId(form.provider) ? form.provider : null
    const nextProviderDefaults = currentProviderId
      ? {
          ...providerDefaults,
          [currentProviderId]: snapshotProviderFormDefaults(form),
        }
      : providerDefaults

    setProviderDefaults((previous) => {
      const currentSnapshot = currentProviderId ? snapshotProviderFormDefaults(form) : null
      if (!currentProviderId || !currentSnapshot || sameProviderFormDefaults(previous[currentProviderId], currentSnapshot)) {
        return previous
      }
      return {
        ...previous,
        [currentProviderId]: currentSnapshot,
      }
    })

    setForm((previous) =>
      restoreFormForProvider(match ?? null, provider, nextProviderDefaults, {
        ...previous,
        provider,
      }),
    )
  }

  const modelOptions = currentProvider?.models ?? []
  const selectedModelId = resolveProviderModel(currentProvider, form.model) ?? null
  const selectedModel = modelOptions.find((model) => model.id === selectedModelId) ?? null
  const voiceOptions: VoiceOption[] =
    currentProvider ? filterVoicesForModel(currentProvider.voices, selectedModelId) : []
  const selectedVoice = voiceOptions.find((voice) => voice.id === form.voice) ?? null
  const providerStatusTitle = (() => {
    if (!currentProvider) {
      return ''
    }

    if (currentProvider.id === 'polly' && pollyHealth) {
      return pollyHealth.connected ? 'Amazon Polly is ready' : 'Amazon Polly needs attention'
    }

    return currentProvider.available ? `${currentProvider.name} is ready` : `${currentProvider.name} needs setup`
  })()
  const providerStatusMessage = (() => {
    if (!currentProvider) {
      return ''
    }

    if (currentProvider.id === 'polly' && pollyHealth) {
      return pollyHealth.connected
        ? `Connected in ${pollyHealth.region}. Use it for a steady, provider-native read with fast previews and exports.`
        : pollyHealth.message
    }

    return currentProvider.description
  })()
  const providerStatusFacts = (() => {
    if (!currentProvider) {
      return []
    }

    const facts: string[] = []

    if (currentProvider.id === 'polly' && pollyHealth) {
      if (selectedVoice?.label) {
        facts.push(selectedVoice.label)
      } else if (pollyHealth.defaultVoice) {
        facts.push(`Default ${pollyHealth.defaultVoice}`)
      }

      facts.push(`${pollyHealth.voiceCount} voices`)
      facts.push(pollyHealth.engine)
      facts.push(pollyHealth.region)
      return facts
    }

    if (selectedVoice?.label) {
      facts.push(selectedVoice.label)
    }

    if (selectedModel?.label) {
      facts.push(selectedModel.label)
    }

    if (selectedModel?.storytelling) {
      facts.push('Storytelling-ready')
    }

    return facts
  })()
  const currentProgress = selectedBook ? readingProgress[selectedBook.id] : null
  const readerFileLabel = selectedBook?.fileName.replace(/\.pdf$/i, '') ?? ''
  const readingProgressLabel = currentProgress
    ? `Page ${currentProgress.pageNumber} of ${currentProgress.totalPages}`
    : 'Not started'
  const audioStatusLabel = selectedBook?.latestAudio ? 'Audio ready' : 'No audio yet'
  const highlightLocations = useMemo(
    () => buildHighlightLocations(readerPayload?.text ?? '', readerPages, readerPayload?.highlights ?? []),
    [readerPages, readerPayload?.highlights, readerPayload?.text],
  )
  const liveReadAvailable = Boolean(selectedBook) && Boolean(resolvedLiveConfig) && readerPages.length > 0
  const canPlayFromReaderSelection = liveReadAvailable
  const showAudioDock =
    (audioDockOpen || audioPlaying) &&
    (Boolean(currentAudioSrc) ||
      liveAudioLoading ||
      Boolean(liveAudioError) ||
      (liveAudioMode !== null && !selectedBook?.latestAudio))
  const audioBarTitle =
    liveAudioMode !== null
      ? `${liveAudioCurrent?.provider ?? liveRequestConfigRef.current?.provider ?? form.provider} • live`
      : selectedBook?.latestAudio
        ? `${selectedBook.latestAudio.provider} • ${selectedBook.latestAudio.format}`
        : 'Narration'
  const audioBarNarrator =
    liveAudioMode !== null
      ? liveAudioCurrent?.voice ?? liveRequestConfigRef.current?.voice ?? selectedVoice?.label ?? 'Narrator'
      : selectedBook?.latestAudio?.voice ?? selectedVoice?.label ?? 'Narrator'
  const jobBusy =
    activeJob !== null &&
    activeJob.status !== 'completed' &&
    activeJob.status !== 'failed' &&
    activeJob.status !== 'cancelled'

  function renderReaderControls(compact = false) {
    return (
      <div className={`reader-screen__controls ${compact ? 'reader-screen__controls--compact' : ''}`}>
        <div className="view-toggle" role="tablist" aria-label="Reading views">
          <button className={readerTab === 'reader' ? 'active' : ''} onClick={() => setReaderTab('reader')} type="button">
            Reader
          </button>
          <button className={readerTab === 'pdf' ? 'active' : ''} onClick={() => setReaderTab('pdf')} type="button">
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
        <div className="reader-screen__chapters" ref={chapterNavRef}>
          <button
            aria-expanded={chapterNavOpen}
            aria-haspopup="dialog"
            className="secondary-button secondary-button--compact reader-screen__utility-button"
            disabled={!readerChapters.length}
            onClick={() => {
              setNarrationOpen(false)
              setChapterNavOpen((open) => !open)
            }}
            type="button"
          >
            Chapters
          </button>
          {chapterNavOpen ? (
            <div className="chapters-popover" role="dialog" aria-label="Chapter navigation">
              <label className="chapters-popover__search">
                <span className="sr-only">Search chapters</span>
                <input
                  autoFocus
                  onChange={(event) => setChapterQuery(event.target.value)}
                  placeholder="Search chapters"
                  type="search"
                  value={chapterQuery}
                />
              </label>
              <div className="chapters-popover__list">
                {filteredReaderChapters.length ? (
                  filteredReaderChapters.map((chapter) => (
                    <button
                      className={`chapters-popover__item ${currentProgress?.pageNumber === chapter.pageNumber ? 'active' : ''}`}
                      key={chapter.id}
                      onClick={() => handleSelectChapter(chapter)}
                      type="button"
                    >
                      <span className="chapters-popover__title">{chapter.title}</span>
                      <span className="chapters-popover__page">Page {chapter.pageNumber}</span>
                    </button>
                  ))
                ) : (
                  <p className="chapters-popover__empty">No chapters match that search.</p>
                )}
              </div>
            </div>
          ) : null}
        </div>
        <button
          className="secondary-button secondary-button--compact reader-screen__utility-button"
          onClick={() => {
            setChapterNavOpen(false)
            setNarrationOpen(true)
          }}
          type="button"
        >
          Audio
        </button>
      </div>
    )
  }

  function renderReaderFacts(compact = false) {
    return (
      <div className={`reader-screen__facts ${compact ? 'reader-screen__facts--compact' : ''}`} aria-label="Book details">
        <span className="reader-screen__fact">{selectedBook?.pageCount ?? 0} pages</span>
        <span className="reader-screen__fact">{readingProgressLabel}</span>
        <span className={`reader-screen__fact ${selectedBook?.latestAudio ? 'reader-screen__fact--ready' : ''}`}>
          {audioStatusLabel}
        </span>
      </div>
    )
  }
  const narrationPanel = (
    <aside className="panel status-panel narration-panel">
      <div className="panel-heading narration-panel__heading">
        <div className="narration-panel__intro">
          <p className="eyebrow">Narration</p>
          <h2>Audio</h2>
          <p className="narration-panel__summary">
            Choose a voice, test it, or generate a clean listening track for this book.
          </p>
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
            <span>
              {provider.available ? 'Ready' : provider.id === 'polly' ? 'Setup AWS' : 'Needs key'}
            </span>
          </button>
        ))}
      </div>

      {currentProvider ? (
        <div
          className={`provider-brief ${
            currentProvider.available ? 'provider-brief--ready' : 'provider-brief--muted'
          }`}
        >
          <div className="provider-brief__copy">
            <p className="eyebrow">Provider</p>
            <strong>{providerStatusTitle}</strong>
            <p>{providerStatusMessage}</p>
          </div>

          {providerStatusFacts.length ? (
            <div className="provider-brief__facts">
              {providerStatusFacts.map((fact) => (
                <span className="provider-brief__fact" key={fact}>
                  {fact}
                </span>
              ))}
            </div>
          ) : null}

          {form.provider === 'polly' ? (
            <button
              className="secondary-button secondary-button--compact provider-brief__action"
              disabled={pollyHealthLoading}
              onClick={() => void loadPollyHealth()}
              type="button"
            >
              {pollyHealthLoading ? 'Refreshing...' : 'Refresh'}
            </button>
          ) : null}
        </div>
      ) : null}

      <section className="narration-block">
        <div className="voice-picker">
          <div className="voice-picker__header">
            <div className="voice-picker__title">
              <div className="voice-picker__title-row">
                <span>Voice</span>
                <small className="voice-picker__selection">
                  {selectedVoice?.label || form.voice || 'Select a voice'}
                </small>
              </div>
              {currentProvider?.voiceMetaNote ? <p className="voice-picker__note">{currentProvider.voiceMetaNote}</p> : null}
            </div>
          </div>
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
                  {isPreviewing ? 'Playing' : 'Sample'}
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
      </section>

      <section className="narration-block">
        <div className="narration-block__heading">
          <p className="eyebrow">Settings</p>
          <strong>Playback and export</strong>
        </div>

        <div className="controls-grid controls-grid--compact">
          {modelOptions.length ? (
            <label className="control-field">
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

          <label className="control-field">
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
        </div>

        <div className="tuning-grid">
          <label className="control-field range-field">
            <div className="range-field__header">
              <span>Speech speed</span>
              <strong>{form.lengthScale.toFixed(2)}x</strong>
            </div>
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
            <small>Longer phrasing and slower delivery.</small>
          </label>

          <label className="control-field range-field">
            <div className="range-field__header">
              <span>Sentence pause</span>
              <strong>{form.sentenceSilence.toFixed(2)}s</strong>
            </div>
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
            <small>Extra breathing room between sentences.</small>
          </label>
        </div>

        <label className="style-field control-field">
          <span>Style direction</span>
          <textarea
            onChange={(event) =>
              setForm((previous) => ({
                ...previous,
                narrationStyle: event.target.value,
              }))
            }
            rows={3}
            value={form.narrationStyle}
          />
          <small>
            Gemini and Qwen follow this directly. Polly keeps a simpler provider-native read.
          </small>
        </label>
      </section>

      <section className="narration-block narration-block--actions">
        <div className="narration-block__heading">
          <p className="eyebrow">Actions</p>
          <strong>Preview before you export</strong>
        </div>

        <div className="action-row">
          <button
            className="secondary-button"
            disabled={testingProvider || submitting || jobBusy || !currentProvider?.available || !voiceOptions.length}
            onClick={() => void handleProviderTest()}
            type="button"
          >
            {testingProvider ? 'Testing...' : 'Preview voice'}
          </button>

          <button
            className="secondary-button"
            disabled={!liveReadAvailable || testingProvider || submitting || jobBusy}
            onClick={() => void handleStartLiveReadCurrentPage()}
            type="button"
          >
            {liveAudioLoading && liveAudioMode === 'page' ? 'Starting...' : 'Read current page'}
          </button>

          <button
            className="primary-button action-row__primary"
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
      </section>

      {providerSample ? (
        <div className="audio-card">
          <div className="audio-card__header">
            <div>
              <p className="eyebrow">Voice preview</p>
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
        <LibraryScreen
          books={books}
          deletingBookId={deletingBookId}
          errorMessage={errorMessage}
          loading={loading}
          onDeleteBook={handleDeleteBook}
          onOpenBook={navigateToBook}
          onUploadFile={uploadBookFile}
          readingProgress={readingProgress}
          statusMessage={statusMessage}
          uploading={uploading}
        />
      ) : (
        <section
          className={`reader-screen ${showAudioDock ? 'reader-screen--with-audio' : ''} ${
            floatingReaderMenuVisible ? 'reader-screen--floating-menu' : ''
          }`}
        >
          {selectedBook ? (
            <div
              aria-hidden={!floatingReaderMenuVisible}
              className={`reader-floating-bar ${floatingReaderMenuVisible ? 'active' : ''}`}
              aria-label="Reader controls"
            >
              <div className="reader-floating-bar__identity">
                <span className="reader-floating-bar__eyebrow">Reading</span>
                <strong className="reader-floating-bar__title">{selectedBook.title}</strong>
              </div>
              <div className="reader-screen__meta reader-screen__meta--compact">
                {renderReaderControls(true)}
                {renderReaderFacts(true)}
              </div>
            </div>
          ) : null}
          <div className="reader-screen__topbar">
            <div className="reader-screen__topbar-main">
              <button className="secondary-button secondary-button--compact" onClick={navigateToLibrary} type="button">
                Back to Library
              </button>
              {selectedBook ? (
                <div className="reader-screen__title">
                  <p className="eyebrow">Reading</p>
                  <h2>{selectedBook.title}</h2>
                  <p className="reader-screen__subtitle">{readerFileLabel}</p>
                </div>
              ) : null}
            </div>
            {selectedBook && !floatingReaderMenuVisible ? (
              <div className="reader-screen__meta">
                {renderReaderControls()}
                {renderReaderFacts()}
              </div>
            ) : null}
          </div>

          {selectedBook?.latestAudio || liveAudioMode !== null || liveAudioLoading ? (
            <div className={`reader-audio-bar ${showAudioDock ? 'active' : ''}`}>
              <div className="reader-audio-bar__meta">
                <p className="eyebrow">{liveAudioMode !== null ? 'Live narration' : 'Narration'}</p>
                <strong>{audioBarNarrator}</strong>
                <small>{audioBarTitle}</small>
              </div>
              <div className="reader-audio-bar__controls">
                {currentAudioSrc ? (
                  <>
                    <audio
                      className="reader-audio-bar__element"
                      key={currentAudioSrc}
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
                    <button
                      className="reader-audio-bar__play"
                      onClick={() => void toggleAudioPlayback()}
                      type="button"
                    >
                      <span className="reader-audio-bar__play-icon" aria-hidden="true">
                        {audioPlaying ? (
                          <svg viewBox="0 0 24 24">
                            <path d="M8 6h3v12H8zM13 6h3v12h-3z" />
                          </svg>
                        ) : (
                          <svg viewBox="0 0 24 24">
                            <path d="M8 6.5v11l8.5-5.5z" />
                          </svg>
                        )}
                      </span>
                      <span className="reader-audio-bar__play-copy">
                        <strong>{audioPlaying ? 'Pause' : 'Play'}</strong>
                      </span>
                    </button>
                    <label className="reader-audio-bar__speed">
                      <span>Speed</span>
                      <select
                        aria-label="Playback speed"
                        onChange={(event) => setAudioPlaybackRate(Number(event.target.value))}
                        value={audioPlaybackRate}
                      >
                        {AUDIO_PLAYBACK_RATES.map((rate) => (
                          <option key={rate} value={rate}>
                            {rate}x
                          </option>
                        ))}
                      </select>
                    </label>
                  </>
                ) : liveAudioError ? (
                  <div className="reader-audio-bar__loading reader-audio-bar__loading--error">{liveAudioError}</div>
                ) : (
                  <div className="reader-audio-bar__loading">Preparing audio...</div>
                )}
              </div>
            </div>
          ) : null}

          <div className="reader-workspace reader-workspace--clean">
            <div className="panel preview-panel reader-panel">
              {selectedBook ? (
                readerLoading ? (
                  <div className="empty-stage">
                    <strong>Opening book...</strong>
                    <p>Loading the extracted text and saved highlights.</p>
                  </div>
                ) : readerTab === 'reader' && readerPayload ? (
                  <ReaderDesk
                    canPlayFromSelection={canPlayFromReaderSelection}
                    focusRange={readerHighlightFocus}
                    focusRequest={readerHighlightFocus?.token ?? 0}
                    highlights={readerPayload.highlights}
                    initialAppearance={readerAppearance}
                    initialFontScale={selectedReaderFontScale}
                    initialPageNumber={currentProgress?.pageNumber ?? 1}
                    narrationFocusRequest={readerNarrationFocusToken}
                    onAppearanceChange={setReaderAppearance}
                    onCreateHighlight={handleCreateHighlight}
                    onFontScaleChange={(fontScale) => updateReaderFontScale(readerPayload.book.id, fontScale)}
                    onPlayFromSelection={handlePlayFromSelection}
                    onProgressChange={(payload) => updateReadingProgress(readerPayload.book.id, payload)}
                    spokenRange={spokenRange}
                    text={readerPayload.text}
                  />
                ) : readerTab === 'highlights' && readerPayload ? (
                  <HighlightsShelf
                    highlights={readerPayload.highlights}
                    highlightLocations={highlightLocations}
                    onDelete={handleDeleteHighlight}
                    onJumpToHighlight={handleJumpToHighlight}
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
