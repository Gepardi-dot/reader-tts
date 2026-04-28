import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'framer-motion'
import {
  ArrowLeft, ArrowRight, Languages, MessageSquare, Settings2, Type, Volume2, X,
  Play, Pause, SkipBack, SkipForward,
  Minus, Plus, AlignLeft, AlignCenter, AlignJustify,
  Copy, BookMarked, Globe, BookOpen, Mic, NotebookPen, Sparkles, Search,
  ChevronLeft, ChevronRight,
} from 'lucide-react'
import { Slider } from '@/components/ui/slider'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api, request, requestBlob } from '@/shared/api/client'
import { cn } from '@/lib/utils'

// ── Types ────────────────────────────────────────────────────────────────────

interface ReaderPayload {
  book: { id: string; title: string }
  text: string
  highlights: Array<{
    id: string; start: number; end: number
    color: 'amber' | 'rose' | 'sky'; text: string; note: string | null
    kind: 'highlight' | 'note' | 'vocabulary'
  }>
}

interface ReadingProgress {
  pageNumber: number
  totalPages: number
  textStart: number
  textEnd: number
  textLength: number
  updatedAt: string
}

interface ProgressPayload {
  reading: ReadingProgress | null
  audio?: {
    url: string
    currentTime: number
    wasPlaying: boolean
    updatedAt: string
  } | null
}

interface TtsVoiceOption {
  id: string
  label: string
}

interface TtsProviderInfo {
  id: string
  name: string
  available: boolean
  recommended?: boolean
  voices: TtsVoiceOption[]
  defaultVoice?: string | null
}

interface ProvidersResponse {
  defaultNarrationStyle: string
  providers: TtsProviderInfo[]
}

interface LiveAudioPayload {
  provider: string
  voice: string | null
  model: string | null
  output_format: 'mp3'
  narration_style: string
  length_scale: number
  sentence_silence: number
  pageNumber: number
  start: number
  end: number
  text: string
}

interface LiveAudioCue {
  start: number
  end: number
  timeStart: number
  timeEnd: number
}

interface LiveAudioResult {
  url: string
  duration?: number | null
  cues?: LiveAudioCue[]
}

interface ProviderTestResult {
  provider: string
  voice: string | null
  model: string | null
  sampleText: string
  audioUrl: string
  message: string
}

interface Appearance {
  fontSize: number; lineHeight: number
  font: 'serif' | 'sans'
  width: 'narrow' | 'balanced' | 'wide'
  align: 'left' | 'center' | 'justify'
  theme: 'paper' | 'white' | 'dark'
}

interface SelectionRect {
  left: number; top: number; width: number; height: number
}

interface SelectionState {
  viewportX: number; viewportY: number; selHeight: number
  selLeft: number; selWidth: number   // for custom highlight overlay
  rects: SelectionRect[]
  text: string; mode: 'word' | 'sentence'
  startOffset: number; endOffset: number
}

interface LocatedSelection {
  text: string
  startOffset: number
  endOffset: number
}

interface ReaderParagraph {
  text: string
  startOffset: number
}

type SecondaryPanel =
  | { kind: 'dictionary'; word: string }
  | { kind: 'notes'; text: string; start: number; end: number }
  | { kind: 'askai'; text: string }
  | { kind: 'translate'; text: string }

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_APPEARANCE: Appearance = {
  fontSize: 17, lineHeight: 1.85,
  font: 'serif', width: 'balanced',
  align: 'justify', theme: 'paper',
}

const WIDTH_PX  = { narrow: 520, balanced: 660, wide: 820 }
const THEMES    = {
  paper: { bg: '#fbf8f4', text: '#1c1c1e', bar: 'rgba(251,248,244,0.92)' },
  white: { bg: '#ffffff', text: '#1c1c1e', bar: 'rgba(255,255,255,0.92)' },
  dark:  { bg: '#1a1a18', text: '#e8e6e1', bar: 'rgba(26,26,24,0.92)'   },
}

const TTS_PROVIDERS = [
  { id: 'kokoro',       label: 'Kokoro (free, remote)' },
  { id: 'google',       label: 'Gemini Flash (cloud)' },
  { id: 'polly',        label: 'Amazon Polly (cloud)' },
  { id: 'openai',       label: 'OpenAI TTS (cloud)' },
  { id: 'qwen',         label: 'Qwen (cloud)' },
  { id: 'qwen_local',   label: 'Qwen Local (free, offline)' },
  { id: 'neutts_local', label: 'NeuTTS (free, offline)' },
  { id: 'piper',        label: 'Piper (offline)' },
]

// Streaming-style playback: keep the first request small so audio can start quickly,
// then synthesize larger follow-up chunks while the first chunk is playing.
const FIRST_AUDIO_CHARS: Record<string, number> = {
  google: 240,
  openai: 180,
  kokoro:  65,
  piper:  220,
}

const CHUNK_CHARS: Record<string, number> = {
  google: 420,
  openai: 800,
  kokoro: 420,
  piper:  900,
}

const DEFAULT_FIRST_AUDIO_CHARS = 180
const DEFAULT_AUDIO_CHARS = 800
const PREFETCH_CHUNK_LIMIT = 3
const LIVE_AUDIO_MEMORY_TTL_MS = 10 * 60_000
const AUDIO_SLICE_CHARS = 2200
const PROVIDER_PREVIEW_TEXT = (
  'When the room quieted, the story finally found its rhythm. '
  + 'Read this sample with natural phrasing, steady pacing, and a warm, attentive tone.'
)

// How many chunks to fire in parallel right when playback begins.
// The first chunk we'll await before starting audio; the rest stream in the background.
const PLAYBACK_BOOTSTRAP_CHUNKS: Record<string, number> = {
  google: 2,
  openai: 2,
  kokoro: 8,
}

// How many ready chunks we wait for before pressing play. Set to 1 everywhere
// so audio starts the instant the first slice is decoded.
const START_PLAYBACK_READY_CHUNKS: Record<string, number> = {
  kokoro: 1,
}

// Rolling window of chunks we keep in flight ahead of the cursor while playing.
const PREFETCH_AHEAD_TARGET: Record<string, number> = {
  kokoro: 6,
}
const DEFAULT_PREFETCH_AHEAD = 2

const liveAudioMemoryCache = new Map<string, { expiresAt: number; promise: Promise<LiveAudioResult> }>()

function liveAudioCacheKey(bookId: string, payload: LiveAudioPayload) {
  return JSON.stringify([
    bookId,
    payload.provider,
    payload.voice ?? '',
    payload.model ?? '',
    payload.output_format,
    payload.length_scale,
    payload.sentence_silence,
    payload.start,
    payload.end,
    payload.text,
  ])
}

function requestLiveAudio(bookId: string, payload: LiveAudioPayload) {
  const key = liveAudioCacheKey(bookId, payload)
  const now = Date.now()
  const cached = liveAudioMemoryCache.get(key)
  if (cached && cached.expiresAt > now) return cached.promise
  if (cached) liveAudioMemoryCache.delete(key)

  const promise = request<LiveAudioResult>(`/api/books/${bookId}/live-audio`, {
    method: 'POST',
    body: JSON.stringify(payload),
  }).catch((error) => {
    liveAudioMemoryCache.delete(key)
    throw error
  })

  liveAudioMemoryCache.set(key, { expiresAt: now + LIVE_AUDIO_MEMORY_TTL_MS, promise })
  return promise
}

function audioSliceStart(textLength: number, scrollPct: number) {
  if (textLength <= 0) return 0
  const rawStart = Math.round(scrollPct * textLength) - 200
  const maxStart = Math.max(0, textLength - AUDIO_SLICE_CHARS)
  return Math.max(0, Math.min(rawStart, maxStart))
}

// Provider-tuned pacing
function pacingFor(provider: string): { lengthScale: number; sentenceSilence: number } {
  if (provider === 'neutts_local') return { lengthScale: 1.1, sentenceSilence: 0.38 }
  return { lengthScale: 1.0, sentenceSilence: 0.20 }
}

function isChunking(provider: string): boolean {
  return provider in CHUNK_CHARS
}

const HIGHLIGHT_COLORS = [
  { id: 'amber' as const, hex: '#fbbf24', label: 'Yellow' },
  { id: 'rose'  as const, hex: '#fb7185', label: 'Pink'   },
  { id: 'sky'   as const, hex: '#38bdf8', label: 'Blue'   },
]

const APPEARANCE_KEY  = 'reader-appearance'
const PROGRESS_KEY    = 'storybook-reader-progress'
const AUDIO_PREFS_KEY = 'reader-audio-prefs'

interface AudioPrefs { provider: string; voice: string | null }

function loadAudioPrefs(): AudioPrefs {
  try {
    const raw = localStorage.getItem(AUDIO_PREFS_KEY)
    return raw ? { provider: 'google', voice: null, ...JSON.parse(raw) } : { provider: 'google', voice: null }
  } catch { return { provider: 'google', voice: null } }
}

function providerOptionsFromCatalog(providers?: TtsProviderInfo[]) {
  if (providers?.length) {
    return providers.map((provider) => ({
      id: provider.id,
      label: provider.name,
      available: provider.available,
      recommended: Boolean(provider.recommended),
      voices: provider.voices,
      defaultVoice: provider.defaultVoice ?? null,
    }))
  }

  return TTS_PROVIDERS.map((provider) => ({
    ...provider,
    available: true,
    recommended: false,
    voices: [] as TtsVoiceOption[],
    defaultVoice: null,
  }))
}

function defaultVoiceForProvider(provider: { voices: TtsVoiceOption[]; defaultVoice?: string | null } | undefined) {
  return provider?.defaultVoice ?? provider?.voices[0]?.id ?? null
}

function pickFallbackProvider(providers: TtsProviderInfo[]) {
  const available = providers.filter((provider) => provider.available)
  return (
    available.find((provider) => provider.recommended) ??
    available.find((provider) => provider.id === 'kokoro') ??
    available[0] ??
    null
  )
}

function audioErrorMessage(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error)
  const detail = raw.match(/"detail"\s*:\s*"([^"]+)"/)?.[1]
  const message = detail ?? raw

  if (/Authentication required|Unauthorized|Session expired/i.test(message)) {
    return 'Your session expired. Sign in again, then try audio playback.'
  }
  if (/not configured|configured yet/i.test(message)) {
    return message
  }
  if (/text does not match|range/i.test(message)) {
    return 'Could not match this passage to the book text. Move slightly and try again.'
  }
  if (/Failed to fetch|NetworkError|fetch/i.test(message)) {
    return 'Could not reach the audio service. Check the connection and try again.'
  }
  return 'Could not start audio. Check the selected voice provider and try again.'
}

function aiErrorMessage(error: unknown, fallback = 'Something went wrong.') {
  const raw = error instanceof Error ? error.message : String(error)
  const detail = raw.match(/"detail"\s*:\s*"([^"]+)"/)?.[1]
  const message = (detail ?? raw).trim()

  if (/Authentication required|Unauthorized|Session expired/i.test(message)) {
    return 'Your session expired. Sign in again, then try again.'
  }
  if (/AI service is not configured|not configured|configured yet/i.test(message)) {
    return 'AI is not available on this server right now.'
  }
  if (/Failed to fetch|NetworkError|fetch|timeout/i.test(message)) {
    return 'Could not reach the AI service. Check the connection and try again.'
  }
  return message || fallback
}

function needsAuthenticatedAudioFetch(url: string) {
  if (url.startsWith('/library/')) return true
  try {
    const parsed = new URL(url, window.location.href)
    const localApiHost = ['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(parsed.hostname)
    return parsed.pathname.startsWith('/library/') && (parsed.origin === window.location.origin || localApiHost)
  } catch {
    return false
  }
}

async function playableAudioUrl(url: string, signal?: AbortSignal) {
  if (!needsAuthenticatedAudioFetch(url)) return { url, revoke: () => {} }

  const blob = await requestBlob(url, { signal })
  const objectUrl = URL.createObjectURL(blob)
  return {
    url: objectUrl,
    revoke: () => URL.revokeObjectURL(objectUrl),
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadAppearance(): Appearance {
  try {
    const raw = localStorage.getItem(APPEARANCE_KEY)
    return raw ? { ...DEFAULT_APPEARANCE, ...JSON.parse(raw) } : DEFAULT_APPEARANCE
  } catch { return DEFAULT_APPEARANCE }
}

function findTextOffset(needle: string, haystack: string, approxPct: number): number {
  if (!haystack || !needle) return 0
  const approxPos  = Math.round(approxPct * haystack.length)
  const searchFrom = Math.max(0, approxPos - 8000)
  let idx = haystack.indexOf(needle, searchFrom)
  if (idx < 0) idx = haystack.indexOf(needle)
  return Math.max(0, idx)
}

function buildReaderParagraphs(text: string): ReaderParagraph[] {
  if (!text) return []

  const paragraphs: ReaderParagraph[] = []
  const separator = /\r?\n(?:[ \t]*\r?\n)+/g
  let startOffset = 0
  let match: RegExpExecArray | null

  while ((match = separator.exec(text)) !== null) {
    const paragraph = text.slice(startOffset, match.index)
    if (paragraph.length > 0) {
      paragraphs.push({ text: paragraph, startOffset })
    }
    startOffset = match.index + match[0].length
  }

  const paragraph = text.slice(startOffset)
  if (paragraph.length > 0) {
    paragraphs.push({ text: paragraph, startOffset })
  }

  return paragraphs
}

function toSelectionRect(rect: DOMRect): SelectionRect {
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
}

function selectionRectsFromRange(range: Range, fallbackRect: DOMRect): SelectionRect[] {
  const rects = Array.from(range.getClientRects())
    .filter(rect => rect.width > 0 && rect.height > 0)
    .map(toSelectionRect)

  return rects.length > 0 ? rects : [toSelectionRect(fallbackRect)]
}

function paragraphForNode(node: Node, root: HTMLElement): HTMLElement | null {
  const element = node.nodeType === Node.ELEMENT_NODE
    ? node as Element
    : node.parentElement
  const paragraph = element?.closest<HTMLElement>('[data-reader-paragraph-start]')
  return paragraph && root.contains(paragraph) ? paragraph : null
}

function offsetWithinParagraph(paragraph: HTMLElement, container: Node, offset: number): number | null {
  if (container !== paragraph && !paragraph.contains(container)) return null

  const range = document.createRange()
  try {
    range.selectNodeContents(paragraph)
    range.setEnd(container, offset)
    return range.toString().length
  } catch {
    return null
  }
}

function sourceOffsetForDomPoint(container: Node, offset: number, root: HTMLElement): number | null {
  const paragraph = paragraphForNode(container, root)
  if (!paragraph) return null

  const startAttr = paragraph.dataset.readerParagraphStart
  if (!startAttr) return null

  const paragraphStart = Number(startAttr)
  if (!Number.isFinite(paragraphStart)) return null

  const localOffset = offsetWithinParagraph(paragraph, container, offset)
  return localOffset === null ? null : paragraphStart + localOffset
}

function trimLocatedSelection(startOffset: number, endOffset: number, fullText: string): LocatedSelection | null {
  let start = Math.max(0, Math.min(startOffset, fullText.length))
  let end = Math.max(0, Math.min(endOffset, fullText.length))
  if (end < start) [start, end] = [end, start]

  while (start < end && /\s/.test(fullText[start])) start += 1
  while (end > start && /\s/.test(fullText[end - 1])) end -= 1

  const text = fullText.slice(start, end)
  return text ? { text, startOffset: start, endOffset: end } : null
}

function locateSelectionRange(range: Range, root: HTMLElement, fullText: string): LocatedSelection | null {
  const startOffset = sourceOffsetForDomPoint(range.startContainer, range.startOffset, root)
  const endOffset = sourceOffsetForDomPoint(range.endContainer, range.endOffset, root)
  if (startOffset === null || endOffset === null) return null

  return trimLocatedSelection(startOffset, endOffset, fullText)
}

function findDomPointAtOffset(
  root: Node,
  targetOffset: number,
): { node: Node; offset: number } | null {
  let accumulated = 0

  function walk(node: Node): { node: Node; offset: number } | null {
    if (node.nodeType === Node.TEXT_NODE) {
      const len = (node.textContent ?? '').length
      if (accumulated + len >= targetOffset) {
        return { node, offset: Math.max(0, targetOffset - accumulated) }
      }
      accumulated += len
      return null
    }
    for (const child of Array.from(node.childNodes)) {
      const result = walk(child)
      if (result) return result
    }
    return null
  }

  return walk(root)
}

function domRangeForSourceOffsets(
  startSrc: number,
  endSrc: number,
  root: HTMLElement,
): Range | null {
  const paragraphs = Array.from(
    root.querySelectorAll<HTMLElement>('[data-reader-paragraph-start]'),
  )
  let startPoint: { node: Node; offset: number } | null = null
  let endPoint: { node: Node; offset: number } | null = null

  for (const para of paragraphs) {
    const paraStart = Number(para.dataset.readerParagraphStart)
    const paraText = para.textContent ?? ''
    const paraEnd = paraStart + paraText.length

    if (!startPoint && startSrc >= paraStart && startSrc <= paraEnd) {
      startPoint = findDomPointAtOffset(para, startSrc - paraStart)
    }
    if (!endPoint && endSrc >= paraStart && endSrc <= paraEnd) {
      endPoint = findDomPointAtOffset(para, endSrc - paraStart)
    }
    if (startPoint && endPoint) break
  }

  if (!startPoint || !endPoint) return null

  try {
    const range = document.createRange()
    range.setStart(startPoint.node, startPoint.offset)
    range.setEnd(endPoint.node, endPoint.offset)
    return range
  } catch {
    return null
  }
}

function caretRangeAt(x: number, y: number): Range | null {
  if (typeof document.caretRangeFromPoint === 'function') {
    return document.caretRangeFromPoint(x, y)
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pos = (document as any).caretPositionFromPoint?.(x, y)
  if (pos) {
    const r = document.createRange()
    r.setStart(pos.offsetNode, pos.offset)
    r.collapse(true)
    return r
  }
  return null
}

const PUNCT = /[.,!?;:"'()[\]{}<>»«\u2019\u2018\u201C\u201D\u2026\-–—]/

interface VocabularyDeckRef {
  id: string
}

interface VocabularyDeckCreateResponse extends Partial<VocabularyDeckRef> {
  deck?: Partial<VocabularyDeckRef>
}

function deckIdFromCreateResponse(payload: VocabularyDeckCreateResponse): string | null {
  return payload.id ?? payload.deck?.id ?? null
}

function getWordAtPoint(clientX: number, clientY: number): { text: string; rect: DOMRect; range: Range } | null {
  const cr = caretRangeAt(clientX, clientY)
  if (!cr) return null
  const node = cr.startContainer
  if (node.nodeType !== Node.TEXT_NODE) return null
  const full   = node.textContent ?? ''
  const offset = cr.startOffset

  let s = offset, e = offset
  while (s > 0 && !/[\s\u00A0]/.test(full[s - 1])) s--
  while (e < full.length && !/[\s\u00A0]/.test(full[e])) e++
  if (s >= e) return null

  // Strip surrounding punctuation
  while (s < e && PUNCT.test(full[s])) s++
  while (e > s && PUNCT.test(full[e - 1])) e--
  if (s >= e) return null

  const text = full.slice(s, e).trim()
  if (!text || text.length < 2) return null

  const range = document.createRange()
  range.setStart(node, s)
  range.setEnd(node, e)

  return { text, rect: range.getBoundingClientRect(), range }
}

async function firstVocabularyDeckId(): Promise<string | null> {
  const res = await api.get<{ items: VocabularyDeckRef[] }>('/api/vocabulary/decks')
  return res.items[0]?.id ?? null
}

async function getOrCreateDeck(): Promise<string | null> {
  const existingDeckId = await firstVocabularyDeckId()
  if (existingDeckId) return existingDeckId

  try {
    const created = await api.post<VocabularyDeckCreateResponse>('/api/vocabulary/decks', {
      title: 'My Vocabulary', description: 'Words saved while reading',
    })
    const createdDeckId = deckIdFromCreateResponse(created)
    if (createdDeckId) return createdDeckId
  } catch {
    const recoveredDeckId = await firstVocabularyDeckId().catch(() => null)
    if (recoveredDeckId) return recoveredDeckId
    throw new Error('Could not create a vocabulary deck.')
  }

  return firstVocabularyDeckId().catch(() => null)
}

// ── BottomSheet ───────────────────────────────────────────────────────────────

function BottomSheet({ open, onClose, children, bg = '#ffffff' }: {
  open: boolean; onClose: () => void; children: React.ReactNode; bg?: string
}) {
  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 flex items-end justify-center">
          <motion.div
            className="absolute inset-0 bg-black/30"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
          />
          <motion.div
            className="relative w-full max-w-md rounded-t-2xl shadow-2xl overflow-hidden"
            style={{ backgroundColor: bg }}
            initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
            transition={{ type: 'spring', damping: 32, stiffness: 340 }}
          >
            <div className="flex justify-center pt-3 pb-1">
              <div className="w-8 h-1 rounded-full bg-current opacity-20" />
            </div>
            {children}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  )
}

// ── Selection Menu ────────────────────────────────────────────────────────────

const WORD_ACTIONS = [
  { id: 'copy',       Icon: Copy,       label: 'Copy'   },
  { id: 'play',       Icon: Mic,        label: 'Play'   },
  { id: 'vocabulary', Icon: BookMarked, label: 'Vocab'  },
  { id: 'dictionary', Icon: BookOpen,   label: 'Define' },
  { id: 'google',     Icon: Globe,      label: 'Google' },
] as const

const SENTENCE_ACTIONS = [
  { id: 'copy',      Icon: Copy,        label: 'Copy'      },
  { id: 'notes',     Icon: NotebookPen, label: 'Notes'     },
  { id: 'askai',     Icon: Sparkles,    label: 'Ask AI'    },
  { id: 'translate', Icon: Languages,   label: 'Translate' },
] as const

interface SelectionMenuProps {
  sel: SelectionState
  bookId: string
  fullText: string
  ttsProvider?: string
  onClose: () => void
  onOpenPanel: (p: SecondaryPanel) => void
  onToast: (msg: string) => void
  onPlayWord: (text: string, startOffset: number) => void
}

function SelectionMenu({
  sel, bookId, fullText,
  onClose, onOpenPanel, onToast, onPlayWord,
}: SelectionMenuProps) {
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [busyColor,  setBusyColor]  = useState<string | null>(null)
  const queryClient = useQueryClient()

  useEffect(() => {
    const normalized = normalizeLookupWord(sel.text)
    if (sel.mode !== 'word' || !normalized || normalized.includes(' ')) return
    void queryClient.prefetchQuery({
      queryKey: dictionaryQueryKey(normalized),
      queryFn: () => fetchOfflineDictionary(normalized),
      staleTime: DICTIONARY_STALE_TIME_MS,
    })
  }, [queryClient, sel.mode, sel.text])

  const menuW = sel.mode === 'word' ? 300 : 268
  const cx = Math.min(
    Math.max(sel.viewportX, menuW / 2 + 10),
    window.innerWidth - menuW / 2 - 10,
  )

  // Compute left edge directly — avoids translateX(-50%) conflicting with framer-motion transforms
  const menuLeft = Math.min(
    Math.max(cx - menuW / 2, 8),
    window.innerWidth - menuW - 8,
  )

  // Place above the word; fall back to below when word is near top of viewport
  const spaceAbove = sel.viewportY
  const placeAbove = spaceAbove > 130
  const menuBottom = placeAbove
    ? window.innerHeight - sel.viewportY + 8          // menu bottom = 8px above word top
    : undefined
  const menuTop = !placeAbove
    ? sel.viewportY + sel.selHeight + 8               // menu top = 8px below word bottom
    : undefined

  async function handleWord(id: string) {
    switch (id) {
      case 'copy':
        navigator.clipboard.writeText(sel.text).catch(() => {})
        onToast('Copied')
        onClose()
        break
      case 'play':
        onClose()
        onPlayWord(sel.text, sel.startOffset)
        break
      case 'vocabulary': {
        if (sel.text.trim().split(/\s+/).length > 1) {
          onToast('Select a single word to save')
          onClose()
          break
        }
        setBusyAction('vocabulary')
        try {
          const deckId = await getOrCreateDeck()
          if (!deckId) { onToast('No vocabulary deck'); break }
          const contextStart = Math.max(0, sel.startOffset - 140)
          const contextEnd = Math.min(fullText.length, sel.endOffset + 140)
          await api.post(`/api/vocabulary/decks/${deckId}/notes`, {
            noteType: 'basic',
            front: sel.text,
            back: null,
            topic: 'Reading',
            tags: ['reader'],
            sourceRef: `reader-vocab:${sel.text.trim().toLocaleLowerCase()}`,
            metadata: {
              source: 'reader-selection',
              bookId,
              start: sel.startOffset,
              end: sel.endOffset,
              context: fullText.slice(contextStart, contextEnd),
            },
          })
          queryClient.invalidateQueries({ queryKey: ['decks'] })
          queryClient.invalidateQueries({ queryKey: ['deck-dashboard'] })
          onToast('Saved to Vocabulary ✓')
        } catch { onToast('Could not save') }
        setBusyAction(null)
        onClose()
        break
      }
      case 'dictionary':
        void queryClient.prefetchQuery({
          queryKey: dictionaryQueryKey(sel.text),
          queryFn: () => fetchOfflineDictionary(sel.text),
          staleTime: DICTIONARY_STALE_TIME_MS,
        })
        onOpenPanel({ kind: 'dictionary', word: sel.text })
        onClose()
        break
      case 'google':
        window.open(
          `https://www.google.com/search?q=${encodeURIComponent(sel.text)}`,
          '_blank',
          'width=560,height=700,left=200,top=80,resizable=yes,scrollbars=yes',
        )
        onClose()
        break
    }
  }

  function handleSentence(id: string) {
    switch (id) {
      case 'copy':
        navigator.clipboard.writeText(sel.text).catch(() => {})
        onToast('Copied')
        onClose()
        break
      case 'notes':
        onOpenPanel({ kind: 'notes', text: sel.text, start: sel.startOffset, end: sel.endOffset })
        onClose()
        break
      case 'askai':
        onOpenPanel({ kind: 'askai', text: sel.text })
        onClose()
        break
      case 'translate':
        onOpenPanel({ kind: 'translate', text: sel.text })
        onClose()
        break
    }
  }

  async function handleColor(colorId: 'amber' | 'rose' | 'sky') {
    setBusyColor(colorId)
    try {
      await api.post(`/api/books/${bookId}/highlights`, {
        start: sel.startOffset, end: sel.endOffset,
        color: colorId, kind: 'highlight', text: sel.text, note: null,
      })
      queryClient.invalidateQueries({ queryKey: ['highlights', bookId] })
      queryClient.invalidateQueries({ queryKey: ['reader', bookId] })
      queryClient.invalidateQueries({ queryKey: ['books'] })
      onToast('Highlighted ✓')
    } catch { onToast('Could not highlight') }
    setBusyColor(null)
    onClose()
  }

  const actions = sel.mode === 'word' ? WORD_ACTIONS : SENTENCE_ACTIONS

  return (
    <motion.div
      className="fixed z-[60] rounded-2xl overflow-hidden"
      style={{
        left: menuLeft,
        bottom: menuBottom,
        top: menuTop,
        background: 'rgba(26,26,28,0.97)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        border: '1px solid rgba(255,255,255,0.10)',
        boxShadow: '0 8px 32px rgba(0,0,0,0.45)',
        width: menuW,
      }}
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9 }}
      transition={{ type: 'spring', damping: 26, stiffness: 400 }}
      onMouseDown={(e) => e.preventDefault()}
      onPointerDown={(e) => e.preventDefault()}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Action row */}
      <div className="flex items-stretch divide-x divide-white/10">
        {actions.map(({ id, Icon, label }) => (
          <button
            key={id}
            onClick={() => sel.mode === 'word' ? handleWord(id) : handleSentence(id)}
            disabled={busyAction === id}
            className="flex-1 flex flex-col items-center gap-1.5 py-3 px-1 text-white hover:bg-white/10 active:bg-white/15 transition-colors disabled:opacity-40"
          >
            {busyAction === id
              ? <div className="w-4 h-4 border-2 border-white/50 border-t-transparent rounded-full animate-spin" />
              : <Icon size={17} strokeWidth={1.75} />
            }
            <span className="text-[10px] font-medium opacity-70 leading-none">{label}</span>
          </button>
        ))}
      </div>

      {/* Divider */}
      <div className="h-px bg-white/10" />

      {/* Highlight colors */}
      <div className="flex items-center gap-5 px-4 py-2.5">
        <span className="text-[10px] text-white/35 font-medium tracking-wide">Highlight</span>
        <div className="flex items-center gap-3 ml-1">
          {HIGHLIGHT_COLORS.map(({ id, hex, label }) => (
            <button
              key={id}
              onClick={() => handleColor(id)}
              disabled={busyColor !== null}
              aria-label={label}
              className="w-6 h-6 rounded-full transition-transform hover:scale-110 active:scale-90 disabled:opacity-50 flex items-center justify-center"
              style={{ backgroundColor: hex, boxShadow: `0 0 0 2px rgba(255,255,255,0.15)` }}
            >
              {busyColor === id && (
                <div className="w-3 h-3 border border-white/80 border-t-transparent rounded-full animate-spin" />
              )}
            </button>
          ))}
        </div>
      </div>
    </motion.div>
  )
}

// ── Dictionary types ──────────────────────────────────────────────────────────

interface DictEntry {
  partOfSpeech?: string
  definitions?: Array<{ definition: string; examples?: string[]; synonyms?: string[] }>
}
interface DictResponse {
  term: string; available: boolean; message?: string | null
  pronunciation?: string | null
  entries?: DictEntry[]
  relatedTerms?: string[]
}

// Free Dictionary API (freedictionary.dev) — used as fallback when offline dict has no definitions
interface FreeDef { definition: string; example?: string; synonyms?: string[] }
interface FreeMeaning { partOfSpeech: string; definitions: FreeDef[]; synonyms: string[] }
interface FreeEntry  { word: string; phonetic?: string; meanings: FreeMeaning[] }

// Unified display shape consumed by the render tree
interface DisplayEntry {
  partOfSpeech: string
  definitions: Array<{ definition: string; examples: string[]; synonyms: string[] }>
}
interface DisplayData {
  term: string; pronunciation: string | null
  entries: DisplayEntry[]; relatedTerms: string[]
  source: 'offline' | 'online'
}

const DICTIONARY_STALE_TIME_MS = 5 * 60_000

function normalizeLookupWord(value: string) {
  return value.trim().toLowerCase()
}

function dictionaryQueryKey(word: string) {
  return ['dictionary', normalizeLookupWord(word)] as const
}

function fetchOfflineDictionary(word: string) {
  return api.get<DictResponse>(`/api/dictionary/lookup?term=${encodeURIComponent(normalizeLookupWord(word))}`)
}

// ── Dictionary Panel ──────────────────────────────────────────────────────────

function DictionaryPanel({ word: initialWord, onClose, colors }: {
  word: string; onClose: () => void; colors: typeof THEMES['paper']
}) {
  const [lookupWord, setLookupWord] = useState(() => normalizeLookupWord(initialWord) || initialWord)
  const [inputValue, setInputValue] = useState(initialWord)
  const [speaking,   setSpeaking]   = useState(false)
  const [vocabState, setVocabState] = useState<'idle' | 'busy' | 'saved'>('idle')
  const queryClient = useQueryClient()

  // 1. Offline dictionary (backend)
  const { data: offlineData, isLoading: offlineLoading } = useQuery({
    queryKey: dictionaryQueryKey(lookupWord),
    queryFn: () => fetchOfflineDictionary(lookupWord),
    staleTime: DICTIONARY_STALE_TIME_MS,
  })

  const hasOfflineDefs = !offlineLoading && (offlineData?.entries ?? [])
    .some(e => (e.definitions?.length ?? 0) > 0)

  // 2. Free Dictionary API fallback — fires only when offline dict has no definitions
  const { data: freeRaw, isLoading: freeLoading } = useQuery({
    queryKey: ['free-dict', lookupWord],
    queryFn: async (): Promise<FreeEntry[] | null> => {
      try {
        const r = await fetch(
          `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(lookupWord)}`,
          { signal: AbortSignal.timeout(6000) },
        )
        if (!r.ok) return null
        const j = await r.json()
        return Array.isArray(j) ? j as FreeEntry[] : null
      } catch { return null }
    },
    enabled: !offlineLoading && !hasOfflineDefs,
    staleTime: 10 * 60_000,
    retry: false,
  })

  const isLoading = offlineLoading || (!hasOfflineDefs && freeLoading)

  // Merge into unified DisplayData
  const displayData = useMemo((): DisplayData | null => {
    if (hasOfflineDefs && offlineData) {
      return {
        term: offlineData.term ?? lookupWord,
        pronunciation: offlineData.pronunciation ?? null,
        entries: (offlineData.entries ?? []).map(e => ({
          partOfSpeech: e.partOfSpeech ?? '',
          definitions: (e.definitions ?? []).map(d => ({
            definition: d.definition,
            examples:   d.examples ?? [],
            synonyms:   d.synonyms ?? [],
          })),
        })),
        relatedTerms: offlineData.relatedTerms ?? [],
        source: 'offline',
      }
    }
    if (freeRaw && freeRaw.length > 0) {
      const fe = freeRaw[0]
      return {
        term: fe.word,
        pronunciation: fe.phonetic ?? null,
        entries: fe.meanings.slice(0, 4).map(m => ({
          partOfSpeech: m.partOfSpeech,
          definitions: m.definitions.slice(0, 4).map(d => ({
            definition: d.definition,
            examples:   d.example ? [d.example] : [],
            synonyms:   [...(d.synonyms ?? []), ...(m.synonyms ?? [])].slice(0, 6),
          })),
        })),
        relatedTerms: offlineData?.relatedTerms ?? [],
        source: 'online',
      }
    }
    // Offline data available but genuinely empty (adverbs, etc.) — show partial
    if (offlineData && !freeLoading) {
      return {
        term: offlineData.term ?? lookupWord,
        pronunciation: offlineData.pronunciation ?? null,
        entries: [],
        relatedTerms: offlineData.relatedTerms ?? [],
        source: 'offline',
      }
    }
    return null
  }, [hasOfflineDefs, offlineData, freeRaw, freeLoading, lookupWord])

  function speak() {
    if (!window.speechSynthesis) return
    window.speechSynthesis.cancel()
    const utt = new SpeechSynthesisUtterance(displayData?.term ?? lookupWord)
    utt.rate = 0.88
    utt.onstart = () => setSpeaking(true)
    utt.onend   = () => setSpeaking(false)
    utt.onerror = () => setSpeaking(false)
    window.speechSynthesis.speak(utt)
  }

  function navigate(w: string) {
    const t = w.trim().toLowerCase()
    if (!t) return
    setLookupWord(t)
    setInputValue(t)
    setVocabState('idle')
  }

  async function saveToVocab() {
    if (vocabState !== 'idle') return
    setVocabState('busy')
    try {
      const deckId = await getOrCreateDeck()
      if (!deckId) { setVocabState('idle'); return }
      const firstDef = displayData?.entries?.[0]?.definitions?.[0]?.definition ?? null
      await api.post(`/api/vocabulary/decks/${deckId}/notes`, {
        noteType: 'basic',
        front: displayData?.term ?? lookupWord,
        back: firstDef,
        topic: 'Reading',
        tags: ['reader'],
        sourceRef: `reader-vocab:${(displayData?.term ?? lookupWord).trim().toLowerCase()}`,
        metadata: { source: 'dictionary' },
      })
      queryClient.invalidateQueries({ queryKey: ['decks'] })
      queryClient.invalidateQueries({ queryKey: ['deck-dashboard'] })
      setVocabState('saved')
    } catch {
      setVocabState('idle')
    }
  }

  return (
    <div style={{ color: colors.text, paddingBottom: 'max(env(safe-area-inset-bottom,0px),28px)' }}>

      {/* ── Search bar ──────────────────────────────────────── */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b" style={{ borderColor: `${colors.text}12` }}>
        <Search size={15} className="opacity-35 shrink-0" />
        <input
          value={inputValue}
          onChange={e => setInputValue(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') navigate(inputValue) }}
          placeholder="Look up a word…"
          className="flex-1 text-sm bg-transparent outline-none min-w-0"
          style={{ color: colors.text }}
          autoComplete="off" autoCorrect="off" spellCheck={false}
        />
        {inputValue.trim() && inputValue.trim() !== lookupWord && (
          <button onClick={() => navigate(inputValue)}
            className="text-xs font-medium px-2 py-0.5 rounded-md"
            style={{ color: '#4285f4', backgroundColor: '#4285f418' }}>
            Go
          </button>
        )}
        <button onClick={onClose} className="p-0.5 ml-1 opacity-35 hover:opacity-70 transition-opacity shrink-0">
          <X size={15} />
        </button>
      </div>

      {/* ── Content ─────────────────────────────────────────── */}
      <div className="overflow-y-auto" style={{ maxHeight: '65vh' }}>

        {/* Loading skeleton */}
        {isLoading && (
          <div className="px-5 pt-5 pb-4 animate-pulse">
            <div className="flex items-start gap-4 mb-5">
              <div className="w-12 h-12 rounded-full shrink-0" style={{ backgroundColor: '#4285f412' }} />
              <div className="flex-1 pt-0.5 min-w-0">
                <h2
                  className="text-[28px] font-normal leading-tight break-words"
                  style={{ fontFamily: 'Lora, Georgia, serif', color: colors.text }}
                >
                  {lookupWord}
                </h2>
                <div className="mt-2 h-3 w-24 rounded" style={{ backgroundColor: `${colors.text}08` }} />
              </div>
            </div>
            <div className="h-3 w-16 rounded mb-4" style={{ backgroundColor: `${colors.text}08` }} />
            <div className="space-y-2">
              {[100, 88, 75, 92, 60].map((w, i) => (
                <div key={i} className="h-3.5 rounded" style={{ backgroundColor: `${colors.text}10`, width: `${w}%` }} />
              ))}
            </div>
          </div>
        )}

        {/* Result */}
        {!isLoading && displayData && (
          <div className="px-5 pt-5 pb-4">

            {/* ── Word + speaker ───────────────────────────── */}
            <div className="flex items-start gap-4 mb-5">
              <button
                onClick={speak}
                aria-label="Pronounce"
                className="w-12 h-12 rounded-full flex items-center justify-center shrink-0 transition-all active:scale-90"
                style={{ backgroundColor: speaking ? '#4285f4' : '#4285f420' }}
              >
                <Volume2 size={20} strokeWidth={1.8} style={{ color: speaking ? '#fff' : '#4285f4' }} />
              </button>
              <div className="flex-1 pt-0.5 min-w-0">
                <div className="flex items-start justify-between gap-2">
                  <h2 className="text-[28px] font-normal leading-tight break-words"
                    style={{ fontFamily: 'Lora, Georgia, serif', color: colors.text }}>
                    {displayData.term}
                  </h2>
                  <button
                    onClick={() => void saveToVocab()}
                    aria-label="Save to vocabulary"
                    disabled={vocabState === 'busy'}
                    className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 transition-all active:scale-90 mt-0.5"
                    style={{
                      backgroundColor: vocabState === 'saved' ? '#22c55e20' : `${colors.text}10`,
                      color: vocabState === 'saved' ? '#22c55e' : `${colors.text}55`,
                    }}
                  >
                    {vocabState === 'busy' ? (
                      <div className="w-3.5 h-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" />
                    ) : vocabState === 'saved' ? (
                      <span className="text-sm font-medium">✓</span>
                    ) : (
                      <Type size={14} />
                    )}
                  </button>
                </div>
                {displayData.pronunciation && (
                  <p className="text-sm mt-1" style={{ color: `${colors.text}50` }}>
                    {displayData.pronunciation}
                  </p>
                )}
              </div>
            </div>

            {/* ── Entries ──────────────────────────────────── */}
            {displayData.entries.map((entry, ei) => (
              <div key={ei}
                className={ei > 0 ? 'mt-6 pt-5 border-t' : ''}
                style={{ borderColor: `${colors.text}12` }}
              >
                {/* Part of speech */}
                {entry.partOfSpeech && (
                  <p className="text-sm italic mb-4" style={{ color: `${colors.text}58` }}>
                    {entry.partOfSpeech}
                  </p>
                )}

                {/* Definitions list */}
                <div className="space-y-5">
                  {entry.definitions.map((def, di) => (
                    <div key={di} className="flex gap-3">
                      <span className="text-xl shrink-0 leading-none" style={{ color: `${colors.text}22`, marginTop: 1 }}>·</span>
                      <div className="flex-1 min-w-0">

                        {/* Definition text */}
                        <p className="text-[15px] leading-relaxed" style={{ color: colors.text }}>
                          {def.definition}
                        </p>

                        {/* Up to 2 example sentences */}
                        {def.examples.slice(0, 2).map((ex, xi) => (
                          <p key={xi} className="text-sm mt-2 italic leading-relaxed"
                            style={{ color: `${colors.text}50` }}>
                            "{ex}"
                          </p>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Similar words — one row per part-of-speech, not per definition */}
                {(() => {
                  const unique = [...new Set(entry.definitions.flatMap(d => d.synonyms))].slice(0, 7)
                  return unique.length > 0 ? (
                    <div className="flex flex-wrap items-center gap-1.5 mt-4">
                      <span className="text-[12px] shrink-0" style={{ color: `${colors.text}45` }}>
                        Similar:
                      </span>
                      {unique.map(s => (
                        <button key={s} onClick={() => navigate(s)}
                          className="px-2.5 py-[3px] rounded-full text-xs border transition-all hover:opacity-70 active:scale-95"
                          style={{ borderColor: `${colors.text}20`, color: `${colors.text}70` }}>
                          {s}
                        </button>
                      ))}
                    </div>
                  ) : null
                })()}
              </div>
            ))}

            {/* No definitions at all */}
            {displayData.entries.length === 0 && (
              <p className="text-sm" style={{ color: `${colors.text}50` }}>
                No definition found for this word.
              </p>
            )}

            {/* ── Related terms ────────────────────────────── */}
            {displayData.relatedTerms.length > 0 && (
              <div className="mt-6 pt-4 border-t" style={{ borderColor: `${colors.text}12` }}>
                <p className="text-[11px] font-semibold uppercase tracking-widest mb-3"
                  style={{ color: `${colors.text}38` }}>
                  Related
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {displayData.relatedTerms.slice(0, 10).map(t => (
                    <button key={t} onClick={() => navigate(t)}
                      className="px-3 py-1 rounded-full text-xs border transition-all hover:opacity-70 active:scale-95"
                      style={{ borderColor: `${colors.text}18`, color: `${colors.text}62` }}>
                      {t}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Source attribution */}
            {displayData.source === 'online' && (
              <p className="text-[10px] mt-5 text-center" style={{ color: `${colors.text}28` }}>
                Definitions from Free Dictionary
              </p>
            )}
          </div>
        )}

        {/* Truly nothing */}
        {!isLoading && !displayData && (
          <p className="px-5 pt-5 text-sm" style={{ color: `${colors.text}50` }}>
            No definition found for "{lookupWord}".
          </p>
        )}
      </div>
    </div>
  )
}

// ── Notes Panel ───────────────────────────────────────────────────────────────

function NotesPanel({ text, start, end, bookId, onClose, colors }: {
  text: string; start: number; end: number
  bookId: string; onClose: () => void; colors: typeof THEMES['paper']
}) {
  const [note,  setNote]  = useState('')
  const [color, setColor] = useState<'amber' | 'rose' | 'sky'>('amber')
  const [saving, setSaving] = useState(false)
  const [saved,  setSaved]  = useState(false)
  const queryClient = useQueryClient()

  async function save() {
    setSaving(true)
    try {
      await api.post(`/api/books/${bookId}/highlights`, {
        start, end, color, kind: 'note',
        text: text.slice(0, 800),
        note: note.trim() || null,
      })
      queryClient.invalidateQueries({ queryKey: ['highlights', bookId] })
      queryClient.invalidateQueries({ queryKey: ['reader', bookId] })
      queryClient.invalidateQueries({ queryKey: ['books'] })
      setSaved(true)
      setTimeout(onClose, 700)
    } catch { setSaving(false) }
  }

  return (
    <div style={{ color: colors.text, paddingBottom: 'max(env(safe-area-inset-bottom,0px),24px)' }}>
      <div className="flex items-center justify-between px-4 pt-1 pb-3">
        <span className="text-sm font-semibold uppercase tracking-wide opacity-55">Save Note</span>
        <button onClick={onClose} className="p-1 opacity-40 hover:opacity-80 transition-opacity">
          <X size={16} />
        </button>
      </div>

      <div className="px-4 space-y-4">
        {/* Selected text preview */}
        <div className="px-3.5 py-2.5 rounded-xl" style={{ backgroundColor: `${colors.text}07` }}>
          <p className="text-sm leading-relaxed line-clamp-3 opacity-75" style={{ fontFamily: 'Lora, Georgia, serif' }}>
            "{text}"
          </p>
        </div>

        {/* Color picker */}
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-widest opacity-40 mb-2.5">Highlight Color</p>
          <div className="flex gap-2">
            {HIGHLIGHT_COLORS.map(({ id, hex, label }) => (
              <button
                key={id}
                onClick={() => setColor(id)}
                className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl border text-xs font-medium transition-all"
                style={{
                  borderColor: color === id ? hex : `${colors.text}18`,
                  backgroundColor: color === id ? `${hex}22` : 'transparent',
                  color: color === id ? hex : `${colors.text}60`,
                }}
              >
                <div className="w-3 h-3 rounded-full" style={{ backgroundColor: hex }} />
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Annotation textarea */}
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-widest opacity-40 mb-2">Your Note <span className="normal-case font-normal">(optional)</span></p>
          <textarea
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="Add a thought, question, or annotation…"
            rows={3}
            className="w-full resize-none rounded-xl px-3.5 py-2.5 text-sm outline-none transition-colors"
            style={{
              backgroundColor: `${colors.text}07`,
              color: colors.text,
              border: `1.5px solid ${colors.text}12`,
            }}
          />
        </div>

        {/* Save */}
        <button
          onClick={save}
          disabled={saving || saved}
          className="w-full py-2.5 rounded-xl text-sm font-semibold text-white transition-all active:scale-[0.98] disabled:opacity-60 mb-2"
          style={{ backgroundColor: '#2383e2' }}
        >
          {saved ? '✓ Saved' : saving ? 'Saving…' : 'Save Highlight & Note'}
        </button>
      </div>
    </div>
  )
}

// ── Ask AI Panel ──────────────────────────────────────────────────────────────

interface AIChatMessage { role: 'user' | 'assistant'; content: string }

// Streams a server-sent-events endpoint that emits {"delta": "..."} chunks.
// Refreshes the auth session once on 401 so a stale token doesn't kill the request.
async function streamSSE(
  url: string,
  body: unknown,
  onDelta: (d: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const { supabase } = await import('@/lib/supabase')
  const base = (import.meta.env.VITE_API_ORIGIN as string | undefined) ?? ''
  const target = url.startsWith('http') ? url : `${base}${url}`

  async function getToken(forceRefresh: boolean): Promise<string> {
    if (forceRefresh) {
      const { data } = await supabase.auth.refreshSession()
      return data.session?.access_token ?? ''
    }
    const { data } = await supabase.auth.getSession()
    return data.session?.access_token ?? ''
  }

  async function fire(token: string) {
    return fetch(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal,
    })
  }

  let token = await getToken(false)
  let res = await fire(token)
  if (res.status === 401) {
    token = await getToken(true)
    res = await fire(token)
  }

  if (!res.ok) {
    const raw = await res.text()
    if (raw) {
      let detail = ''
      try {
        detail = (JSON.parse(raw) as { detail?: string }).detail ?? ''
      } catch {
        // Ignore non-JSON error bodies and fall back to the raw text.
      }
      throw new Error(detail || raw.trim() || `Request failed (${res.status})`)
    }
    throw new Error(`Request failed (${res.status})`)
  }

  const reader  = res.body!.getReader()
  const decoder = new TextDecoder()
  let   buf     = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const raw = line.slice(6)
      if (raw === '[DONE]') return
      try {
        const chunk = JSON.parse(raw) as { delta?: string; error?: string }
        if (chunk.error) throw new Error(chunk.error)
        if (chunk.delta) onDelta(chunk.delta)
      } catch {
        // Ignore malformed lines — keep streaming
      }
    }
  }
}

function streamAskAI(
  text: string,
  messages: AIChatMessage[],
  onDelta: (d: string) => void,
  signal: AbortSignal,
): Promise<void> {
  return streamSSE('/api/ai/ask', { text, messages }, onDelta, signal)
}

function streamAssistantChat(
  bookTitle: string,
  pageContext: string,
  messages: AIChatMessage[],
  onDelta: (d: string) => void,
  signal: AbortSignal,
): Promise<void> {
  return streamSSE(
    '/api/ai/chat',
    { book_title: bookTitle, page_context: pageContext, messages },
    onDelta,
    signal,
  )
}

function streamTranslation(
  text: string,
  targetLanguage: string,
  onDelta: (d: string) => void,
  signal: AbortSignal,
): Promise<void> {
  return streamSSE(
    '/api/ai/ask',
    { text, mode: 'translate', target_language: targetLanguage },
    onDelta,
    signal,
  )
}

function AskAIPanel({ text, onClose, colors }: {
  text: string; onClose: () => void; colors: typeof THEMES['paper']
}) {
  const [messages,  setMessages]  = useState<AIChatMessage[]>([])
  const [streaming, setStreaming] = useState(true)   // true while AI is typing
  const [input,     setInput]     = useState('')
  const [errMsg,    setErrMsg]    = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef  = useRef<HTMLInputElement>(null)

  // scroll to bottom whenever messages change or AI is streaming
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // kick off the first explanation automatically
  useEffect(() => {
    const ac = new AbortController()
    let assistantContent = ''
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMessages([{ role: 'assistant', content: '' }])
    setStreaming(true)

    streamAskAI(text, [], (delta) => {
      assistantContent += delta
      setMessages([{ role: 'assistant', content: assistantContent }])
    }, ac.signal)
      .catch((e: unknown) => {
        if ((e as { name?: string }).name !== 'AbortError') {
          setMessages([])
          setErrMsg(aiErrorMessage(e, 'AI is not available right now.'))
        }
      })
      .finally(() => setStreaming(false))

    return () => ac.abort()
  }, [text])

  async function sendMessage() {
    const q = input.trim()
    if (!q || streaming) return
    setInput('')

    // append user message + empty assistant placeholder
    const history = [...messages, { role: 'user' as const, content: q }]
    setMessages([...history, { role: 'assistant', content: '' }])
    setStreaming(true)
    setErrMsg('')

    const ac = new AbortController()
    let assistantContent = ''

    streamAskAI(text, history, (delta) => {
      assistantContent += delta
      setMessages([...history, { role: 'assistant', content: assistantContent }])
    }, ac.signal)
      .catch((e: unknown) => {
        if ((e as { name?: string }).name !== 'AbortError') {
          setMessages(history)
          setErrMsg(aiErrorMessage(e))
        }
      })
      .finally(() => {
        setStreaming(false)
        setTimeout(() => inputRef.current?.focus(), 50)
      })
  }

  return (
    <div
      className="flex flex-col"
      style={{ color: colors.text, height: '72vh', paddingBottom: 'env(safe-area-inset-bottom,0px)' }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-1 pb-3 shrink-0">
        <div className="flex items-center gap-2 opacity-55">
          <Sparkles size={13} />
          <span className="text-sm font-semibold uppercase tracking-wide">Ask AI</span>
        </div>
        <button onClick={onClose} className="p-1 opacity-40 hover:opacity-80 transition-opacity">
          <X size={16} />
        </button>
      </div>

      {/* Highlighted passage */}
      <div className="px-4 shrink-0">
        <div className="px-3.5 py-2.5 rounded-xl mb-3" style={{ backgroundColor: `${colors.text}07` }}>
          <p
            className="text-[13px] leading-relaxed line-clamp-2 opacity-60"
            style={{ fontFamily: 'Lora, Georgia, serif' }}
          >
            "{text}"
          </p>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 space-y-4 pb-3">
        {messages.map((m, i) => {
          const isLast = i === messages.length - 1
          return (
            <div key={i} className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
              {m.role === 'user' ? (
                <div
                  className="max-w-[80%] px-3.5 py-2 rounded-2xl rounded-tr-sm text-sm leading-relaxed"
                  style={{ backgroundColor: `${colors.text}12` }}
                >
                  {m.content}
                </div>
              ) : (
                <div className="max-w-[92%] text-sm leading-relaxed opacity-85 whitespace-pre-wrap">
                  {m.content || (streaming && isLast && (
                    <div className="flex items-center gap-2 py-1">
                      <div className="w-4 h-4 rounded-full border-2 border-current border-t-transparent animate-spin opacity-35" />
                      <span className="opacity-40">Thinking…</span>
                    </div>
                  ))}
                  {m.content && streaming && isLast && (
                    <span
                      className="inline-block w-[2px] h-[0.85em] ml-0.5 align-middle animate-pulse"
                      style={{ backgroundColor: colors.text, opacity: 0.45 }}
                    />
                  )}
                </div>
              )}
            </div>
          )
        })}
        {errMsg && <p className="text-xs opacity-50">{errMsg}</p>}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="px-4 pb-3 pt-2 shrink-0 border-t" style={{ borderColor: `${colors.text}12` }}>
        <form
          onSubmit={(e) => { e.preventDefault(); void sendMessage() }}
          className="flex items-center gap-2"
        >
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask a follow-up…"
            disabled={streaming}
            className={cn(
              'flex-1 bg-transparent text-sm outline-none placeholder:opacity-30',
              'border-b pb-0.5 transition-opacity',
              streaming ? 'opacity-40 cursor-not-allowed' : 'opacity-100',
            )}
            style={{ borderColor: `${colors.text}20` }}
          />
          <button
            type="submit"
            disabled={!input.trim() || streaming}
            className="opacity-40 hover:opacity-80 disabled:opacity-20 transition-opacity"
          >
            <ArrowRight size={16} />
          </button>
        </form>
      </div>
    </div>
  )
}

// ── Translate Panel ───────────────────────────────────────────────────────────

const LANGUAGES = [
  'Spanish', 'French', 'German', 'Italian', 'Portuguese',
  'Dutch', 'Russian', 'Japanese', 'Chinese', 'Korean', 'Arabic', 'Hindi',
]

function detectDefaultLanguage(): string {
  const tag = navigator.language?.split('-')[0] ?? 'en'
  const map: Record<string, string> = {
    es: 'Spanish', fr: 'French', de: 'German', it: 'Italian',
    pt: 'Portuguese', nl: 'Dutch', ru: 'Russian', ja: 'Japanese',
    zh: 'Chinese', ko: 'Korean', ar: 'Arabic', hi: 'Hindi',
  }
  return map[tag] ?? 'Spanish'
}

function TranslatePanel({ text, onClose, colors }: {
  text: string; onClose: () => void; colors: typeof THEMES['paper']
}) {
  const [lang,       setLang]       = useState(detectDefaultLanguage)
  const [result,     setResult]     = useState('')
  const [streaming,  setStreaming]  = useState(false)
  const [errMsg,     setErrMsg]     = useState('')
  const abortRef = useRef<AbortController | null>(null)

  async function translate(targetLang: string) {
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    setResult('')
    setErrMsg('')
    setStreaming(true)

    try {
      await streamTranslation(text, targetLang, (delta) => {
        setResult(prev => prev + delta)
      }, ac.signal)
    } catch (e: unknown) {
      if ((e as { name?: string }).name !== 'AbortError') {
        setErrMsg(aiErrorMessage(e, 'Translation failed.'))
      }
    } finally {
      setStreaming(false)
    }
  }

  // auto-translate on open
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void translate(lang)
    return () => abortRef.current?.abort()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function handleLangChange(newLang: string) {
    setLang(newLang)
    void translate(newLang)
  }

  return (
    <div style={{ color: colors.text, paddingBottom: 'max(env(safe-area-inset-bottom,0px),24px)' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-1 pb-3">
        <div className="flex items-center gap-2 opacity-55">
          <Languages size={13} />
          <span className="text-sm font-semibold uppercase tracking-wide">Translate</span>
        </div>
        <button onClick={onClose} className="p-1 opacity-40 hover:opacity-80 transition-opacity">
          <X size={16} />
        </button>
      </div>

      <div className="px-4 space-y-3">
        {/* Original text */}
        <div className="px-3.5 py-2.5 rounded-xl" style={{ backgroundColor: `${colors.text}07` }}>
          <p className="text-[13px] leading-relaxed line-clamp-3 opacity-60"
            style={{ fontFamily: 'Lora, Georgia, serif' }}>
            {text}
          </p>
        </div>

        {/* Language picker */}
        <div className="flex items-center gap-2 flex-wrap">
          {LANGUAGES.map(l => (
            <button
              key={l}
              onClick={() => handleLangChange(l)}
              disabled={streaming}
              className={cn(
                'px-2.5 py-1 rounded-full text-[11.5px] border transition-colors',
                lang === l
                  ? 'border-current opacity-80 font-medium'
                  : 'opacity-30 border-current/30 hover:opacity-55',
                streaming && 'cursor-not-allowed',
              )}
            >
              {l}
            </button>
          ))}
        </div>

        {/* Translation result */}
        <div className="min-h-[60px] pb-2">
          {errMsg ? (
            <p className="text-sm opacity-50">{errMsg}</p>
          ) : !result && streaming ? (
            <div className="flex items-center gap-2 py-3">
              <div className="w-4 h-4 rounded-full border-2 border-current border-t-transparent animate-spin opacity-35" />
              <span className="text-sm opacity-40">Translating…</span>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-sm leading-relaxed opacity-85" style={{ fontFamily: 'Lora, Georgia, serif' }}>
                {result}
                {streaming && (
                  <span className="inline-block w-[2px] h-[0.85em] ml-0.5 align-middle animate-pulse"
                    style={{ backgroundColor: colors.text, opacity: 0.45 }} />
                )}
              </p>
              {result && !streaming && (
                <button
                  onClick={() => { navigator.clipboard.writeText(result).catch(() => {}) }}
                  className="flex items-center gap-1.5 text-[11px] opacity-35 hover:opacity-60 transition-opacity"
                >
                  <Copy size={11} /> Copy translation
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Assistant Chat ────────────────────────────────────────────────────────────

function AssistantChat({ bookTitle, pageContext, onClose, colors }: {
  bookTitle: string
  pageContext: string
  onClose: () => void
  colors: typeof THEMES['paper']
}) {
  const [messages,  setMessages]  = useState<AIChatMessage[]>([])
  const [input,     setInput]     = useState('')
  const [streaming, setStreaming] = useState(false)
  const [errMsg,    setErrMsg]    = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef  = useRef<HTMLInputElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function runTurn(history: AIChatMessage[]) {
    setMessages([...history, { role: 'assistant', content: '' }])
    setStreaming(true)
    setErrMsg('')

    const ac = new AbortController()
    let assistantContent = ''

    try {
      await streamAssistantChat(bookTitle, pageContext, history, (delta) => {
        assistantContent += delta
        setMessages([...history, { role: 'assistant', content: assistantContent }])
      }, ac.signal)
    } catch (e: unknown) {
      if ((e as { name?: string }).name !== 'AbortError') {
        setErrMsg(aiErrorMessage(e))
        setMessages(history)
      }
    } finally {
      setStreaming(false)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }

  async function send() {
    const q = input.trim()
    if (!q || streaming) return
    setInput('')
    await runTurn([...messages, { role: 'user', content: q }])
  }

  const empty = messages.length === 0

  const SUGGESTIONS = [
    'What are the main themes?',
    'Summarize what I just read',
    'Who are the key characters?',
    'Explain the context of this passage',
  ]

  function sendSuggestion(text: string) {
    if (streaming) return
    void runTurn([{ role: 'user', content: text }])
  }

  const isDark = colors.bg === '#1a1a18'
  const bubbleBg   = isDark ? 'rgba(255,255,255,0.08)' : `${colors.text}0d`
  const aiBg       = isDark ? 'rgba(255,255,255,0.04)' : `${colors.text}06`
  const chipBg     = isDark ? 'rgba(255,255,255,0.06)' : `${colors.text}08`
  const chipBorder = isDark ? 'rgba(255,255,255,0.10)' : `${colors.text}14`

  return (
    <div
      className="flex flex-col"
      style={{ color: colors.text, height: '72vh', paddingBottom: 'env(safe-area-inset-bottom,0px)' }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-1 pb-3 shrink-0">
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full bg-[#2383e2]" />
            <span className="text-[11px] font-semibold uppercase tracking-widest" style={{ opacity: 0.45 }}>Assistant</span>
          </div>
          <p
            className="text-[12.5px] font-medium pl-3.5 line-clamp-1 max-w-[220px]"
            style={{ opacity: 0.55, fontFamily: 'Lora, Georgia, serif', fontStyle: 'italic' }}
          >
            {bookTitle}
          </p>
        </div>
        <button onClick={onClose} className="p-1.5 rounded-md transition-opacity" style={{ opacity: 0.35 }}
          onMouseEnter={e => (e.currentTarget.style.opacity = '0.7')}
          onMouseLeave={e => (e.currentTarget.style.opacity = '0.35')}
        >
          <X size={15} />
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-3">
        {empty ? (
          <div className="flex flex-col items-center pt-6 pb-2 gap-5">
            {/* Greeting */}
            <div className="text-center space-y-1 select-none">
              <p className="text-[13px] font-medium" style={{ opacity: 0.7 }}>What would you like to know?</p>
              <p className="text-[11.5px]" style={{ opacity: 0.35 }}>About this book or your current page</p>
            </div>

            {/* Suggestion chips */}
            <div className="flex flex-col gap-2 w-full">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => sendSuggestion(s)}
                  className="text-left px-3.5 py-2.5 rounded-xl text-[12.5px] leading-snug transition-all"
                  style={{
                    backgroundColor: chipBg,
                    border: `1px solid ${chipBorder}`,
                    color: colors.text,
                    opacity: 0.8,
                  }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.opacity = '1' }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.opacity = '0.8' }}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m, i) => {
            const isLast = i === messages.length - 1
            if (m.role === 'user') {
              return (
                <div key={i} className="flex justify-end">
                  <div
                    className="max-w-[82%] px-3.5 py-2.5 rounded-2xl rounded-br-sm text-[13px] leading-relaxed"
                    style={{ backgroundColor: bubbleBg }}
                  >
                    {m.content}
                  </div>
                </div>
              )
            }
            return (
              <div key={i} className="flex justify-start gap-2.5">
                {/* AI dot */}
                <div className="mt-[5px] shrink-0 w-5 h-5 rounded-full bg-[#2383e2]/15 flex items-center justify-center">
                  <div className="w-1.5 h-1.5 rounded-full bg-[#2383e2]" />
                </div>
                <div
                  className="flex-1 min-w-0 px-3 py-2.5 rounded-2xl rounded-bl-sm text-[13px] leading-relaxed whitespace-pre-wrap"
                  style={{ backgroundColor: aiBg }}
                >
                  {!m.content && streaming && isLast ? (
                    <div className="flex items-center gap-1 py-0.5">
                      {[0, 1, 2].map((d) => (
                        <div
                          key={d}
                          className="w-1.5 h-1.5 rounded-full bg-[#2383e2] animate-bounce"
                          style={{ animationDelay: `${d * 120}ms`, opacity: 0.6 }}
                        />
                      ))}
                    </div>
                  ) : (
                    <>
                      {m.content}
                      {streaming && isLast && (
                        <span
                          className="inline-block w-[2px] h-[0.85em] ml-0.5 align-middle rounded-full animate-pulse bg-[#2383e2]"
                          style={{ opacity: 0.6 }}
                        />
                      )}
                    </>
                  )}
                </div>
              </div>
            )
          })
        )}
        {errMsg && (
          <p className="text-[11.5px] px-2 py-1.5 rounded-lg text-center" style={{ opacity: 0.5, backgroundColor: `${colors.text}08` }}>
            {errMsg}
          </p>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="px-4 pb-4 pt-2 shrink-0">
        <form
          onSubmit={(e) => { e.preventDefault(); void send() }}
          className="flex items-center gap-2 rounded-2xl px-3.5 py-2.5"
          style={{ backgroundColor: chipBg, border: `1px solid ${chipBorder}` }}
        >
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={empty ? 'Ask anything…' : 'Ask a follow-up…'}
            disabled={streaming}
            autoFocus
            className="flex-1 bg-transparent text-[13px] outline-none"
            style={{
              color: colors.text,
              opacity: streaming ? 0.4 : 1,
              cursor: streaming ? 'not-allowed' : 'text',
            }}
          />
          <button
            type="submit"
            disabled={!input.trim() || streaming}
            className="shrink-0 w-6 h-6 rounded-full bg-[#2383e2] flex items-center justify-center transition-opacity disabled:opacity-20"
            style={{ opacity: input.trim() && !streaming ? 1 : undefined }}
          >
            <ArrowRight size={12} strokeWidth={2.5} color="white" />
          </button>
        </form>
      </div>
    </div>
  )
}

// ── Appearance Content ────────────────────────────────────────────────────────

function AppearanceContent({ appearance, onChange, onClose }: {
  appearance: Appearance
  onChange: (patch: Partial<Appearance>) => void
  onClose: () => void
}) {
  const colors = THEMES[appearance.theme]

  return (
    <div className="px-4 pt-1 pb-safe space-y-5"
      style={{ color: colors.text, paddingBottom: 'max(env(safe-area-inset-bottom,0px), 20px)' }}>
      <div className="flex items-center justify-between py-2">
        <span className="text-sm font-semibold tracking-wide uppercase opacity-55">Appearance</span>
        <button onClick={onClose} className="p-1 rounded-full opacity-40 hover:opacity-80 transition-opacity">
          <X size={16} />
        </button>
      </div>

      {/* Font */}
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-widest opacity-40 mb-2">Font</p>
        <div className="flex gap-2">
          {(['serif', 'sans'] as const).map((f) => (
            <button key={f} onClick={() => onChange({ font: f })}
              className={cn('flex-1 py-2.5 rounded-xl border text-sm font-medium transition-all',
                appearance.font === f ? 'border-primary bg-primary text-white shadow-sm' : 'border-border/60 opacity-55 hover:opacity-90')}
              style={{ fontFamily: f === 'serif' ? 'Lora, Georgia, serif' : 'Inter, sans-serif' }}>
              {f === 'serif' ? 'Serif' : 'Sans'}
            </button>
          ))}
        </div>
      </div>

      {/* Font size */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <p className="text-[11px] font-semibold uppercase tracking-widest opacity-40">Size</p>
          <span className="text-xs opacity-40 tabular-nums">{appearance.fontSize}px</span>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={() => onChange({ fontSize: Math.max(14, appearance.fontSize - 1) })}
            disabled={appearance.fontSize <= 14}
            className="p-1.5 rounded-lg border border-border/60 opacity-55 hover:opacity-90 disabled:opacity-20">
            <Minus size={14} />
          </button>
          <Slider value={[appearance.fontSize]} min={14} max={22} step={1}
            onValueChange={(val) => onChange({ fontSize: Array.isArray(val) ? val[0] : (val as number) })}
            className="flex-1" />
          <button onClick={() => onChange({ fontSize: Math.min(22, appearance.fontSize + 1) })}
            disabled={appearance.fontSize >= 22}
            className="p-1.5 rounded-lg border border-border/60 opacity-55 hover:opacity-90 disabled:opacity-20">
            <Plus size={14} />
          </button>
        </div>
      </div>

      {/* Line spacing */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <p className="text-[11px] font-semibold uppercase tracking-widest opacity-40">Spacing</p>
          <span className="text-xs opacity-40 tabular-nums">{appearance.lineHeight.toFixed(1)}×</span>
        </div>
        <Slider value={[Math.round(appearance.lineHeight * 10)]} min={15} max={22} step={1}
          onValueChange={(val) => onChange({ lineHeight: (Array.isArray(val) ? val[0] : (val as number)) / 10 })} />
      </div>

      {/* Width */}
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-widest opacity-40 mb-2">Width</p>
        <div className="flex gap-2">
          {(['narrow', 'balanced', 'wide'] as const).map((w) => (
            <button key={w} onClick={() => onChange({ width: w })}
              className={cn('flex-1 py-2.5 rounded-xl border text-sm font-medium capitalize transition-all',
                appearance.width === w ? 'border-primary bg-primary text-white shadow-sm' : 'border-border/60 opacity-55 hover:opacity-90')}>
              {w}
            </button>
          ))}
        </div>
      </div>

      {/* Align */}
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-widest opacity-40 mb-2">Align</p>
        <div className="flex gap-2">
          {([
            { id: 'left' as const,    Icon: AlignLeft    },
            { id: 'center' as const,  Icon: AlignCenter  },
            { id: 'justify' as const, Icon: AlignJustify },
          ]).map(({ id, Icon }) => (
            <button key={id} onClick={() => onChange({ align: id })}
              className={cn('flex-1 py-2.5 rounded-xl border flex items-center justify-center transition-all',
                appearance.align === id ? 'border-primary bg-primary text-white shadow-sm' : 'border-border/60 opacity-55 hover:opacity-90')}>
              <Icon size={16} />
            </button>
          ))}
        </div>
      </div>

      {/* Theme */}
      <div className="pb-2">
        <p className="text-[11px] font-semibold uppercase tracking-widest opacity-40 mb-2">Theme</p>
        <div className="flex gap-2">
          {([
            { id: 'paper' as const, bg: '#fbf8f4', fg: '#1c1c1e', label: 'Paper' },
            { id: 'white' as const, bg: '#ffffff', fg: '#1c1c1e', label: 'White' },
            { id: 'dark'  as const, bg: '#1a1a18', fg: '#e8e6e1', label: 'Dark'  },
          ]).map(({ id, bg, fg, label }) => (
            <button key={id} onClick={() => onChange({ theme: id })}
              className={cn('flex-1 py-2.5 rounded-xl border text-sm font-medium transition-all',
                appearance.theme === id ? 'ring-2 ring-primary ring-offset-2' : 'hover:opacity-80')}
              style={{ backgroundColor: bg, color: fg, borderColor: `${fg}22` }}>
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Audio Content ─────────────────────────────────────────────────────────────

// ── Audio chunk helpers ───────────────────────────────────────────────────────

/**
 * Split text into chunks at sentence boundaries.
 * Returns absolute offsets within the full book text so the backend can
 * validate each slice against the canonical book text.
 */
function buildAudioChunks(
  fullText: string,
  globalStart: number,
  targetChars: number,
  firstTargetChars = targetChars,
): Array<{ start: number; end: number; text: string }> {
  const chunks: Array<{ start: number; end: number; text: string }> = []
  let localPos = 0

  while (localPos < fullText.length) {
    const isFirstChunk = chunks.length === 0
    const currentTarget = isFirstChunk ? firstTargetChars : targetChars
    const remaining = fullText.length - localPos
    if (remaining <= currentTarget) {
      // Last (or only) chunk — take everything left
      chunks.push({
        start: globalStart + localPos,
        end:   globalStart + fullText.length,
        text:  fullText.slice(localPos),
      })
      break
    }

    const backtrack = isFirstChunk ? 60 : 100
    const lookahead = isFirstChunk ? 60 : 200
    const searchStart = Math.max(0, currentTarget - backtrack)
    // Find the last sentence boundary near the target. The first chunk gets a
    // narrow window so startup latency stays low even if it cuts earlier.
    const searchWindow = fullText.slice(localPos + searchStart,
                                        localPos + currentTarget + lookahead)
    let boundary = -1
    for (let i = searchWindow.length - 1; i >= 0; i--) {
      if (/[.!?]/.test(searchWindow[i]) && /[\s"']/.test(searchWindow[i + 1] ?? ' ')) {
        boundary = i + 1
        break
      }
    }

    const hardSlice = fullText.slice(localPos, localPos + currentTarget)
    const lastSpace = Math.max(hardSlice.lastIndexOf(' '), hardSlice.lastIndexOf('\n'), hardSlice.lastIndexOf('\t'))
    const chunkLen = boundary >= 0
      ? searchStart + boundary
      : (lastSpace > currentTarget * 0.6 ? lastSpace + 1 : currentTarget)

    const localEnd = localPos + chunkLen
    const slice = fullText.slice(localPos, localEnd)
    if (slice.trim()) {
      chunks.push({ start: globalStart + localPos, end: globalStart + localEnd, text: slice })
    }
    localPos = localEnd
  }

  return chunks.filter(c => c.text.trim())
}

// (chunk sizes live in CHUNK_CHARS above — kept here for legacy grep)

// ── Audio Content ─────────────────────────────────────────────────────────────

type AudioPhase = 'idle' | 'buffering' | 'playing' | 'paused'
type ChunkStatus = 'idle' | 'fetching' | 'ready' | 'error'
interface AudioChunk {
  start: number
  end: number
  text: string
  url: string | null
  buffer: AudioBuffer | null
  status: ChunkStatus
  cues?: LiveAudioCue[]
  tapOffset?: number  // char offset to seek to on first chunk (grid-aligned playback)
}

// Binary search: find the grid chunk whose range contains `offset`.
function findGridChunk(grid: Array<{ start: number; end: number }>, offset: number): number {
  let lo = 0
  let hi = grid.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (grid[mid].end <= offset) lo = mid + 1
    else hi = mid
  }
  return lo
}

export interface AudioHandle {
  toggle: () => void
  stop:   () => void
}

function AudioContent({ onClose, colors, provider, onProviderChange, voice, onVoiceChange, onError }: {
  onClose: () => void
  colors: typeof THEMES['paper']
  provider: string; onProviderChange: (p: string) => void
  voice: string | null; onVoiceChange: (v: string | null) => void
  onError?: (message: string) => void
}) {
  const [phase,   setPhase]   = useState<'idle' | 'buffering' | 'playing' | 'paused'>('idle')
  const [chunks,  setChunks]  = useState<AudioChunk[]>([])
  const [curIdx,  setCurIdx]  = useState(0)
  const [rate,    setRate]    = useState(1.0)
  const [sampleText, setSampleText] = useState(PROVIDER_PREVIEW_TEXT)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const audioRef    = useRef<HTMLAudioElement | null>(null)
  const rateRef     = useRef(rate)
  const chunksRef   = useRef<AudioChunk[]>([])
  const curIdxRef   = useRef(0)
  const abortRef    = useRef<AbortController | null>(null)
  const audioObjectUrlsRef = useRef<Set<string>>(new Set())
  const chunkFetchesRef = useRef<Map<number, Promise<string | null>>>(new Map())
  rateRef.current   = rate
  chunksRef.current = chunks

  function rememberAudioObjectUrl(url: string) {
    if (url.startsWith('blob:')) audioObjectUrlsRef.current.add(url)
  }

  function revokeAudioObjectUrls() {
    for (const url of audioObjectUrlsRef.current) URL.revokeObjectURL(url)
    audioObjectUrlsRef.current.clear()
  }

  useEffect(() => () => {
    abortRef.current?.abort()
    audioRef.current?.pause()
    chunkFetchesRef.current.clear()
    revokeAudioObjectUrls()
  }, [])

  // Fetch voice list
  const { data: providersRes } = useQuery({
    queryKey: ['providers'],
    queryFn:  () => api.get<ProvidersResponse>('/api/providers'),
    staleTime: 5 * 60_000,
  })
  const providerOptions = providerOptionsFromCatalog(providersRes?.providers)
  const activeProvider = providerOptions.find(p => p.id === provider)
  const providerVoices = activeProvider?.voices ?? []
  const selectedProviderUnavailable = Boolean(providersRes?.providers?.length && (!activeProvider || !activeProvider.available))
  const selectedVoiceId = voice ?? (providerVoices[0]?.id ?? null)
  const selectedVoiceIndex = providerVoices.findIndex((item) => item.id === selectedVoiceId)

  // ── Fetch a single chunk and store its URL ──────────────────────────────────

  function updateChunk(idx: number, patch: Partial<AudioChunk>) {
    const next = [...chunksRef.current]
    if (next[idx]) next[idx] = { ...next[idx], ...patch }
    chunksRef.current = next
    setChunks(next)
  }

  async function fetchChunk(idx: number, _chunk: AudioChunk, signal: AbortSignal): Promise<string | null> {
    const existingChunk = chunksRef.current[idx]
    if (existingChunk?.url) return existingChunk.url
    const existingFetch = chunkFetchesRef.current.get(idx)
    if (existingFetch) return existingFetch

    updateChunk(idx, { status: 'fetching' })
    const fetchPromise = (async () => {
      try {
        const { lengthScale, sentenceSilence } = pacingFor(provider)
        const previewLengthScale = Math.max(0.6, Math.min(lengthScale * rateRef.current, 1.5))
        const preview = await request<ProviderTestResult>('/api/providers/test', {
          method: 'POST',
          body: JSON.stringify({
            provider,
            voice,
            model: null,
            narration_style: '',
            length_scale: previewLengthScale,
            sentence_silence: sentenceSilence,
          }),
          signal,
        })
        if (signal.aborted) return null
        const playable = await playableAudioUrl(preview.audioUrl, signal)
        if (signal.aborted) {
          playable.revoke()
          return null
        }
        setSampleText(preview.sampleText || PROVIDER_PREVIEW_TEXT)
        rememberAudioObjectUrl(playable.url)
        updateChunk(idx, { status: 'ready', url: playable.url })
        return playable.url
      } catch (e) {
        if ((e as Error).name !== 'AbortError') {
          const message = audioErrorMessage(e)
          setErrorMsg(message)
          onError?.(message)
          updateChunk(idx, { status: 'error' })
        }
        return null
      } finally {
        chunkFetchesRef.current.delete(idx)
      }
    })()

    chunkFetchesRef.current.set(idx, fetchPromise)
    return fetchPromise
  }

  function prefetchAhead(fromIdx: number, currentChunks: AudioChunk[], signal: AbortSignal) {
    if (signal.aborted) return
    const target = PREFETCH_AHEAD_TARGET[provider] ?? DEFAULT_PREFETCH_AHEAD
    for (let offset = 1; offset <= target; offset += 1) {
      const idx = fromIdx + offset
      const chunk = currentChunks[idx]
      if (!chunk) break
      if (chunk.url || chunk.status === 'fetching') continue
      if (chunk.status === 'idle') {
        void fetchChunk(idx, chunk, signal)
      }
    }
  }

  async function continuePlayback(nextIdx: number, ctrl: AbortController) {
    const latest = chunksRef.current
    if (nextIdx >= latest.length) {
      setPhase('idle')
      setCurIdx(0)
      curIdxRef.current = 0
      revokeAudioObjectUrls()
      return
    }

    const nextChunk = latest[nextIdx]
    if (nextChunk.url) {
      playChunkAt(nextIdx, latest, ctrl)
      return
    }

    setPhase('buffering')
    const url = await fetchChunk(nextIdx, nextChunk, ctrl.signal)
    if (ctrl.signal.aborted) return
    if (!url) {
      setPhase('idle')
      return
    }
    playChunkAt(nextIdx, chunksRef.current, ctrl)
  }

  // ── Play a chunk, prefetch next, chain onended ──────────────────────────────

  function playChunkAt(idx: number, currentChunks: AudioChunk[], ctrl: AbortController) {
    const c = currentChunks[idx]
    if (!c?.url) return

    audioRef.current?.pause()
    const audio = new Audio(c.url)
    audio.playbackRate = rateRef.current
    audioRef.current  = audio
    setPhase('playing')
    setCurIdx(idx)
    curIdxRef.current = idx
    setErrorMsg(null)
    audio.play().catch(() => {
      if (ctrl.signal.aborted) return
      setPhase('paused')
      setErrorMsg('Audio is ready. Tap play again to start playback.')
    })

    // Keep the next couple of chunks in flight while the current one is playing.
    prefetchAhead(idx, currentChunks, ctrl.signal)

    audio.onended = () => {
      if (ctrl.signal.aborted) return
      void continuePlayback(idx + 1, ctrl)
    }
    audio.onerror = () => {
      if (ctrl.signal.aborted) return
      setErrorMsg('Audio playback failed. Try starting it again.')
      setPhase('idle')
    }
  }

  // ── Start / stop ────────────────────────────────────────────────────────────

  async function startPlayback() {
    abortRef.current?.abort()
    audioRef.current?.pause()
    revokeAudioObjectUrls()
    chunkFetchesRef.current.clear()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setErrorMsg(null)

    if (selectedProviderUnavailable) {
      const message = `${activeProvider?.label ?? provider} is not configured yet. Choose an available provider.`
      setErrorMsg(message)
      onError?.(message)
      return
    }

    if (!selectedVoiceId) {
      setErrorMsg('Choose a voice to preview.')
      return
    }

    const initial: AudioChunk[] = [{ start: 0, end: 0, text: sampleText, url: null, buffer: null, status: 'idle' }]
    setChunks(initial)
    chunksRef.current = initial
    setCurIdx(0)
    curIdxRef.current = 0
    setPhase('buffering')

    const url0 = await fetchChunk(0, initial[0], ctrl.signal)
    if (ctrl.signal.aborted || !url0) { setPhase('idle'); return }

    playChunkAt(0, chunksRef.current, ctrl)
  }

  function stopPlayback() {
    abortRef.current?.abort()
    audioRef.current?.pause()
    revokeAudioObjectUrls()
    chunkFetchesRef.current.clear()
    setPhase('idle')
    setCurIdx(0)
    curIdxRef.current = 0
  }

  function togglePlay() {
    if (phase === 'playing') {
      audioRef.current?.pause()
      setPhase('paused')
    } else if (phase === 'paused') {
      setErrorMsg(null)
      audioRef.current?.play()
        .then(() => setPhase('playing'))
        .catch(() => {
          setErrorMsg('Playback was blocked by the browser. Tap play again.')
          setPhase('paused')
        })
    } else if (phase === 'idle') {
      startPlayback()
    }
    // 'buffering' → ignore taps
  }

  // Stop when sheet closes
  const handleClose = () => { stopPlayback(); onClose() }

  // ── Derived UI state ────────────────────────────────────────────────────────
  const isIdle      = phase === 'idle'
  const isBuffering = phase === 'buffering'
  const isPlaying   = phase === 'playing'
  const isPaused    = phase === 'paused'
  const playDisabled = isBuffering || selectedProviderUnavailable || !selectedVoiceId

  const totalChunks  = chunks.length
  const readyChunks  = chunks.filter(c => c.status === 'ready').length
  const showProgress = !isIdle && totalChunks > 1

  // Buffering label
  const bufferLabel = (() => {
    if (!isBuffering) return null
    if (provider === 'neutts_local' || provider === 'kokoro') return 'Generating sample…'
    return 'Loading preview…'
  })()

  function cycleVoice(direction: -1 | 1) {
    if (providerVoices.length < 2) return
    const baseIndex = selectedVoiceIndex >= 0 ? selectedVoiceIndex : 0
    const nextIndex = (baseIndex + direction + providerVoices.length) % providerVoices.length
    stopPlayback()
    setErrorMsg(null)
    onVoiceChange(providerVoices[nextIndex].id)
  }

  return (
    <div className="px-4 pt-1 pb-safe space-y-5"
      style={{ color: colors.text, paddingBottom: 'max(env(safe-area-inset-bottom,0px), 20px)' }}>
      <div className="flex items-center justify-between py-2">
        <span className="text-sm font-semibold tracking-wide uppercase opacity-55">Audio</span>
        <button onClick={handleClose}
          className="p-1 rounded-full opacity-40 hover:opacity-80 transition-opacity">
          <X size={16} />
        </button>
      </div>

      {/* Provider */}
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-widest opacity-40 mb-2">Provider</p>
        <Select value={provider} onValueChange={(v) => {
          if (v == null) return
          stopPlayback()
          setErrorMsg(null)
          const nextProvider = providerOptions.find(p => p.id === v)
          onProviderChange(v)
          onVoiceChange(defaultVoiceForProvider(nextProvider))
        }}>
          <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            {providerOptions.map((p) => (
              <SelectItem key={p.id} value={p.id} disabled={!p.available}>
                {p.label}{p.available ? '' : ' (not configured)'}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Voice */}
      {providerVoices.length > 0 && (
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-widest opacity-40 mb-2">Voice</p>
          <Select
            value={voice ?? (providerVoices[0]?.id ?? '')}
            onValueChange={(v) => { if (v != null) { stopPlayback(); setErrorMsg(null); onVoiceChange(v) } }}
          >
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {providerVoices.map((v) => (
                <SelectItem key={v.id} value={v.id}>{v.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Speed */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <p className="text-[11px] font-semibold uppercase tracking-widest opacity-40">Speed</p>
          <span className="text-xs opacity-40 tabular-nums">{rate.toFixed(1)}×</span>
        </div>
        <Slider value={[Math.round(rate * 10)]} min={5} max={25} step={1}
          onValueChange={(val) => {
            const r = (Array.isArray(val) ? val[0] : (val as number)) / 10
            setRate(r)
            rateRef.current = r
            if (audioRef.current) audioRef.current.playbackRate = r
          }} />
      </div>

      <div className="rounded-2xl border px-4 py-3 space-y-1.5"
        style={{ borderColor: `${colors.text}12`, background: `${colors.text}05` }}>
        <p className="text-[11px] font-semibold uppercase tracking-widest opacity-40">Voice Sample</p>
        <p className="text-sm leading-6 opacity-75 italic">
          "{sampleText}"
        </p>
      </div>

      {/* Progress bar — visible while loading/playing multi-chunk */}
      {showProgress && (
        <div className="space-y-1.5">
          <div className="h-1 rounded-full overflow-hidden" style={{ background: `${colors.text}15` }}>
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{
                width: `${Math.round((readyChunks / totalChunks) * 100)}%`,
                background: colors.text,
                opacity: 0.35,
              }}
            />
          </div>
          <p className="text-[10px] opacity-35 text-center tabular-nums">
            {isPlaying || isPaused
              ? `Part ${curIdx + 1} of ${totalChunks}`
              : bufferLabel}
          </p>
        </div>
      )}

      {isBuffering && !showProgress && (
        <p className="text-xs text-center opacity-40">{bufferLabel}</p>
      )}

      {errorMsg && (
        <p className="rounded-xl border px-3 py-2 text-xs leading-relaxed"
          style={{ borderColor: `${colors.text}18`, background: `${colors.text}08`, color: colors.text }}>
          {errorMsg}
        </p>
      )}

      {/* Controls */}
      <div className="flex items-center justify-center gap-8 py-2 pb-4">
        <button
          onClick={() => cycleVoice(-1)}
          disabled={providerVoices.length < 2 || isBuffering}
          className="p-2 opacity-30 hover:opacity-60 transition-opacity disabled:opacity-15"
          aria-label="Previous voice"
        ><SkipBack size={22} /></button>
        <button
          onClick={togglePlay}
          disabled={playDisabled}
          className="w-14 h-14 rounded-full bg-primary text-white flex items-center justify-center shadow-lg active:scale-95 transition-transform disabled:opacity-50"
        >
          {isBuffering
            ? <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
            : (isPlaying
                ? <Pause size={24} />
                : <Play size={24} fill="currentColor" />
              )}
        </button>
        <button
          onClick={() => cycleVoice(1)}
          disabled={providerVoices.length < 2 || isBuffering}
          className="p-2 opacity-30 hover:opacity-60 transition-opacity disabled:opacity-15"
          aria-label="Next voice"
        ><SkipForward size={22} /></button>
      </div>
    </div>
  )
}

// ── Word Audio Banner ─────────────────────────────────────────────────────────

// ── Play Bar ──────────────────────────────────────────────────────────────────
// Persistent bottom bar visible while audio is buffering / playing / paused.
// Lives outside the sheet so it stays visible when the sheet is closed.

function PlayBar({ phase, curIdx, totalChunks, voiceLabel, colors, handle, onOpenSheet }: {
  phase:       AudioPhase
  curIdx:      number
  totalChunks: number
  voiceLabel:  string
  colors:      typeof THEMES['paper']
  handle:      AudioHandle | null
  onOpenSheet: () => void
}) {
  const isBuffering = phase === 'buffering'
  const isPlaying   = phase === 'playing'

  const progressPct = totalChunks > 1
    ? Math.round(((curIdx + (isPlaying ? 1 : 0)) / totalChunks) * 100)
    : 0

  return (
    <motion.div
      className="fixed bottom-0 left-0 right-0 z-40 flex items-center gap-3 px-4 py-3"
      style={{
        background: colors.bg,
        borderTop: `1px solid ${colors.text}12`,
        paddingBottom: 'max(env(safe-area-inset-bottom, 12px), 12px)',
      }}
      initial={{ y: 80, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ y: 80, opacity: 0 }}
      transition={{ type: 'spring', damping: 32, stiffness: 300 }}
    >
      {/* Voice label — tapping reopens the audio sheet */}
      <button
        className="flex-1 min-w-0 text-left"
        onClick={onOpenSheet}
      >
        <p className="text-[11px] font-semibold uppercase tracking-widest opacity-40 leading-none mb-0.5">
          Now playing
        </p>
        <p className="text-sm truncate" style={{ color: colors.text, opacity: 0.75 }}>
          {voiceLabel}
        </p>
      </button>

      {/* Chunk progress bar */}
      {totalChunks > 1 && (
        <div className="w-20 h-0.5 rounded-full overflow-hidden shrink-0" style={{ background: `${colors.text}15` }}>
          <div
            className="h-full rounded-full transition-all duration-700"
            style={{ width: `${progressPct}%`, background: colors.text, opacity: 0.3 }}
          />
        </div>
      )}

      {/* Play / Pause */}
      <button
        onClick={() => handle?.toggle()}
        disabled={isBuffering}
        className="w-10 h-10 rounded-full flex items-center justify-center active:scale-90 transition-transform disabled:opacity-40 shrink-0"
        style={{ background: `${colors.text}12` }}
      >
        {isBuffering
          ? <div className="w-4 h-4 border-[1.5px] border-current border-t-transparent rounded-full animate-spin" style={{ color: colors.text }} />
          : isPlaying
            ? <Pause size={18} style={{ color: colors.text }} />
            : <Play  size={18} fill={colors.text} style={{ color: colors.text }} />
        }
      </button>

      {/* Stop */}
      <button
        onClick={() => handle?.stop()}
        className="w-8 h-8 rounded-full flex items-center justify-center opacity-40 hover:opacity-70 active:scale-90 transition-all shrink-0"
      >
        <X size={16} style={{ color: colors.text }} />
      </button>
    </motion.div>
  )
}

// ── Toast ─────────────────────────────────────────────────────────────────────

function Toast({ msg }: { msg: string }) {
  return (
    <motion.div
      className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[70] px-4 py-2 rounded-full text-sm font-medium text-white pointer-events-none"
      style={{ background: 'rgba(28,28,30,0.92)', backdropFilter: 'blur(12px)' }}
      initial={{ opacity: 0, y: 6, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -4, scale: 0.95 }}
      transition={{ duration: 0.16 }}
    >
      {msg}
    </motion.div>
  )
}

// ── Main ReaderRoute ──────────────────────────────────────────────────────────

export function ReaderRoute() {
  const { bookId } = useParams<{ bookId: string }>()
  const queryClient = useQueryClient()

  const [appearance,    setAppearance]    = useState<Appearance>(loadAppearance)
  const [sheet,         setSheet]         = useState<'none' | 'appearance' | 'audio' | 'chat'>('none')
  const [scrollPct,     setScrollPct]     = useState(0)
  const [barVisible,    setBarVisible]    = useState(true)
  const [selection,     setSelection]     = useState<SelectionState | null>(null)
  const [panel,         setPanel]         = useState<SecondaryPanel | null>(null)
  const [toast,         setToast]         = useState<string | null>(null)
  const [wordAudio,     setWordAudio]     = useState<{ word: string; status: 'loading' | 'ready' | 'playing' } | null>(null)
  const [wordAudioCurIdx, setWordAudioCurIdx] = useState(0)
  const [wordAudioTotal,  setWordAudioTotal]  = useState(0)
  const [audioFollowRects, setAudioFollowRects] = useState<SelectionRect[]>([])
  const [presynthJobId,    setPresynthJobId]    = useState<string | null>(null)
  const [presynthProgress, setPresynthProgress] = useState<{ completed: number; total: number } | null>(null)
  const [ttsProvider,   setTtsProvider]   = useState(() => loadAudioPrefs().provider)
  const [ttsVoice,      setTtsVoice]      = useState<string | null>(() => loadAudioPrefs().voice)

  const lastScrollY           = useRef(0)
  const latestScrollPct       = useRef(0)
  const scrollTimer           = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveTimer             = useRef<ReturnType<typeof setTimeout> | null>(null)
  const justShowedMenu        = useRef(false)
  const scrolledToOffsetRef   = useRef(false)
  const wordAudioRef          = useRef<HTMLAudioElement | null>(null)
  const wordAudioAbortRef     = useRef<AbortController | null>(null)
  const wordAudioCurIdxRef    = useRef(0)
  const wordAudioChunksRef    = useRef<AudioChunk[]>([])
  const wordAudioChunkFetchesRef = useRef<Map<number, Promise<string | null>>>(new Map())
  const wordAudioObjectUrlsRef = useRef<Set<string>>(new Set())
  // Web Audio API — gapless playback
  const wordAudioCtxRef           = useRef<AudioContext | null>(null)
  const wordAudioSourceRef        = useRef<AudioBufferSourceNode | null>(null)
  const wordAudioScheduledEndRef  = useRef<number>(0)
  const wordAudioChunkStartRef    = useRef<number>(0)
  const wordAudioRafRef           = useRef<number | null>(null)
  const activeAudioCueKeyRef    = useRef<string | null>(null)
  const activeAudioCueRangeRef  = useRef<{ start: number; end: number } | null>(null)
  const presynthGridRef         = useRef<Array<{ start: number; end: number }> | null>(null)
  const wordAudioChunkSeekRef   = useRef<number>(0)
  const presynthPollRef         = useRef<ReturnType<typeof setTimeout> | null>(null)
  const readerTextRef         = useRef<HTMLDivElement | null>(null)
  const panelSnapshotRef      = useRef<SecondaryPanel | null>(null)
  const openPanel = useCallback((nextPanel: SecondaryPanel) => {
    panelSnapshotRef.current = nextPanel
    setPanel(nextPanel)
  }, [])
  const closePanel = useCallback(() => setPanel(null), [])
  const showToast = useCallback((msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(t => (t === msg ? null : t)), 2200)
  }, [])

  // Fetch
  const { data: payload, isLoading } = useQuery({
    queryKey: ['reader', bookId],
    queryFn:  () => api.get<ReaderPayload>(`/api/books/${bookId}/reader`),
    enabled:  Boolean(bookId),
  })

  const { data: progressData } = useQuery({
    queryKey: ['progress', bookId],
    queryFn:  () => api.get<ProgressPayload>(`/api/books/${bookId}/progress`),
    enabled:  Boolean(bookId),
  })

  const { data: providersData } = useQuery({
    queryKey: ['providers'],
    queryFn:  () => api.get<ProvidersResponse>('/api/providers'),
    staleTime: 5 * 60_000,
  })
  const activeProviderInfo = providersData?.providers?.find(p => p.id === ttsProvider)
  const fallbackProviderInfo = providersData?.providers?.length
    ? pickFallbackProvider(providersData.providers)
    : null
  const useProviderFallback = Boolean(providersData?.providers?.length && fallbackProviderInfo && (!activeProviderInfo || !activeProviderInfo.available))
  const effectiveTtsProvider = useProviderFallback && fallbackProviderInfo ? fallbackProviderInfo.id : ttsProvider
  const effectiveTtsVoice = useProviderFallback && fallbackProviderInfo ? defaultVoiceForProvider(fallbackProviderInfo) : ttsVoice
  const effectiveProviderInfo = providersData?.providers?.find(p => p.id === effectiveTtsProvider)
  const playBarVoiceLabel = effectiveProviderInfo
    ?.voices.find(v => v.id === effectiveTtsVoice)
    ?.label ?? effectiveTtsVoice ?? effectiveProviderInfo?.name ?? effectiveTtsProvider
  const wordAudioPhase: AudioPhase = !wordAudio
    ? 'idle'
    : wordAudio.status === 'loading'
      ? 'buffering'
      : wordAudio.status === 'playing'
        ? 'playing'
        : 'paused'

  // Restore scroll position — also handles ?offset= from notes navigation
  useEffect(() => {
    if (!payload?.text) return

    if (!scrolledToOffsetRef.current) {
      const params = new URLSearchParams(window.location.search)
      const offsetStr = params.get('offset')
      if (offsetStr !== null) {
        const offset = parseInt(offsetStr, 10)
        if (!isNaN(offset) && offset >= 0) {
          scrolledToOffsetRef.current = true
          const pct = offset / payload.text.length
          const maxScroll = document.documentElement.scrollHeight - window.innerHeight
          window.scrollTo({ top: pct * maxScroll, behavior: 'instant' })
          window.history.replaceState({}, '', window.location.pathname)
          return
        }
      }
    }

    if (scrolledToOffsetRef.current) return
    if (!progressData?.reading) return
    const { textStart, textLength } = progressData.reading
    if (!textLength) return
    const pct = textStart / textLength
    const maxScroll = document.documentElement.scrollHeight - window.innerHeight
    window.scrollTo({ top: pct * maxScroll, behavior: 'instant' })
    scrolledToOffsetRef.current = true
  }, [progressData, payload?.text])

  // Persist appearance
  useEffect(() => {
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify(appearance))
  }, [appearance])

  // Persist audio prefs
  useEffect(() => {
    localStorage.setItem(AUDIO_PREFS_KEY, JSON.stringify({ provider: effectiveTtsProvider, voice: effectiveTtsVoice }))
  }, [effectiveTtsProvider, effectiveTtsVoice])

  // Background warmup — fire as soon as a local provider is selected so the model is
  // loaded by the time the user opens the audio sheet. Fire-and-forget, no UI blocking.
  useEffect(() => {
    if (!['neutts_local', 'qwen_local'].includes(effectiveTtsProvider)) return
    if (!payload?.text) return   // wait until book is loaded
    api.post('/api/providers/warmup', { provider: effectiveTtsProvider, voice: effectiveTtsVoice ?? null, model: null })
      .catch(() => { /* silent — warmup is best-effort */ })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveTtsProvider, effectiveTtsVoice, Boolean(payload?.text)])

  // Kokoro presynthesis — pre-generate the entire book's audio in the background
  // so that tapping any word is an instant cache hit. Re-triggers when voice changes.
  useEffect(() => {
    if (effectiveTtsProvider !== 'kokoro' || !bookId || !payload?.text) return

    presynthGridRef.current = null
    if (presynthPollRef.current) clearTimeout(presynthPollRef.current)

    const { lengthScale, sentenceSilence } = pacingFor(effectiveTtsProvider)
    api.post<{ jobId: string; total: number; chunks: Array<{ start: number; end: number }> }>(
      `/api/books/${bookId}/presynthesize`,
      { provider: 'kokoro', voice: effectiveTtsVoice ?? null, length_scale: lengthScale, sentence_silence: sentenceSilence },
    ).then((res) => {
      presynthGridRef.current = res.chunks
      setPresynthJobId(res.jobId)
      setPresynthProgress({ completed: 0, total: res.total })
    }).catch(() => { /* silent — presynthesis is best-effort */ })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveTtsProvider, effectiveTtsVoice, bookId, Boolean(payload?.text)])

  // Poll presynthesis progress until done
  useEffect(() => {
    if (!presynthJobId || !bookId) return
    const poll = () => {
      api.get<{ status: string; completed: number; total: number }>(
        `/api/books/${bookId}/presynthesize/status?jobId=${presynthJobId}`,
      ).then((res) => {
        setPresynthProgress({ completed: res.completed, total: res.total })
        if (res.status !== 'done' && res.status !== 'error') {
          presynthPollRef.current = setTimeout(poll, 3000)
        }
      }).catch(() => { /* silent */ })
    }
    presynthPollRef.current = setTimeout(poll, 3000)
    return () => { if (presynthPollRef.current) clearTimeout(presynthPollRef.current) }
  }, [presynthJobId, bookId])

  // Read-ahead prefetch — fires chunk-aligned live-audio requests after the user stops
  // scrolling (2 s debounce). Cache keys match exactly what the player will request,
  // so hitting play is often instant if you've been reading for a couple seconds.
  const prefetchRef   = useRef<AbortController | null>(null)
  const prefetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!isChunking(effectiveTtsProvider) || !bookId || !payload?.text) return

    // Debounce: cancel previous timer on every scroll update
    if (prefetchTimer.current) clearTimeout(prefetchTimer.current)
    prefetchTimer.current = setTimeout(() => {
      prefetchRef.current?.abort()
      const ctrl = new AbortController()
      prefetchRef.current = ctrl

      const { lengthScale, sentenceSilence } = pacingFor(effectiveTtsProvider)
      const start = audioSliceStart(payload.text.length, scrollPct)
      const fullSlice = payload.text.slice(start, start + AUDIO_SLICE_CHARS)
      if (!fullSlice.trim()) return

      const chunkDefs = buildAudioChunks(
        fullSlice,
        start,
        CHUNK_CHARS[effectiveTtsProvider] ?? DEFAULT_AUDIO_CHARS,
        FIRST_AUDIO_CHARS[effectiveTtsProvider] ?? DEFAULT_FIRST_AUDIO_CHARS,
      ).slice(0, PREFETCH_CHUNK_LIMIT)
      if (chunkDefs.length === 0) return

      // Prefetch chunks in parallel — by the time the user hits play they're all cached
      void Promise.all(chunkDefs.map((chunk) =>
        requestLiveAudio(bookId, {
          provider: effectiveTtsProvider,
          voice: effectiveTtsVoice,
          model: null,
          output_format: 'mp3',
          narration_style: '',
          length_scale: lengthScale,
          sentence_silence: sentenceSilence,
          pageNumber: 1,
          start: chunk.start,
          end: chunk.end,
          text: chunk.text,
        }).catch(() => null)
      ))
    }, 1200)  // 1.2 s after last scroll event — quicker warm-up

    return () => {
      if (prefetchTimer.current) clearTimeout(prefetchTimer.current)
    }
  }, [effectiveTtsProvider, effectiveTtsVoice, bookId, payload?.text, scrollPct])

  function patchAppearance(patch: Partial<Appearance>) {
    setAppearance(a => ({ ...a, ...patch }))
  }

  function saveProgress(pct: number) {
    if (!payload?.text || !bookId) return
    const textLength = payload.text.length
    const textStart  = Math.round(pct * textLength)
    const reading: ReadingProgress = {
      pageNumber: Math.max(1, Math.round(pct * 100)),
      totalPages: 100,
      textStart,
      textEnd: Math.min(textLength, textStart + 2200),
      textLength,
      updatedAt: new Date().toISOString(),
    }
    try {
      const map = JSON.parse(localStorage.getItem(PROGRESS_KEY) ?? '{}')
      map[bookId] = { pageNumber: reading.pageNumber, totalPages: reading.totalPages, updatedAt: reading.updatedAt }
      localStorage.setItem(PROGRESS_KEY, JSON.stringify(map))
    } catch { /* swallow */ }

    queryClient.setQueryData<ProgressPayload>(['progress', bookId], (current) => ({
      ...(current ?? {}),
      reading,
    }))
    queryClient.setQueryData<Array<{ id: string; readingProgress?: ReadingProgress | null }>>(
      ['books'],
      (current) => current?.map((book) => (
        book.id === bookId ? { ...book, readingProgress: reading } : book
      )),
    )

    api.put<ReadingProgress>(`/api/books/${bookId}/progress/reading`, reading)
      .then((saved) => {
        queryClient.setQueryData<ProgressPayload>(['progress', bookId], (current) => ({
          ...(current ?? {}),
          reading: saved,
        }))
      })
      .catch(() => {})
  }

  // Scroll tracking
  useEffect(() => {
    function onScroll() {
      const y   = window.scrollY
      const max = document.documentElement.scrollHeight - window.innerHeight
      const pct = max > 0 ? Math.min(1, y / max) : 0
      latestScrollPct.current = pct
      setScrollPct(pct)
      const activeCueRange = activeAudioCueRangeRef.current
      if (activeCueRange) {
        showAudioFollow(
          activeCueRange.start,
          activeCueRange.end,
          Boolean(
            (wordAudioCtxRef.current?.state === 'running') ||
            (wordAudioRef.current && !wordAudioRef.current.paused),
          ),
        )
      }
      const goingDown = y > lastScrollY.current && y > 60
      setBarVisible(!goingDown)
      lastScrollY.current = y
      if (scrollTimer.current) clearTimeout(scrollTimer.current)
      scrollTimer.current = setTimeout(() => setBarVisible(true), 1500)
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => saveProgress(pct), 4000)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload?.text])

  useEffect(() => {
    function flushProgress() {
      saveProgress(latestScrollPct.current)
    }
    function onVisibilityChange() {
      if (document.visibilityState === 'hidden') flushProgress()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      flushProgress()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload?.text, bookId])

  // Build SelectionState from the actual DOM range when available; text search is only a fallback.
  function buildState(
    text: string,
    rect: DOMRect,
    mode: 'word' | 'sentence',
    located?: LocatedSelection | null,
    rects: SelectionRect[] = [toSelectionRect(rect)],
  ): SelectionState {
    const selectedText = located?.text ?? text
    const startOffset = located?.startOffset ?? findTextOffset(selectedText, payload?.text ?? '', scrollPct)
    const endOffset = located?.endOffset ?? startOffset + selectedText.length
    return {
      viewportX: rect.left + rect.width / 2,
      viewportY: rect.top,
      selHeight: rect.height,
      selLeft: rect.left,
      selWidth: rect.width,
      rects,
      text: selectedText, mode, startOffset,
      endOffset,
    }
  }

  function buildStateFromRange(
    range: Range,
    mode: 'word' | 'sentence',
    fallbackText?: string,
  ): SelectionState | null {
    const rect = range.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) return null

    const located = readerTextRef.current && payload?.text
      ? locateSelectionRange(range, readerTextRef.current, payload.text)
      : null
    const text = located?.text ?? (fallbackText ?? range.toString()).trim()
    if (!text) return null

    return buildState(text, rect, mode, located, selectionRectsFromRange(range, rect))
  }

  // ── Event handlers ──────────────────────────────────────────────────────────

  const handleMouseUp = useCallback((_ev: React.MouseEvent<HTMLDivElement>) => {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return
    try {
      const range = sel.getRangeAt(0)
      const state = buildStateFromRange(range, 'sentence')
      if (!state) return
      const wc = state.text.split(/\s+/).filter(Boolean).length
      if (wc < 2) return // single click handled by onClick
      justShowedMenu.current = true
      // Clear native selection immediately → suppresses browser's selection toolbar
      sel.removeAllRanges()
      setSelection(state)
    } catch { /* swallow */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload?.text, scrollPct])

  const handleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (justShowedMenu.current) { justShowedMenu.current = false; return }

    if (selection) {
      setSelection(null)
      window.getSelection()?.removeAllRanges()
      return
    }

    // Single click → expand to word
    const word = getWordAtPoint(e.clientX, e.clientY)
    if (!word) return

    // Do NOT add to native selection → no browser selection toolbar appears
    // We show our own highlight overlay instead
    window.getSelection()?.removeAllRanges()

    const state = buildStateFromRange(word.range, 'word', word.text)
    if (!state) return

    setSelection(state)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, payload?.text, scrollPct])

  // ── Mobile drag-to-select ─────────────────────────────────────────────────
  // Touch a word and slide your finger across the sentence to grow the
  // selection word-by-word. Vertical drags fall through to native scroll.
  const dragRef = useRef<{
    startRange: Range | null
    startX: number
    startY: number
    mode: 'idle' | 'deciding' | 'selecting' | 'scrolling'
  }>({ startRange: null, startX: 0, startY: 0, mode: 'idle' })
  const [isDragSelecting, setIsDragSelecting] = useState(false)

  const handleTouchStart = useCallback((ev: React.TouchEvent<HTMLDivElement>) => {
    if (ev.touches.length !== 1) {
      dragRef.current = { startRange: null, startX: 0, startY: 0, mode: 'idle' }
      return
    }
    const t = ev.touches[0]
    const w = getWordAtPoint(t.clientX, t.clientY)
    if (!w) {
      dragRef.current = { startRange: null, startX: 0, startY: 0, mode: 'idle' }
      return
    }
    dragRef.current = {
      startRange: w.range,
      startX: t.clientX,
      startY: t.clientY,
      mode: 'deciding',
    }
  }, [])

  const handleTouchEnd = useCallback((_ev: React.TouchEvent<HTMLDivElement>) => {
    const r = dragRef.current
    if (r.mode === 'selecting') {
      // Selection state is already up-to-date from the last touchmove.
      // Mark so the trailing click event doesn't reset it.
      justShowedMenu.current = true
      setIsDragSelecting(false)
    }
    dragRef.current = { startRange: null, startX: 0, startY: 0, mode: 'idle' }
  }, [])

  // Non-passive touchmove — required so we can preventDefault to suppress page
  // scroll while the user is sweeping across a sentence.
  useEffect(() => {
    const el = readerTextRef.current
    if (!el) return

    const onMove = (e: TouchEvent) => {
      const r = dragRef.current
      if (!r.startRange || e.touches.length !== 1) return
      const t = e.touches[0]
      const dx = t.clientX - r.startX
      const dy = t.clientY - r.startY

      if (r.mode === 'deciding') {
        const dist = Math.hypot(dx, dy)
        if (dist < 8) return
        // If the gesture is mostly vertical, defer to scroll
        if (Math.abs(dy) > Math.abs(dx) * 1.4 && Math.abs(dy) > 12) {
          r.mode = 'scrolling'
          return
        }
        r.mode = 'selecting'
        setIsDragSelecting(true)
      }

      if (r.mode === 'selecting') {
        e.preventDefault()
        const cur = getWordAtPoint(t.clientX, t.clientY)
        if (!cur) return

        const combined = document.createRange()
        try {
          const cmp = r.startRange.compareBoundaryPoints(Range.START_TO_START, cur.range)
          if (cmp <= 0) {
            combined.setStart(r.startRange.startContainer, r.startRange.startOffset)
            combined.setEnd(cur.range.endContainer, cur.range.endOffset)
          } else {
            combined.setStart(cur.range.startContainer, cur.range.startOffset)
            combined.setEnd(r.startRange.endContainer, r.startRange.endOffset)
          }
        } catch { return }

        const text = combined.toString().trim()
        const wc = text.split(/\s+/).filter(Boolean).length
        const state = buildStateFromRange(combined, wc > 1 ? 'sentence' : 'word')
        if (state) setSelection(state)
        // Suppress native browser selection — we draw our own overlay
        window.getSelection()?.removeAllRanges()
      }
    }

    el.addEventListener('touchmove', onMove, { passive: false })
    return () => el.removeEventListener('touchmove', onMove)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload?.text, scrollPct])

  // ── Play word ─────────────────────────────────────────────────────────────

  function clearWordAudioObjectUrls() {
    for (const url of wordAudioObjectUrlsRef.current) URL.revokeObjectURL(url)
    wordAudioObjectUrlsRef.current.clear()
  }

  function getWordAudioCtx(): AudioContext {
    if (!wordAudioCtxRef.current || wordAudioCtxRef.current.state === 'closed') {
      wordAudioCtxRef.current = new AudioContext()
      wordAudioScheduledEndRef.current = 0
    }
    return wordAudioCtxRef.current
  }

  function stopWordAudioCueRAF() {
    if (wordAudioRafRef.current !== null) {
      cancelAnimationFrame(wordAudioRafRef.current)
      wordAudioRafRef.current = null
    }
  }

  function startWordAudioCueRAF() {
    stopWordAudioCueRAF()
    const ctx = wordAudioCtxRef.current
    if (!ctx) return
    const chunkStart = wordAudioChunkStartRef.current
    const curIdx = wordAudioCurIdxRef.current
    const seekOffset = wordAudioChunkSeekRef.current
    const tick = () => {
      if (wordAudioAbortRef.current?.signal.aborted) return
      const chunk = wordAudioChunksRef.current[curIdx]
      if (chunk) syncAudioFollowCue(chunk, Math.max(0, ctx.currentTime - chunkStart) + seekOffset, false)
      wordAudioRafRef.current = requestAnimationFrame(tick)
    }
    wordAudioRafRef.current = requestAnimationFrame(tick)
  }

  function updateWordAudioChunk(idx: number, patch: Partial<AudioChunk>) {
    const next = [...wordAudioChunksRef.current]
    if (next[idx]) next[idx] = { ...next[idx], ...patch }
    wordAudioChunksRef.current = next
  }

  function clearAudioFollow() {
    activeAudioCueKeyRef.current = null
    activeAudioCueRangeRef.current = null
    setAudioFollowRects([])
  }

  function showAudioFollow(startOffset: number, endOffset: number, follow: boolean) {
    const root = readerTextRef.current
    if (!root) {
      setAudioFollowRects([])
      return
    }

    const range = domRangeForSourceOffsets(startOffset, endOffset, root)
    if (!range) {
      setAudioFollowRects([])
      return
    }

    const fallbackRect = range.getBoundingClientRect()
    if (fallbackRect.width === 0 && fallbackRect.height === 0) {
      setAudioFollowRects([])
      return
    }

    const rects = selectionRectsFromRange(range, fallbackRect)
    setAudioFollowRects(rects)

    if (!follow || rects.length === 0) return

    const top = Math.min(...rects.map((rect) => rect.top))
    const bottom = Math.max(...rects.map((rect) => rect.top + rect.height))
    const safeTop = window.innerHeight * 0.22
    const safeBottom = window.innerHeight * 0.72
    if (top >= safeTop && bottom <= safeBottom) return

    const centerY = (top + bottom) / 2
    const targetY = window.innerHeight * 0.42
    const delta = centerY - targetY
    if (Math.abs(delta) < 12) return

    window.scrollBy({ top: delta, behavior: 'smooth' })
  }

  function syncAudioFollowCue(chunk: AudioChunk, currentTime: number, follow: boolean) {
    const cues = (chunk.cues ?? []).filter((cue) => cue.end > cue.start)
    const activeCue = cues.find((cue, index) => {
      const cueStart = Math.max(0, cue.timeStart)
      const cueEnd = Math.max(cueStart, cue.timeEnd)
      const isLastCue = index === cues.length - 1
      return currentTime >= cueStart && (currentTime < cueEnd || (isLastCue && currentTime <= cueEnd + 0.2))
    }) ?? (cues.length
      ? (currentTime < cues[0].timeStart ? cues[0] : cues[cues.length - 1])
      : null)

    const startOffset = activeCue?.start ?? chunk.start
    const endOffset = activeCue?.end ?? chunk.end
    const nextKey = `${startOffset}:${endOffset}`

    activeAudioCueRangeRef.current = { start: startOffset, end: endOffset }
    if (activeAudioCueKeyRef.current === nextKey) return

    activeAudioCueKeyRef.current = nextKey
    showAudioFollow(startOffset, endOffset, follow)
  }

  async function fetchWordAudioChunk(idx: number, chunk: AudioChunk, signal: AbortSignal): Promise<string | null> {
    const existingChunk = wordAudioChunksRef.current[idx]
    if (existingChunk?.url) return existingChunk.url
    const existingFetch = wordAudioChunkFetchesRef.current.get(idx)
    if (existingFetch) return existingFetch

    updateWordAudioChunk(idx, { status: 'fetching' })
    const fetchPromise = (async () => {
      try {
        const { lengthScale, sentenceSilence } = pacingFor(effectiveTtsProvider)
        const { url, cues } = await requestLiveAudio(bookId!, {
          provider: effectiveTtsProvider,
          voice: effectiveTtsVoice,
          model: null,
          output_format: 'mp3',
          narration_style: '',
          length_scale: lengthScale,
          sentence_silence: sentenceSilence,
          pageNumber: 1,
          start: chunk.start,
          end: chunk.end,
          text: chunk.text,
        })
        if (signal.aborted) return null

        // Download bytes once, create blob URL + decode for Web Audio gapless playback
        const blob = needsAuthenticatedAudioFetch(url)
          ? await requestBlob(url, { signal })
          : await fetch(url, { signal }).then(r => r.blob())
        if (signal.aborted) return null

        const blobUrl = URL.createObjectURL(blob)
        wordAudioObjectUrlsRef.current.add(blobUrl)

        let buffer: AudioBuffer | null = null
        try {
          const ctx = wordAudioCtxRef.current
          if (ctx && ctx.state !== 'closed') {
            buffer = await ctx.decodeAudioData(await blob.arrayBuffer())
          }
        } catch { /* decode failure: fallback to HTMLAudio */ }

        if (signal.aborted) return null
        updateWordAudioChunk(idx, { status: 'ready', url: blobUrl, buffer, cues: cues ?? [] })
        prefetchWordAudioAhead(wordAudioCurIdxRef.current, wordAudioChunksRef.current, signal)
        return blobUrl
      } catch (error) {
        if ((error as Error).name !== 'AbortError') {
          setWordAudio(null)
          showToast(audioErrorMessage(error))
          updateWordAudioChunk(idx, { status: 'error' })
        }
        return null
      } finally {
        wordAudioChunkFetchesRef.current.delete(idx)
      }
    })()

    wordAudioChunkFetchesRef.current.set(idx, fetchPromise)
    return fetchPromise
  }

  function prefetchWordAudioAhead(fromIdx: number, currentChunks: AudioChunk[], signal: AbortSignal) {
    if (signal.aborted) return
    const target = PREFETCH_AHEAD_TARGET[effectiveTtsProvider] ?? DEFAULT_PREFETCH_AHEAD
    // Fire any idle chunks within the target rolling window in parallel
    for (let offset = 1; offset <= target; offset += 1) {
      const idx = fromIdx + offset
      const chunk = currentChunks[idx]
      if (!chunk) break
      if (chunk.url || chunk.status === 'fetching') continue
      if (chunk.status === 'idle') {
        void fetchWordAudioChunk(idx, chunk, signal)
      }
    }
  }

  function stopWordAudio() {
    stopWordAudioCueRAF()
    wordAudioAbortRef.current?.abort()
    wordAudioAbortRef.current = null
    // Stop Web Audio source
    try {
      if (wordAudioSourceRef.current) {
        wordAudioSourceRef.current.onended = null
        wordAudioSourceRef.current.stop(0)
        wordAudioSourceRef.current.disconnect()
      }
    } catch { /* already stopped */ }
    wordAudioSourceRef.current = null
    wordAudioScheduledEndRef.current = 0
    wordAudioChunkStartRef.current = 0
    wordAudioChunkSeekRef.current = 0
    if (wordAudioCtxRef.current?.state === 'suspended') void wordAudioCtxRef.current.resume()
    wordAudioRef.current?.pause()
    wordAudioRef.current = null
    wordAudioCurIdxRef.current = 0
    wordAudioChunksRef.current = []
    wordAudioChunkFetchesRef.current.clear()
    clearWordAudioObjectUrls()
    clearAudioFollow()
    setWordAudioCurIdx(0)
    setWordAudioTotal(0)
    setWordAudio(null)
  }

  async function continueWordAudioPlayback(nextIdx: number, ctrl: AbortController, word: string) {
    const latest = wordAudioChunksRef.current
    if (nextIdx >= latest.length) {
      stopWordAudio()
      return
    }

    const nextChunk = latest[nextIdx]
    if (nextChunk.url) {
      playWordAudioChunkAt(nextIdx, latest, ctrl, word)
      return
    }

    setWordAudio({ word, status: 'loading' })
    const url = await fetchWordAudioChunk(nextIdx, nextChunk, ctrl.signal)
    if (ctrl.signal.aborted) return
    if (!url) {
      stopWordAudio()
      return
    }
    playWordAudioChunkAt(nextIdx, wordAudioChunksRef.current, ctrl, word)
  }

  function playWordAudioChunkAt(idx: number, currentChunks: AudioChunk[], ctrl: AbortController, word: string) {
    const chunk = currentChunks[idx]
    if (!chunk?.url) return

    stopWordAudioCueRAF()
    wordAudioCurIdxRef.current = idx
    setWordAudioCurIdx(idx)
    setWordAudio({ word, status: 'playing' })
    prefetchWordAudioAhead(idx, currentChunks, ctrl.signal)

    const ctx = wordAudioCtxRef.current
    if (ctx && ctx.state !== 'closed' && chunk.buffer) {
      // ── Web Audio path — gapless scheduling ─────────────────────────
      if (ctx.state === 'suspended') void ctx.resume()

      // Disconnect previous source without stopping scheduled future buffers
      try {
        if (wordAudioSourceRef.current) {
          wordAudioSourceRef.current.onended = null
          wordAudioSourceRef.current.disconnect()
        }
      } catch { /* ignore */ }
      wordAudioRef.current?.pause()
      wordAudioRef.current = null

      const source = ctx.createBufferSource()
      source.buffer = chunk.buffer
      source.connect(ctx.destination)
      wordAudioSourceRef.current = source

      // Seek into first chunk when playing from a grid chunk that starts before the tap word
      let seekSec = 0
      if (chunk.tapOffset != null && chunk.tapOffset > chunk.start && chunk.cues?.length) {
        const seekCue = chunk.cues.find(c => c.start >= chunk.tapOffset!)
        if (seekCue) seekSec = seekCue.timeStart
      }
      wordAudioChunkSeekRef.current = seekSec

      const now = ctx.currentTime
      const startAt = Math.max(now + 0.002, wordAudioScheduledEndRef.current)
      source.start(startAt, seekSec > 0 ? seekSec : undefined)
      wordAudioScheduledEndRef.current = startAt + chunk.buffer.duration - seekSec
      wordAudioChunkStartRef.current = startAt
      syncAudioFollowCue(chunk, seekSec, true)
      startWordAudioCueRAF()

      source.onended = () => {
        if (ctrl.signal.aborted) return
        stopWordAudioCueRAF()
        void continueWordAudioPlayback(idx + 1, ctrl, word)
      }
    } else {
      // ── HTMLAudio fallback ────────────────────────────────────────────
      wordAudioRef.current?.pause()
      const audio = new Audio(chunk.url)
      wordAudioRef.current = audio
      syncAudioFollowCue(chunk, 0, true)

      audio.play().catch(() => {
        if (ctrl.signal.aborted) return
        setWordAudio({ word, status: 'ready' })
        showToast('Audio is ready. Tap the banner play button.')
      })

      audio.ontimeupdate = () => {
        if (ctrl.signal.aborted) return
        syncAudioFollowCue(chunk, audio.currentTime, true)
      }
      audio.onended = () => {
        if (ctrl.signal.aborted) return
        void continueWordAudioPlayback(idx + 1, ctrl, word)
      }
      audio.onerror = () => {
        if (ctrl.signal.aborted) return
        showToast('Audio playback failed. Try starting it again.')
        stopWordAudio()
      }
    }
  }

  async function playWord(word: string, startOffset: number) {
    stopWordAudio()
    // Create + unlock AudioContext here — must be in a user-gesture call stack (iOS Safari)
    const audioCtx = getWordAudioCtx()
    void audioCtx.resume()
    setWordAudio({ word, status: 'loading' })
    const fullText = payload?.text ?? ''
    const start = Math.max(0, Math.min(startOffset, fullText.length))

    let initial: AudioChunk[]
    const grid = effectiveTtsProvider === 'kokoro' ? presynthGridRef.current : null
    if (grid && grid.length > 0) {
      // Use the pre-computed word-boundary grid so every chunk is a cache hit
      const chunkIdx = findGridChunk(grid, start)
      // Load up to 50 grid chunks (covers ~21 KB of text) so playback never stalls
      const window_ = grid.slice(chunkIdx, chunkIdx + 50)
      initial = window_.map((g, i) => ({
        start: g.start,
        end: g.end,
        text: fullText.slice(g.start, g.end),
        url: null,
        buffer: null,
        status: 'idle' as ChunkStatus,
        // First chunk may start before the tap word; store tap position for seek
        tapOffset: i === 0 && g.start < start ? start : undefined,
      }))
    } else {
      const end = Math.min(fullText.length, start + AUDIO_SLICE_CHARS)
      const snippet = fullText.slice(start, end)
      if (!snippet.trim()) {
        setWordAudio(null)
        showToast('There is no readable text at this position.')
        return
      }
      const chunkSize = CHUNK_CHARS[effectiveTtsProvider] ?? DEFAULT_AUDIO_CHARS
      const firstChunkSize = FIRST_AUDIO_CHARS[effectiveTtsProvider] ?? DEFAULT_FIRST_AUDIO_CHARS
      const raw = buildAudioChunks(snippet, start, chunkSize, firstChunkSize)
      initial = raw.map((chunk) => ({ ...chunk, url: null, buffer: null, status: 'idle' as ChunkStatus }))
    }
    if (!initial.length) {
      setWordAudio(null)
      showToast('There is no readable text at this position.')
      return
    }

    wordAudioChunksRef.current = initial
    wordAudioCurIdxRef.current = 0
    setWordAudioCurIdx(0)
    setWordAudioTotal(initial.length)
    const ctrl = new AbortController()
    wordAudioAbortRef.current = ctrl

    const startReadyChunkCount = Math.min(
      initial.length,
      START_PLAYBACK_READY_CHUNKS[effectiveTtsProvider] ?? 1,
    )
    const bootstrapCount = Math.min(
      initial.length,
      Math.max(PLAYBACK_BOOTSTRAP_CHUNKS[effectiveTtsProvider] ?? 1, startReadyChunkCount),
    )
    for (let idx = 0; idx < bootstrapCount; idx += 1) {
      void fetchWordAudioChunk(idx, initial[idx], ctrl.signal)
    }

    try {
      const startupReady = await Promise.all(
        initial.slice(0, startReadyChunkCount).map((chunk, idx) => fetchWordAudioChunk(idx, chunk, ctrl.signal)),
      )
      if (ctrl.signal.aborted || startupReady.some((url) => !url)) {
        stopWordAudio()
        return
      }
      playWordAudioChunkAt(0, wordAudioChunksRef.current, ctrl, word)
    } catch (error) {
      stopWordAudio()
      showToast(audioErrorMessage(error))
    }
  }

  function resumeWordAudio() {
    if (!wordAudio) return
    const ctx = wordAudioCtxRef.current
    if (ctx && ctx.state === 'suspended') {
      void ctx.resume().then(() => {
        setWordAudio({ word: wordAudio.word, status: 'playing' })
        startWordAudioCueRAF()
      })
      return
    }
    const audio = wordAudioRef.current
    if (!audio) return
    audio.play()
      .then(() => setWordAudio({ word: wordAudio.word, status: 'playing' }))
      .catch(() => showToast('Playback was blocked by the browser. Tap play again.'))
  }

  function toggleWordAudio() {
    if (!wordAudio) return
    if (wordAudio.status === 'loading') return
    if (wordAudio.status === 'playing') {
      const ctx = wordAudioCtxRef.current
      if (ctx && ctx.state === 'running') {
        stopWordAudioCueRAF()
        void ctx.suspend().then(() => setWordAudio({ word: wordAudio.word, status: 'ready' }))
        return
      }
      wordAudioRef.current?.pause()
      setWordAudio({ word: wordAudio.word, status: 'ready' })
      return
    }
    resumeWordAudio()
  }

  useEffect(() => () => {
    stopWordAudioCueRAF()
    wordAudioAbortRef.current?.abort()
    try { wordAudioSourceRef.current?.stop(0); wordAudioSourceRef.current?.disconnect() } catch { /* already stopped */ }
    wordAudioSourceRef.current = null
    wordAudioCtxRef.current?.close().catch(() => {})
    wordAudioCtxRef.current = null
    wordAudioRef.current?.pause()
    wordAudioChunkFetchesRef.current.clear()
    activeAudioCueKeyRef.current = null
    activeAudioCueRangeRef.current = null
    for (const url of wordAudioObjectUrlsRef.current) URL.revokeObjectURL(url)
    wordAudioObjectUrlsRef.current.clear()
  }, [])

  // ── Derived ───────────────────────────────────────────────────────────────

  const colors     = THEMES[appearance.theme]
  const fontFamily = appearance.font === 'serif'
    ? 'Lora, Georgia, serif'
    : '"Inter Variable", Inter, system-ui, sans-serif'
  const paragraphs = useMemo(
    () => buildReaderParagraphs(payload?.text ?? ''),
    [payload?.text],
  )
  const readPct = Math.round(scrollPct * 100)
  const activePlayBarPhase = wordAudioPhase
  const activePlayBarCurIdx = wordAudioCurIdx
  const activePlayBarTotal = wordAudioTotal
  const activePlayBarHandle = wordAudioPhase !== 'idle'
    ? { toggle: toggleWordAudio, stop: stopWordAudio }
    : null

  return (
    <div
      className="min-h-svh"
      style={{ backgroundColor: colors.bg, color: colors.text }}
    >
      {/* ── Top bar (floating pill) ───────────────────────────────── */}
      <header
        className="fixed z-40 flex items-center px-2.5 h-12"
        style={{
          top: 16,
          left: '50%',
          width: 'min(560px, calc(100vw - 32px))',
          borderRadius: 14,
          backgroundColor: colors.bar,
          backdropFilter: 'blur(14px)',
          WebkitBackdropFilter: 'blur(14px)',
          border: `1px solid ${colors.text}0f`,
          boxShadow: '0 2px 12px rgba(0,0,0,0.06)',
          opacity: barVisible ? 1 : 0,
          transform: barVisible
            ? 'translateX(-50%) translateY(0)'
            : 'translateX(-50%) translateY(-14px)',
          transition: 'opacity 200ms, transform 200ms',
          pointerEvents: barVisible ? 'auto' : 'none',
        }}
      >
        <Link to="/library"
          className="flex items-center justify-center w-9 h-9 rounded-lg hover:opacity-55 transition-opacity shrink-0"
          style={{ color: colors.text }}
          aria-label="Back to Library"
        >
          <ArrowLeft size={18} />
        </Link>

        <div className="flex-1 text-center px-2 min-w-0">
          <p
            className="text-[12.5px] truncate"
            style={{ color: `${colors.text}99`, fontFamily: '"Inter", system-ui, sans-serif' }}
          >
            {payload?.book.title ?? ''}
          </p>
        </div>

        <div className="flex items-center shrink-0">
          <button
            onClick={() => setSheet(s => s === 'chat' ? 'none' : 'chat')}
            className="flex items-center justify-center w-9 h-9 rounded-lg hover:opacity-55 transition-opacity"
            style={{ color: sheet === 'chat' ? '#2383e2' : colors.text }}
            aria-label="Assistant"
          >
            <MessageSquare size={16} />
          </button>
          <button
            onClick={() => setSheet(s => s === 'audio' ? 'none' : 'audio')}
            className="flex items-center justify-center w-9 h-9 rounded-lg hover:opacity-55 transition-opacity"
            style={{ color: colors.text }}
            aria-label="Audio"
          >
            <Volume2 size={16} />
          </button>
          <button
            onClick={() => setSheet(s => s === 'appearance' ? 'none' : 'appearance')}
            className="flex items-center justify-center w-9 h-9 rounded-lg hover:opacity-55 transition-opacity"
            style={{ color: colors.text }}
            aria-label="Appearance"
          >
            <Settings2 size={16} />
          </button>
        </div>
      </header>

      {audioFollowRects.map((rect, index) => (
        <div
          key={`audio-follow-${Math.round(rect.top)}-${Math.round(rect.left)}-${index}`}
          className="fixed pointer-events-none z-[54] rounded-[4px]"
          style={{
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
            backgroundColor: 'rgba(59, 130, 246, 0.18)',
            boxShadow: 'inset 0 0 0 1px rgba(59, 130, 246, 0.30)',
            transition: 'left 140ms linear, top 140ms linear, width 140ms linear, height 140ms linear',
          }}
        />
      ))}

      {/* ── Custom word highlight overlay (replaces browser selection highlight) ── */}
      {selection?.rects.map((rect, index) => (
        <div
          key={`${Math.round(rect.top)}-${Math.round(rect.left)}-${index}`}
          data-reader-selection-preview="true"
          className="fixed pointer-events-none z-[55] rounded-[3px]"
          style={{
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
            backgroundColor: 'rgba(251, 191, 36, 0.38)',
          }}
        />
      ))}

      {/* ── Scrollable text ───────────────────────────────────────────── */}
      <div
        className="mx-auto px-5 pt-20 pb-36 transition-all duration-200"
        style={{
          maxWidth: `${WIDTH_PX[appearance.width]}px`,
          WebkitTouchCallout: 'none',  // suppress iOS long-press callout
        }}
        onMouseUp={handleMouseUp}
        onClick={handleClick}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        onContextMenu={(e) => e.preventDefault()}
      >
        {isLoading ? (
          <div className="pt-12 space-y-3 animate-pulse">
            {Array.from({ length: 22 }).map((_, i) => (
              <div key={i} className="h-4 rounded"
                style={{ backgroundColor: `${colors.text}12`, width: i % 6 === 5 ? '55%' : '100%' }} />
            ))}
          </div>
        ) : (
          <div ref={readerTextRef} style={{ fontFamily, fontSize: `${appearance.fontSize}px`, lineHeight: appearance.lineHeight, textAlign: appearance.align, color: colors.text }}>
            {paragraphs.map((p, i) => (
              <p
                key={`${p.startOffset}-${i}`}
                className="mb-[1.4em]"
                data-reader-paragraph-start={p.startOffset}
              >
                {p.text}
              </p>
            ))}
          </div>
        )}
      </div>

      {/* ── Bottom progress bar (floating pill) ─────────────────────── */}
      <div
        className="fixed z-40 flex items-center gap-2.5 px-3"
        style={{
          bottom: 18,
          left: '50%',
          height: 44,
          width: 'min(420px, calc(100vw - 32px))',
          borderRadius: 999,
          backgroundColor: colors.bar,
          backdropFilter: 'blur(14px)',
          WebkitBackdropFilter: 'blur(14px)',
          border: `1px solid ${colors.text}0f`,
          boxShadow: '0 4px 14px rgba(0,0,0,0.08)',
          opacity: barVisible && activePlayBarPhase === 'idle' ? 1 : 0,
          transform: barVisible && activePlayBarPhase === 'idle'
            ? 'translateX(-50%) translateY(0)'
            : 'translateX(-50%) translateY(10px)',
          transition: 'opacity 200ms, transform 200ms',
          pointerEvents: barVisible && activePlayBarPhase === 'idle' ? 'auto' : 'none',
        }}
      >
        <button
          onClick={() => window.scrollBy({ top: -Math.round(window.innerHeight * 0.8), behavior: 'smooth' })}
          className="flex items-center justify-center w-8 h-8 rounded-full shrink-0 hover:opacity-55 transition-opacity"
          style={{ color: colors.text }}
          aria-label="Scroll up"
        >
          <ChevronLeft size={16} />
        </button>

        <div
          className="flex-1 h-[3px] rounded-full"
          style={{ background: `${colors.text}18` }}
        >
          <div
            className="h-full rounded-full transition-all duration-300"
            style={{ width: `${readPct}%`, background: colors.text }}
          />
        </div>

        <span
          className="text-[11px] shrink-0 tabular-nums"
          style={{ color: `${colors.text}80`, fontFamily: '"Inter", system-ui, sans-serif' }}
        >
          {readPct}%
        </span>

        <button
          onClick={() => window.scrollBy({ top: Math.round(window.innerHeight * 0.8), behavior: 'smooth' })}
          className="flex items-center justify-center w-8 h-8 rounded-full shrink-0 hover:opacity-55 transition-opacity"
          style={{ color: colors.text }}
          aria-label="Scroll down"
        >
          <ChevronRight size={16} />
        </button>
      </div>

      {/* ── Selection menu ────────────────────────────────────────────── */}
      <AnimatePresence>
        {selection && !isDragSelecting && (
          <SelectionMenu
            sel={selection}
            bookId={bookId!}
            fullText={payload?.text ?? ''}
            ttsProvider={ttsProvider}
            onClose={() => { setSelection(null); window.getSelection()?.removeAllRanges() }}
            onOpenPanel={openPanel}
            onToast={showToast}
            onPlayWord={playWord}
          />
        )}
      </AnimatePresence>

      {/* ── Secondary panel (Dictionary / Notes / Ask AI) ─────────────── */}
      <BottomSheet
        open={panel !== null}
        onClose={closePanel}
        bg={colors.bg}
      >
        {(() => {
          const p = panel ?? panelSnapshotRef.current
          if (!p) return null
          if (p.kind === 'dictionary') return (
            <DictionaryPanel word={p.word} onClose={closePanel} colors={colors} />
          )
          if (p.kind === 'notes') return (
            <NotesPanel text={p.text} start={p.start} end={p.end}
              bookId={bookId!} onClose={closePanel} colors={colors} />
          )
          if (p.kind === 'askai') return (
            <AskAIPanel text={p.text} onClose={closePanel} colors={colors} />
          )
          if (p.kind === 'translate') return (
            <TranslatePanel text={p.text} onClose={closePanel} colors={colors} />
          )
          return null
        })()}
      </BottomSheet>

      {/* ── Assistant chat sheet ─────────────────────────────────────── */}
      {sheet === 'chat' && (() => {
        const ft = payload?.text ?? ''
        const mid = Math.floor(scrollPct * ft.length)
        const lo  = Math.max(0, mid - 1000)
        const hi  = Math.min(ft.length, mid + 1000)
        const ctx = ft.slice(lo, hi)
        return (
          <BottomSheet open onClose={() => setSheet('none')} bg={colors.bg}>
            <AssistantChat
              bookTitle={payload?.book.title ?? 'this book'}
              pageContext={ctx}
              onClose={() => setSheet('none')}
              colors={colors}
            />
          </BottomSheet>
        )
      })()}

      {/* ── Appearance sheet ──────────────────────────────────────────── */}
      <BottomSheet open={sheet === 'appearance'} onClose={() => setSheet('none')} bg={colors.bg}>
        <AppearanceContent
          appearance={appearance}
          onChange={patchAppearance}
          onClose={() => setSheet('none')}
        />
      </BottomSheet>

      {/* ── Audio sheet ───────────────────────────────────────────────── */}
      <BottomSheet open={sheet === 'audio'} onClose={() => setSheet('none')} bg={colors.bg}>
        <AudioContent
          onClose={() => setSheet('none')}
          colors={colors}
          provider={effectiveTtsProvider}
          onProviderChange={setTtsProvider}
          voice={effectiveTtsVoice}
          onVoiceChange={setTtsVoice}
          onError={showToast}
        />
      </BottomSheet>

      {/* ── Presynthesis progress (subtle, disappears when done) ─────── */}
      {presynthProgress && presynthProgress.completed < presynthProgress.total && (
        <div
          style={{
            position: 'fixed', bottom: 16, left: '50%', transform: 'translateX(-50%)',
            fontSize: 11, color: colors.text, opacity: 0.45, pointerEvents: 'none',
            zIndex: 40, whiteSpace: 'nowrap',
          }}
        >
          Preparing audio… {Math.round(presynthProgress.completed / presynthProgress.total * 100)}%
        </div>
      )}

      {/* ── Play bar (visible while audio is active) ──────────────────── */}
      <AnimatePresence>
        {activePlayBarPhase !== 'idle' && (
          <PlayBar
            phase={activePlayBarPhase}
            curIdx={activePlayBarCurIdx}
            totalChunks={activePlayBarTotal}
            voiceLabel={playBarVoiceLabel}
            colors={colors}
            handle={activePlayBarHandle}
            onOpenSheet={() => setSheet('audio')}
          />
        )}
      </AnimatePresence>

      {/* ── Toast ─────────────────────────────────────────────────────── */}
      <AnimatePresence>
        {toast && <Toast msg={toast} key={toast} />}
      </AnimatePresence>
    </div>
  )
}
