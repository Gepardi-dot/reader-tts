import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'framer-motion'
import {
  ArrowLeft, Settings2, Volume2, X,
  Play, Pause, SkipBack, SkipForward,
  Minus, Plus, AlignLeft, AlignCenter, AlignJustify,
  Copy, BookMarked, Globe, BookOpen, Mic, NotebookPen, Sparkles, Search,
} from 'lucide-react'
import { Slider } from '@/components/ui/slider'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api, request } from '@/shared/api/client'
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

// Characters per chunk for local/remote providers that benefit from splitting
const CHUNK_CHARS: Record<string, number> = {
  neutts_local: 520,
  kokoro:       900,  // Kokoro handles larger chunks well; fewer round-trips = faster
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
  { id: 'copy',  Icon: Copy,        label: 'Copy'    },
  { id: 'notes', Icon: NotebookPen, label: 'Notes'   },
  { id: 'askai', Icon: Sparkles,    label: 'Ask AI'  },
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

  const menuW = sel.mode === 'word' ? 300 : 210
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

// ── Dictionary Panel ──────────────────────────────────────────────────────────

function DictionaryPanel({ word: initialWord, onClose, colors }: {
  word: string; onClose: () => void; colors: typeof THEMES['paper']
}) {
  const [lookupWord, setLookupWord] = useState(initialWord)
  const [inputValue, setInputValue] = useState(initialWord)
  const [speaking,   setSpeaking]   = useState(false)

  // 1. Offline dictionary (backend)
  const { data: offlineData, isLoading: offlineLoading } = useQuery({
    queryKey: ['dictionary', lookupWord],
    queryFn: () => api.get<DictResponse>(`/api/dictionary/lookup?term=${encodeURIComponent(lookupWord)}`),
    staleTime: 5 * 60_000,
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
          <div className="px-5 pt-5 space-y-3 animate-pulse">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-full shrink-0" style={{ backgroundColor: `${colors.text}10` }} />
              <div className="space-y-2 flex-1">
                <div className="h-8 w-44 rounded-lg" style={{ backgroundColor: `${colors.text}12` }} />
                <div className="h-3 w-24 rounded" style={{ backgroundColor: `${colors.text}08` }} />
              </div>
            </div>
            <div className="h-3 w-16 rounded mt-2" style={{ backgroundColor: `${colors.text}08` }} />
            <div className="space-y-2 pt-1">
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
                <h2 className="text-[28px] font-normal leading-tight break-words"
                  style={{ fontFamily: 'Lora, Georgia, serif', color: colors.text }}>
                  {displayData.term}
                </h2>
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

function AskAIPanel({ text, onClose, colors }: {
  text: string; onClose: () => void; colors: typeof THEMES['paper']
}) {
  const [status, setStatus] = useState<'loading' | 'done' | 'error'>('loading')
  const [result, setResult] = useState<{
    contextTitle?: string; contextParagraph?: string; definition?: string
    usageFocus?: string[]; practicePrompts?: string[]
  } | null>(null)
  const [errMsg, setErrMsg] = useState('')

  useEffect(() => {
    let cancelled = false
    async function run() {
      try {
        const deckId = await getOrCreateDeck()
        if (!deckId) { setErrMsg('No vocabulary deck available.'); setStatus('error'); return }

        const noteRes = await api.post<{ note: { cards: Array<{ id: string }> } }>(
          `/api/vocabulary/decks/${deckId}/notes`,
          { noteType: 'basic', front: text.slice(0, 500), back: null, topic: 'AI Context' },
        )
        const cardId = noteRes.note?.cards?.[0]?.id
        if (!cardId) { setErrMsg('Could not create context card.'); setStatus('error'); return }

        const ctx = await api.post<{
          contextTitle?: string; contextParagraph?: string; definition?: string
          usageFocus?: string[]; practicePrompts?: string[]
        }>(`/api/vocabulary/cards/${cardId}/context`, {})

        if (!cancelled) { setResult(ctx); setStatus('done') }
      } catch (e: unknown) {
        if (!cancelled) {
          setErrMsg((e instanceof Error ? e.message : null) ?? 'AI context is not configured on this server.')
          setStatus('error')
        }
      }
    }
    run()
    return () => { cancelled = true }
  }, [text])

  return (
    <div style={{ color: colors.text, paddingBottom: 'max(env(safe-area-inset-bottom,0px),24px)' }}>
      <div className="flex items-center justify-between px-4 pt-1 pb-3">
        <span className="text-sm font-semibold uppercase tracking-wide opacity-55">Ask AI</span>
        <button onClick={onClose} className="p-1 opacity-40 hover:opacity-80 transition-opacity">
          <X size={16} />
        </button>
      </div>

      <div className="px-4 space-y-4">
        {/* Selected text */}
        <div className="px-3.5 py-2.5 rounded-xl" style={{ backgroundColor: `${colors.text}07` }}>
          <p className="text-sm leading-relaxed line-clamp-3 opacity-75" style={{ fontFamily: 'Lora, Georgia, serif' }}>
            "{text}"
          </p>
        </div>

        <div className="max-h-[45vh] overflow-y-auto">
          {status === 'loading' && (
            <div className="flex items-center gap-3 py-6">
              <div className="w-5 h-5 rounded-full border-2 border-current border-t-transparent animate-spin opacity-40" />
              <span className="text-sm opacity-45">Generating context…</span>
            </div>
          )}

          {status === 'error' && (
            <p className="text-sm opacity-50 py-2">{errMsg}</p>
          )}

          {status === 'done' && result && (
            <div className="space-y-4 pb-2">
              {result.contextTitle && (
                <p className="text-base font-semibold leading-snug">{result.contextTitle}</p>
              )}
              {result.contextParagraph && (
                <p className="text-sm leading-relaxed opacity-80">{result.contextParagraph}</p>
              )}
              {result.definition && (
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-widest opacity-40 mb-1.5">Definition</p>
                  <p className="text-sm leading-relaxed">{result.definition}</p>
                </div>
              )}
              {result.usageFocus && result.usageFocus.length > 0 && (
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-widest opacity-40 mb-2">Key Points</p>
                  <ul className="space-y-1.5">
                    {result.usageFocus.map((f, i) => (
                      <li key={i} className="text-sm flex gap-2 opacity-80">
                        <span className="opacity-40 shrink-0 mt-0.5">·</span>
                        {f}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <p className="text-[11px] opacity-35 pt-1">Saved to Vocabulary</p>
            </div>
          )}
        </div>
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
): Array<{ start: number; end: number; text: string }> {
  const chunks: Array<{ start: number; end: number; text: string }> = []
  let localPos = 0

  while (localPos < fullText.length) {
    const remaining = fullText.length - localPos
    if (remaining <= targetChars) {
      // Last (or only) chunk — take everything left
      chunks.push({
        start: globalStart + localPos,
        end:   globalStart + fullText.length,
        text:  fullText.slice(localPos),
      })
      break
    }

    // Find the last sentence boundary within [targetChars-100, targetChars+200]
    const searchWindow = fullText.slice(localPos + Math.max(0, targetChars - 100),
                                        localPos + targetChars + 200)
    let boundary = -1
    for (let i = searchWindow.length - 1; i >= 0; i--) {
      if (/[.!?]/.test(searchWindow[i]) && /[\s"']/.test(searchWindow[i + 1] ?? ' ')) {
        boundary = i + 1
        break
      }
    }

    const chunkLen = boundary >= 0
      ? Math.max(0, targetChars - 100) + boundary
      : targetChars   // hard cut if no sentence found

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
interface AudioChunk { start: number; end: number; text: string; url: string | null; status: ChunkStatus }

export interface AudioHandle {
  toggle: () => void
  stop:   () => void
}

function AudioContent({ onClose, bookId, getSlice, colors, provider, onProviderChange, voice, onVoiceChange, onPhaseChange, onHandleReady, onError }: {
  onClose: () => void; bookId: string
  getSlice: () => { text: string; start: number }
  colors: typeof THEMES['paper']
  provider: string; onProviderChange: (p: string) => void
  voice: string | null; onVoiceChange: (v: string | null) => void
  onPhaseChange?: (phase: AudioPhase, cur: number, total: number) => void
  onHandleReady?: (h: AudioHandle) => void
  onError?: (message: string) => void
}) {
  const [phase,   setPhase]   = useState<'idle' | 'buffering' | 'playing' | 'paused'>('idle')
  const [chunks,  setChunks]  = useState<AudioChunk[]>([])
  const [curIdx,  setCurIdx]  = useState(0)
  const [rate,    setRate]    = useState(1.0)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const audioRef    = useRef<HTMLAudioElement | null>(null)
  const rateRef     = useRef(rate)
  const chunksRef   = useRef<AudioChunk[]>([])
  const abortRef    = useRef<AbortController | null>(null)
  // Stable refs so the play bar's handle never goes stale
  const toggleRef   = useRef<() => void>(() => {})
  const stopRef     = useRef<() => void>(() => {})
  rateRef.current   = rate
  chunksRef.current = chunks

  // Report phase + progress upward so the play bar can render outside the sheet
  useEffect(() => {
    onPhaseChange?.(phase, curIdx, chunks.length)
  }, [phase, curIdx, chunks.length]) // eslint-disable-line react-hooks/exhaustive-deps

  // Expose stable handle on mount
  useEffect(() => {
    onHandleReady?.({
      toggle: () => toggleRef.current(),
      stop:   () => stopRef.current(),
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // ── Fetch a single chunk and store its URL ──────────────────────────────────

  function updateChunk(idx: number, patch: Partial<AudioChunk>) {
    const next = [...chunksRef.current]
    if (next[idx]) next[idx] = { ...next[idx], ...patch }
    chunksRef.current = next
    setChunks(next)
  }

  async function fetchChunk(idx: number, chunk: AudioChunk, signal: AbortSignal): Promise<string | null> {
    updateChunk(idx, { status: 'fetching' })
    try {
      const { lengthScale, sentenceSilence } = pacingFor(provider)
      const { url } = await request<{ url: string }>(`/api/books/${bookId}/live-audio`, {
        method: 'POST', signal,
        body: JSON.stringify({
          provider, voice, model: null, output_format: 'mp3',
          narration_style: '', length_scale: lengthScale, sentence_silence: sentenceSilence,
          pageNumber: 1, start: chunk.start, end: chunk.end, text: chunk.text,
        }),
      })
      updateChunk(idx, { status: 'ready', url })
      return url
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        const message = audioErrorMessage(e)
        setErrorMsg(message)
        onError?.(message)
        updateChunk(idx, { status: 'error' })
      }
      return null
    }
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
    setErrorMsg(null)
    audio.play().catch(() => {
      if (ctrl.signal.aborted) return
      setPhase('paused')
      setErrorMsg('Audio is ready. Tap play again to start playback.')
    })

    // Prefetch next chunk immediately (so it's ready before this one ends)
    const nextIdx = idx + 1
    if (nextIdx < currentChunks.length && currentChunks[nextIdx].status === 'idle') {
      fetchChunk(nextIdx, currentChunks[nextIdx], ctrl.signal).then((url) => {
        if (!url || ctrl.signal.aborted) return
        // Prefetch chunk after next too (2-chunk lookahead)
        const afterNext = nextIdx + 1
        const latest = chunksRef.current
        if (afterNext < latest.length && latest[afterNext].status === 'idle') {
          fetchChunk(afterNext, latest[afterNext], ctrl.signal)
        }
      })
    }

    audio.onended = () => {
      if (ctrl.signal.aborted) return
      const latest = chunksRef.current
      if (nextIdx >= latest.length) {
        // All chunks done
        setPhase('idle')
        setCurIdx(0)
        return
      }
      const next = latest[nextIdx]
      if (next.status === 'ready' && next.url) {
        playChunkAt(nextIdx, latest, ctrl)
      } else {
        // Brief buffering between chunks (should be rare with 2-chunk lookahead)
        setPhase('buffering')
        const waitInterval = setInterval(() => {
          const c2 = chunksRef.current[nextIdx]
          if (c2?.status === 'ready' && c2.url) {
            clearInterval(waitInterval)
            playChunkAt(nextIdx, chunksRef.current, ctrl)
          } else if (c2?.status === 'error') {
            clearInterval(waitInterval)
            setPhase('idle')
          }
        }, 200)
      }
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
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setErrorMsg(null)

    if (selectedProviderUnavailable) {
      const message = `${activeProvider?.label ?? provider} is not configured yet. Choose an available provider.`
      setErrorMsg(message)
      onError?.(message)
      return
    }

    const { text, start } = getSlice()
    if (!text.trim()) {
      setErrorMsg('There is no readable text at this position.')
      return
    }

    const chunkSize = CHUNK_CHARS[provider] ?? text.length  // cloud = one request
    const raw = buildAudioChunks(text, start, chunkSize)
    const initial: AudioChunk[] = raw.map(r => ({ ...r, url: null, status: 'idle' }))
    setChunks(initial)
    chunksRef.current = initial
    setCurIdx(0)
    setPhase('buffering')

    // Fetch chunk 0 immediately; for chunked providers kick off chunk 1 in parallel
    const url0 = await fetchChunk(0, initial[0], ctrl.signal)
    if (ctrl.signal.aborted || !url0) { setPhase('idle'); return }

    if (isChunking(provider) && initial.length > 1) {
      fetchChunk(1, initial[1], ctrl.signal)
    }

    playChunkAt(0, chunksRef.current, ctrl)
  }

  function stopPlayback() {
    abortRef.current?.abort()
    audioRef.current?.pause()
    setPhase('idle')
    setCurIdx(0)
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

  // Keep stable refs up-to-date on every render
  toggleRef.current = togglePlay
  stopRef.current   = stopPlayback

  // Stop when sheet closes
  const handleClose = () => { stopPlayback(); onClose() }

  // ── Derived UI state ────────────────────────────────────────────────────────
  const isIdle      = phase === 'idle'
  const isBuffering = phase === 'buffering'
  const isPlaying   = phase === 'playing'
  const isPaused    = phase === 'paused'

  const totalChunks  = chunks.length
  const readyChunks  = chunks.filter(c => c.status === 'ready').length
  const showProgress = !isIdle && totalChunks > 1

  // Buffering label
  const bufferLabel = (() => {
    if (!isBuffering) return null
    if (provider === 'neutts_local' || provider === 'kokoro') return 'Synthesising…'
    return 'Loading…'
  })()

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

      {/* Buffering label for single-chunk (cloud) providers */}
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
        <button className="p-2 opacity-30 hover:opacity-60 transition-opacity"><SkipBack size={22} /></button>
        <button
          onClick={togglePlay}
          disabled={isBuffering}
          className="w-14 h-14 rounded-full bg-primary text-white flex items-center justify-center shadow-lg active:scale-95 transition-transform disabled:opacity-50"
        >
          {isBuffering
            ? <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
            : (isPlaying
                ? <Pause size={24} />
                : <Play size={24} fill="currentColor" />
              )}
        </button>
        <button className="p-2 opacity-30 hover:opacity-60 transition-opacity"><SkipForward size={22} /></button>
      </div>
    </div>
  )
}

// ── Word Audio Banner ─────────────────────────────────────────────────────────

function WordAudioBanner({ word, status, onStop, onPlay }: {
  word: string; status: 'loading' | 'ready' | 'playing'; onStop: () => void; onPlay: () => void
}) {
  return (
    <motion.div
      className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-4 py-2.5 rounded-2xl shadow-xl"
      style={{
        background: 'rgba(28,28,30,0.96)', backdropFilter: 'blur(16px)',
        border: '1px solid rgba(255,255,255,0.10)', color: '#fff',
      }}
      initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 10 }} transition={{ type: 'spring', damping: 28 }}
    >
      {status === 'loading'
        ? <div className="w-4 h-4 border-2 border-white/50 border-t-transparent rounded-full animate-spin" />
        : status === 'ready'
          ? <button onClick={onPlay} className="w-6 h-6 rounded-full bg-white/10 flex items-center justify-center hover:bg-white/15">
              <Play size={12} fill="currentColor" />
            </button>
          : <Mic size={15} className="opacity-55" />}
      <span className="text-sm max-w-[180px] truncate">
        {status === 'ready' ? `${word} · tap play` : word}
      </span>
      <button onClick={onStop} className="p-0.5 ml-1 opacity-45 hover:opacity-80 transition-opacity">
        <X size={13} />
      </button>
    </motion.div>
  )
}

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
  const [sheet,         setSheet]         = useState<'none' | 'appearance' | 'audio'>('none')
  const [scrollPct,     setScrollPct]     = useState(0)
  const [barVisible,    setBarVisible]    = useState(true)
  const [selection,     setSelection]     = useState<SelectionState | null>(null)
  const [panel,         setPanel]         = useState<SecondaryPanel | null>(null)
  const [toast,         setToast]         = useState<string | null>(null)
  const [wordAudio,     setWordAudio]     = useState<{ word: string; status: 'loading' | 'ready' | 'playing' } | null>(null)
  const [ttsProvider,   setTtsProvider]   = useState(() => loadAudioPrefs().provider)
  const [ttsVoice,      setTtsVoice]      = useState<string | null>(() => loadAudioPrefs().voice)
  const [audioPhase,    setAudioPhase]    = useState<AudioPhase>('idle')
  const [audioCurIdx,   setAudioCurIdx]   = useState(0)
  const [audioTotal,    setAudioTotal]    = useState(0)
  const audioHandleRef  = useRef<AudioHandle | null>(null)

  const lastScrollY           = useRef(0)
  const latestScrollPct       = useRef(0)
  const scrollTimer           = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveTimer             = useRef<ReturnType<typeof setTimeout> | null>(null)
  const justShowedMenu        = useRef(false)
  const scrolledToOffsetRef   = useRef(false)
  const wordAudioRef      = useRef<HTMLAudioElement | null>(null)
  const readerTextRef     = useRef<HTMLDivElement | null>(null)
  const panelSnapshotRef  = useRef<SecondaryPanel | null>(null)
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
      const start = Math.max(0, Math.round(scrollPct * payload.text.length) - 200)
      const fullSlice = payload.text.slice(start, start + 2200)
      if (!fullSlice.trim()) return

      const chunkDefs = buildAudioChunks(fullSlice, start, CHUNK_CHARS[effectiveTtsProvider] ?? 900)
      if (chunkDefs.length === 0) return

      // Prefetch all chunks sequentially — by the time the user hits play most are cached
      ;(async () => {
        for (const chunk of chunkDefs) {
          if (ctrl.signal.aborted) return
          try {
            await request(`/api/books/${bookId}/live-audio`, {
              method: 'POST', signal: ctrl.signal,
              body: JSON.stringify({
                provider: effectiveTtsProvider, voice: effectiveTtsVoice, model: null, output_format: 'mp3',
                narration_style: '', length_scale: lengthScale, sentence_silence: sentenceSilence,
                pageNumber: 1, start: chunk.start, end: chunk.end, text: chunk.text,
              }),
            })
          } catch { /* silent */ }
        }
      })()
    }, 2000)  // 2 s after last scroll event

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

  const handleTouchEnd = useCallback((_ev: React.TouchEvent<HTMLDivElement>) => {
    setTimeout(() => {
      const sel = window.getSelection()
      if (!sel || sel.rangeCount === 0) return
      try {
        const range = sel.getRangeAt(0)
        const previewState = buildStateFromRange(range, 'sentence')
        if (!previewState) return
        const wc = previewState.text.split(/\s+/).filter(Boolean).length
        if (wc < 1) return
        justShowedMenu.current = true
        const state = wc >= 2 ? previewState : { ...previewState, mode: 'word' as const }
        // Clear native selection → suppresses iOS/Android selection handles & toolbar
        sel.removeAllRanges()
        setSelection(state)
      } catch { /* swallow */ }
    }, 80)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload?.text, scrollPct])

  // ── Play word ─────────────────────────────────────────────────────────────

  async function playWord(word: string, startOffset: number) {
    wordAudioRef.current?.pause()
    setWordAudio({ word, status: 'loading' })
    const fullText = payload?.text ?? ''
    const start = Math.max(0, Math.min(startOffset, fullText.length))
    const end = Math.min(fullText.length, start + 2200)
    const snippet = fullText.slice(start, end)
    if (!snippet.trim()) {
      setWordAudio(null)
      showToast('There is no readable text at this position.')
      return
    }

    try {
      const { lengthScale, sentenceSilence } = pacingFor(effectiveTtsProvider)
      const { url } = await request<{ url: string }>(`/api/books/${bookId}/live-audio`, {
        method: 'POST',
        body: JSON.stringify({
          provider: effectiveTtsProvider, voice: effectiveTtsVoice, model: null, output_format: 'mp3',
          narration_style: '', length_scale: lengthScale, sentence_silence: sentenceSilence,
          pageNumber: 1, start, end, text: snippet,
        }),
      })
      const audio = new Audio(url)
      wordAudioRef.current = audio
      audio.onended = () => setWordAudio(null)
      audio.onerror = () => setWordAudio(null)
      try {
        await audio.play()
        setWordAudio({ word, status: 'playing' })
      } catch {
        setWordAudio({ word, status: 'ready' })
        showToast('Audio is ready. Tap the banner play button.')
      }
    } catch (error) {
      setWordAudio(null)
      showToast(audioErrorMessage(error))
    }
  }

  function resumeWordAudio() {
    const audio = wordAudioRef.current
    if (!audio || !wordAudio) return
    audio.play()
      .then(() => setWordAudio({ word: wordAudio.word, status: 'playing' }))
      .catch(() => showToast('Playback was blocked by the browser. Tap play again.'))
  }

  function stopWordAudio() {
    wordAudioRef.current?.pause()
    wordAudioRef.current = null
    setWordAudio(null)
  }

  const getAudioText = useCallback(() => {
    if (!payload?.text) return { text: '', start: 0 }
    const start = Math.max(0, Math.round(scrollPct * payload.text.length) - 200)
    return { text: payload.text.slice(start, start + 2200), start }
  }, [payload?.text, scrollPct])

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

  return (
    <div
      className="min-h-svh"
      style={{ backgroundColor: colors.bg, color: colors.text }}
    >
      {/* ── Top bar ───────────────────────────────────────────────────── */}
      <header
        className="fixed inset-x-0 top-0 z-40 flex items-center px-4 h-12 transition-transform duration-200"
        style={{
          backgroundColor: colors.bar,
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          transform: barVisible ? 'translateY(0)' : 'translateY(-100%)',
          borderBottom: `1px solid ${colors.text}14`,
        }}
      >
        <Link to="/library"
          className="flex items-center gap-1.5 text-sm hover:opacity-55 transition-opacity shrink-0"
          style={{ color: colors.text }}>
          <ArrowLeft size={16} />
          <span className="hidden sm:inline">Library</span>
        </Link>

        <div className="flex-1 text-center px-3 min-w-0">
          <p className="text-sm font-medium truncate"
            style={{ color: colors.text, fontFamily: '"Playfair Display", Georgia, serif' }}>
            {payload?.book.title ?? ''}
          </p>
          <div className="h-0.5 rounded-full mt-1 mx-auto transition-all duration-300"
            style={{ width: `${readPct}%`, maxWidth: '180px', backgroundColor: `${colors.text}35` }} />
        </div>

        <div className="flex items-center gap-0.5 shrink-0">
          <button onClick={() => setSheet(s => s === 'audio' ? 'none' : 'audio')}
            className="p-2 rounded-md transition-opacity hover:opacity-55"
            style={{ color: colors.text }} aria-label="Audio">
            <Volume2 size={18} />
          </button>
          <button onClick={() => setSheet(s => s === 'appearance' ? 'none' : 'appearance')}
            className="p-2 rounded-md transition-opacity hover:opacity-55"
            style={{ color: colors.text }} aria-label="Appearance">
            <Settings2 size={18} />
          </button>
        </div>
      </header>

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
        className="mx-auto px-5 pt-16 pb-32 transition-all duration-200"
        style={{
          maxWidth: `${WIDTH_PX[appearance.width]}px`,
          WebkitTouchCallout: 'none',  // suppress iOS long-press callout
        }}
        onMouseUp={handleMouseUp}
        onClick={handleClick}
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

      {/* ── Selection menu ────────────────────────────────────────────── */}
      <AnimatePresence>
        {selection && (
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
          return null
        })()}
      </BottomSheet>

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
          bookId={bookId!}
          getSlice={getAudioText}
          colors={colors}
          provider={effectiveTtsProvider}
          onProviderChange={setTtsProvider}
          voice={effectiveTtsVoice}
          onVoiceChange={setTtsVoice}
          onPhaseChange={(ph, cur, total) => {
            setAudioPhase(ph)
            setAudioCurIdx(cur)
            setAudioTotal(total)
          }}
          onHandleReady={(h) => { audioHandleRef.current = h }}
          onError={showToast}
        />
      </BottomSheet>

      {/* ── Play bar (visible while audio is active) ──────────────────── */}
      <AnimatePresence>
        {audioPhase !== 'idle' && (
          <PlayBar
            phase={audioPhase}
            curIdx={audioCurIdx}
            totalChunks={audioTotal}
            voiceLabel={playBarVoiceLabel}
            colors={colors}
            handle={audioHandleRef.current}
            onOpenSheet={() => setSheet('audio')}
          />
        )}
      </AnimatePresence>

      {/* ── Word audio banner ─────────────────────────────────────────── */}
      <AnimatePresence>
        {wordAudio && (
          <WordAudioBanner
            word={wordAudio.word}
            status={wordAudio.status}
            onStop={stopWordAudio}
            onPlay={resumeWordAudio}
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
