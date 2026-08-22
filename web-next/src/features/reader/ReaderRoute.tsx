import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo, memo, type ReactNode } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'framer-motion'
import {
  ArrowRight, Languages, MessageSquare, Settings2, Type, Volume2, X,
  Play, Pause,
  Minus, Plus, AlignLeft, AlignCenter, AlignJustify,
  Copy, BookMarked, Globe, BookOpen, Mic, NotebookPen, Sparkles, Search,
  ChevronLeft, ChevronRight, ChevronDown, Rows3,
} from 'lucide-react'
import { Slider } from '@/components/ui/slider'
import { api, AuthError } from '@/shared/api/client'
import {
  ensureDictionarySeed,
  hasDictionaryDefinitions,
  putCachedDictionary,
  resolveLocalDictionary,
  type DictionaryResponse,
} from '@/shared/storage/dictionaryCache'
import {
  formatStudyDefinition,
  pickBestDefinition,
} from '@/shared/storage/dictionaryLookup'
import {
  flushPerformanceTelemetry,
} from '@/shared/telemetry/performanceTelemetry'
import {
  isModelReady,
  startWarmup,
  subscribeModelStatus,
} from '@/shared/storage/modelCache'
import {
  startRollingCache,
  cancelRollingCache,
  subscribeRollingCache,
  getRollingCacheState,
  type RollingCacheState,
} from '@/shared/storage/rollingVoiceCache'
import { cn } from '@/lib/utils'
import {
  CHUNK_CHARS,
  audioSliceStart,
  pacingFor,
} from './audioPlayback'
import {
  primeBrowserSpeechVoices,
} from './browserSpeech'
import { speakStudioText } from '@/features/studio/studioVoice'
import { AudioPreviewPanel } from './AudioPreviewPanel'
import {
  normalizeTtsProviders,
  pickFallbackProvider,
  type ProvidersResponse,
} from './audioProviderCatalog'
import {
  audioPrefsWithSelection,
  resolvedVoiceForProvider,
  type AudioSelection,
} from './audioPreferences'
import {
  loadBookSettings,
  saveBookSettings,
  type BookAppearance,
} from './bookSettings'
import {
  type AudioPhase,
} from './tts-engine/types'
import {
  useTtsSessionController,
  type TtsAudioChunk,
} from './tts-engine/useTtsSessionController'
import { expandToReadingPhrase } from './readingPhrase'
import {
  clampPageIndex,
  pageBreaksFromLineBoxes,
  pageClipRange,
  pageIndexForOffset,
  pageIndexForY,
  type ReaderLayout,
  type ReaderLineBox,
  type ReaderPageBreak,
} from './readerLayout'
import {
  animateTransform,
  lockPageTurnAxis,
  pageRestY,
  pageTurnDurationMs,
  prefersReducedMotion,
  resistPageTurnOffset,
  shouldCommitPageTurn,
} from './pageTurn'

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

type Appearance = BookAppearance

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

const READER_HEADER_HEIGHT = 52

const WIDTH_PX  = { narrow: 520, balanced: 660, wide: 820 }
const THEMES    = {
  paper: { bg: '#fbf8f4', text: '#1c1c1e', bar: 'rgba(251,248,244,0.92)', playback: 'rgba(168, 176, 226, 0.58)' },
  white: { bg: '#eee2c6', text: '#1f1a14', bar: 'rgba(238,226,198,0.9)', playback: 'rgba(176, 148, 96, 0.28)' },
  dark:  { bg: '#1a1a18', text: '#e8e6e1', bar: 'rgba(26,26,24,0.92)',   playback: 'rgba(130, 148, 228, 0.34)' },
}

const HIGHLIGHT_COLORS = [
  { id: 'amber' as const, hex: '#fbbf24', label: 'Yellow' },
  { id: 'rose'  as const, hex: '#fb7185', label: 'Pink'   },
  { id: 'sky'   as const, hex: '#38bdf8', label: 'Blue'   },
]

const HIGHLIGHT_BG: Record<'amber' | 'rose' | 'sky', string> = {
  amber: 'rgba(251, 191, 36, 0.40)',
  rose:  'rgba(251, 113, 133, 0.34)',
  sky:   'rgba(56, 189, 248, 0.34)',
}

type ReaderHighlight = ReaderPayload['highlights'][number]

function firstDictionaryDefinition(
  payload: DictionaryResponse | null | undefined,
  options?: { context?: string | null },
): {
  term: string
  definition: string | null
  pronunciation: string | null
  example: string | null
  partOfSpeech: string | null
} {
  const ranked = pickBestDefinition(payload, { context: options?.context })
  if (ranked) {
    return {
      term: ranked.term || (payload?.term ?? '').trim(),
      definition: formatStudyDefinition(ranked.definition, ranked.partOfSpeech),
      pronunciation: ranked.pronunciation,
      example: ranked.example,
      partOfSpeech: ranked.partOfSpeech,
    }
  }
  return {
    term: (payload?.term ?? '').trim(),
    definition: null,
    pronunciation: payload?.pronunciation ?? null,
    example: null,
    partOfSpeech: null,
  }
}

function appendReaderHighlight(
  payload: ReaderPayload | undefined,
  highlight: ReaderHighlight,
): ReaderPayload | undefined {
  if (!payload) return payload
  if (payload.highlights.some((h) => h.id === highlight.id)) return payload
  return {
    ...payload,
    highlights: [...payload.highlights, highlight].sort((a, b) => a.start - b.start),
  }
}

const PROGRESS_KEY    = 'storybook-reader-progress'

function aiErrorMessage(error: unknown, fallback = 'Something went wrong.') {
  const raw = error instanceof Error ? error.message : String(error)
  const detail = raw.match(/"detail"\s*:\s*"([^"]+)"/)?.[1]
  const message = (detail ?? raw).trim()

  if (/Authentication required|Unauthorized|Session expired/i.test(message)) {
    return 'Your session expired. Sign in again, then try again.'
  }
  if (/AI service is not configured|not configured|configured yet|GEMINI_API_KEY/i.test(message)) {
    return 'AI is not configured yet. Add GEMINI_API_KEY to the worker.'
  }
  if (/quota|rate limit|429/i.test(message)) {
    return 'Gemini quota exceeded. Wait a minute or check billing / free-tier limits.'
  }
  if (/Failed to fetch|NetworkError|fetch|timeout/i.test(message)) {
    return 'Could not reach the AI service. Check the connection and try again.'
  }
  return message || fallback
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Bionic reading: bold the initial ~45 % of each word to create fixation points.
// Each word is wrapped in a span so getWordAtPoint can recover the full word across the <b> boundary.
function toBionicNodes(text: string): ReactNode[] {
  const parts = text.match(/[a-zA-Z0-9]+|[^a-zA-Z0-9]+/g) ?? []
  return parts.map((part, i) => {
    if (/^[a-zA-Z]/.test(part)) {
      const n = Math.max(1, Math.ceil(part.length * 0.45))
      return (
        <span key={i} data-bionic-word="true" style={{ display: 'inline' }}>
          <b>{part.slice(0, n)}</b>{part.slice(n)}
        </span>
      )
    }
    return part
  })
}

function splitParagraphByHighlights(
  text: string,
  paragraphStart: number,
  highlights: ReaderHighlight[],
  playback: { start: number; end: number } | null,
): Array<{ text: string; color: 'amber' | 'rose' | 'sky' | null; playback: boolean; key: string }> {
  const paraEnd = paragraphStart + text.length
  const cuts = new Set<number>([0, text.length])

  for (const highlight of highlights) {
    if (highlight.end <= paragraphStart || highlight.start >= paraEnd) continue
    cuts.add(Math.max(0, highlight.start - paragraphStart))
    cuts.add(Math.min(text.length, highlight.end - paragraphStart))
  }
  if (playback && playback.end > paragraphStart && playback.start < paraEnd) {
    cuts.add(Math.max(0, playback.start - paragraphStart))
    cuts.add(Math.min(text.length, playback.end - paragraphStart))
  }

  const points = [...cuts].sort((a, b) => a - b)
  const parts: Array<{
    text: string
    color: 'amber' | 'rose' | 'sky' | null
    playback: boolean
    key: string
  }> = []

  for (let i = 0; i < points.length - 1; i += 1) {
    const from = points[i]!
    const to = points[i + 1]!
    if (to <= from) continue
    const absFrom = paragraphStart + from
    const absTo = paragraphStart + to
    const owner = highlights.find((h) => h.start <= absFrom && h.end >= absTo)
    parts.push({
      text: text.slice(from, to),
      color: owner
        ? (owner.color === 'rose' || owner.color === 'sky' ? owner.color : 'amber')
        : null,
      playback: Boolean(playback && playback.start <= absFrom && playback.end >= absTo),
      key: `s-${from}-${to}`,
    })
  }

  return parts.length > 0
    ? parts
    : [{ text, color: null, playback: false, key: 'plain' }]
}

// Paragraph list, isolated from the parent's frequent state updates (audio ticks, scroll %, etc).
// React.memo means audio/scroll re-renders skip the entire paragraph subtree as long as
// `paragraphs` / `bionic` / `highlights` keep stable references.
//
// `content-visibility: auto` is the actual heavy-lift fix for bionic mode: the browser skips
// layout AND paint for paragraphs that are far from the viewport and treats them as
// `contain-intrinsic-size`-sized placeholders. Without it, every paragraph in the entire book
// pays full layout/paint cost — and bionic's per-word inline boxes make that cost ~3× higher.
// `auto 6em` is a per-paragraph height estimate; the `auto` keyword tells the browser to remember
// each paragraph's measured size after first render so the scrollbar stops jumping.
const ReaderParagraphs = memo(function ReaderParagraphs({
  paragraphs,
  bionic,
  highlights,
  playback,
  playbackColor,
  virtualize = true,
}: {
  paragraphs: ReaderParagraph[]
  bionic: boolean
  highlights: ReaderHighlight[]
  playback: { start: number; end: number } | null
  playbackColor: string
  virtualize?: boolean
}) {
  return (
    <>
      {paragraphs.map((p, i) => {
        const parts = splitParagraphByHighlights(p.text, p.startOffset, highlights, playback)
        return (
          <p
            key={`${p.startOffset}-${i}`}
            className={cn(
              'mb-[1.4em]',
              virtualize && '[content-visibility:auto] [contain-intrinsic-size:auto_6em]',
            )}
            data-reader-paragraph-start={p.startOffset}
          >
            {parts.map((part) => {
              const content = bionic ? toBionicNodes(part.text) : part.text
              if (!part.color && !part.playback) {
                return <span key={part.key}>{content}</span>
              }
              return (
                <mark
                  key={part.key}
                  data-reader-highlight={part.color ? 'true' : undefined}
                  data-reader-playback={part.playback ? 'true' : undefined}
                  className={part.playback ? 'reader-playback-hl' : undefined}
                  style={{
                    backgroundColor: part.playback ? playbackColor : HIGHLIGHT_BG[part.color!],
                    color: 'inherit',
                    borderRadius: part.playback ? 1 : 2,
                    padding: part.playback && virtualize ? '0.18em 0.16em' : '0 0.04em',
                  }}
                >
                  {content}
                </mark>
              )
            })}
          </p>
        )
      })}
    </>
  )
})

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
  const raw = Array.from(range.getClientRects())
    .filter(rect => rect.width > 0 && rect.height > 0)

  if (raw.length === 0) return [toSelectionRect(fallbackRect)]

  // Sort top-to-bottom, left-to-right so we can merge in one pass.
  raw.sort((a, b) => a.top - b.top || a.left - b.left)

  // Merge rects that share the same visual line (within 3 px vertically) and
  // are adjacent / overlapping horizontally (gap ≤ 2 px).  This collapses the
  // two per-word boxes that bionic reading creates (<b> + plain text) into a
  // single rect, eliminating the seam/height-mismatch artifact.
  const merged: SelectionRect[] = []
  for (const rect of raw) {
    const prev = merged[merged.length - 1]
    if (prev && Math.abs(rect.top - prev.top) <= 3 && rect.left <= prev.left + prev.width + 2) {
      const right  = Math.max(prev.left + prev.width, rect.left + rect.width)
      const top    = Math.min(prev.top, rect.top)
      const bottom = Math.max(prev.top + prev.height, rect.top + rect.height)
      prev.left   = Math.min(prev.left, rect.left)
      prev.top    = top
      prev.width  = right - prev.left
      prev.height = bottom - top
    } else {
      merged.push(toSelectionRect(rect))
    }
  }

  return merged
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

  // Bionic mode: if the caret landed inside a <b> fragment, use the parent word span
  // so that the full word (e.g. "Introduction") is selected, not just the bold part ("Introd").
  const bionicSpan = (node as Text).parentElement?.closest<HTMLElement>('[data-bionic-word]')
  if (bionicSpan) {
    const text = (bionicSpan.textContent ?? '').trim()
    if (!text || text.length < 2) return null
    const range = document.createRange()
    range.selectNodeContents(bionicSpan)
    return { text, rect: range.getBoundingClientRect(), range }
  }

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
  const [mounted, setMounted] = useState(open)
  const [visible, setVisible] = useState(false)

  // Animation choreography: open → mount, then on next paint flip visible so
  // the CSS transform/opacity transitions run. close → hide first, unmount
  // after the 260ms transition. The setState calls here coordinate with the
  // browser paint cycle (rAF / setTimeout) and are the documented exception
  // to react-hooks/set-state-in-effect.
  useEffect(() => {
    if (open) {
      setMounted(true) // eslint-disable-line react-hooks/set-state-in-effect
      const handle = requestAnimationFrame(() =>
        requestAnimationFrame(() => setVisible(true)),
      )
      return () => cancelAnimationFrame(handle)
    }
    setVisible(false)
    const t = setTimeout(() => setMounted(false), 260)
    return () => clearTimeout(t)
  }, [open])

  if (!mounted) return null

  return (
    <div className="fixed inset-0 z-[65] flex items-end justify-center">
      <div
        className="absolute inset-0 bg-black/30"
        style={{ opacity: visible ? 1 : 0, transition: 'opacity 200ms ease' }}
        onClick={onClose}
      />
      <div
        className="relative w-full max-w-md rounded-t-2xl shadow-2xl overflow-hidden"
        style={{
          backgroundColor: bg,
          paddingBottom: 'env(safe-area-inset-bottom, 0px)',
          transform: visible ? 'translateY(0)' : 'translateY(100%)',
          transition: 'transform 220ms cubic-bezier(0.32,0.72,0,1)',
          willChange: 'transform',
        }}
      >
        <div className="flex justify-center pt-3 pb-1">
          <div className="w-8 h-1 rounded-full bg-current opacity-20" />
        </div>
        {children}
      </div>
    </div>
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
  /** Speculative warm on Play press (before click completes). */
  onWarmAtOffset?: (startOffset: number) => void
}

function SelectionMenu({
  sel, bookId, fullText,
  onClose, onOpenPanel, onToast, onPlayWord, onWarmAtOffset,
}: SelectionMenuProps) {
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [busyColor,  setBusyColor]  = useState<string | null>(null)
  const queryClient = useQueryClient()

  useEffect(() => {
    const normalized = normalizeLookupWord(sel.text)
    if (sel.mode !== 'word' || !normalized || normalized.includes(' ')) return
    // Prefetch full client path (seed/IDB first) so Define opens with data ready.
    void queryClient.prefetchQuery({
      queryKey: dictionaryQueryKey(normalized),
      queryFn: () => fetchClientDictionary(normalized),
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
          const context = fullText.slice(contextStart, contextEnd)
          // Resolve definition so Vocabulary / Studio show a real answer card.
          // Rank senses using book context so rare technical senses lose to reading senses.
          const dict = await fetchClientDictionary(sel.text).catch(() => null)
          const resolved = firstDictionaryDefinition(dict as DictionaryResponse | null, { context })
          const front = (resolved.term || sel.text).trim()
          await api.post(`/api/vocabulary/decks/${deckId}/notes`, {
            noteType: 'basic',
            front,
            back: resolved.definition,
            extra: resolved.pronunciation,
            // Prefer the actual book sentence over a dictionary example.
            exampleSentence: context.includes(front) ? context : (resolved.example ?? context),
            topic: 'Reading',
            tags: ['reader'],
            sourceRef: `reader-vocab:${front.toLowerCase()}`,
            metadata: {
              source: 'reader-selection',
              bookId,
              start: sel.startOffset,
              end: sel.endOffset,
              context,
              dictionarySource: resolved.definition ? 'dictionary-ranked' : null,
              partOfSpeech: resolved.partOfSpeech,
              rankedDefinition: true,
            },
          })
          queryClient.invalidateQueries({ queryKey: ['decks'] })
          queryClient.invalidateQueries({ queryKey: ['deck-dashboard'] })
          onToast(resolved.definition ? 'Saved to Vocabulary ✓' : 'Saved (no definition found)')
        } catch (err) {
          console.error('Vocabulary save failed', err)
          if (err instanceof AuthError) {
            onToast('Sign in to save')
          } else {
            const msg = err instanceof Error ? err.message : String(err)
            onToast(`Could not save: ${msg.slice(0, 60)}`)
          }
        }
        setBusyAction(null)
        onClose()
        break
      }
      case 'dictionary':
        void queryClient.prefetchQuery({
          queryKey: dictionaryQueryKey(sel.text),
          queryFn: () => fetchClientDictionary(sel.text),
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
      const created = await api.post<ReaderHighlight>(`/api/books/${bookId}/highlights`, {
        start: sel.startOffset, end: sel.endOffset,
        color: colorId, kind: 'highlight', text: sel.text, note: null,
      })
      queryClient.setQueryData<ReaderPayload>(['reader', bookId], (prev) =>
        appendReaderHighlight(prev, {
          id: created.id,
          start: created.start,
          end: created.end,
          color: (created.color === 'rose' || created.color === 'sky' ? created.color : colorId),
          text: created.text,
          note: created.note ?? null,
          kind: created.kind === 'note' || created.kind === 'vocabulary' ? created.kind : 'highlight',
        }),
      )
      queryClient.invalidateQueries({ queryKey: ['highlights', bookId] })
      queryClient.invalidateQueries({ queryKey: ['reader', bookId] })
      queryClient.invalidateQueries({ queryKey: ['books'] })
      onToast('Highlighted ✓')
    } catch (err) {
      console.error('Highlight save failed', err)
      if (err instanceof AuthError) onToast('Sign in to highlight')
      else onToast('Could not highlight')
    }
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
            onPointerDown={(e) => {
              // Start network/synth on press so Play often hits a warm cache.
              if (id === 'play' && sel.mode === 'word') {
                e.stopPropagation()
                onWarmAtOffset?.(sel.startOffset)
              }
            }}
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
  return value
    .trim()
    .toLowerCase()
    // strip wrapping quotes / punctuation commonly selected with words
    .replace(/^[\s"'“”‘’([{«]+/u, '')
    .replace(/[\s"'“”‘’)}\],.;:!?»]+$/gu, '')
    .replace(/[’']/g, "'")
}

/** Candidate headwords to try when the exact form is missing (masters → master). */
function dictionaryLookupVariants(term: string): string[] {
  const base = normalizeLookupWord(term)
  if (!base) return []
  const out: string[] = [base]
  const push = (v: string) => {
    const t = normalizeLookupWord(v)
    if (t && t.length >= 2 && !out.includes(t)) out.push(t)
  }
  if (base.endsWith("'s")) push(base.slice(0, -2))
  if (base.endsWith('ies') && base.length > 4) push(`${base.slice(0, -3)}y`)
  if (base.endsWith('ves') && base.length > 4) push(`${base.slice(0, -3)}f`)
  if (base.endsWith('ing') && base.length > 5) {
    push(base.slice(0, -3))
    push(`${base.slice(0, -3)}e`)
  }
  if (base.endsWith('ed') && base.length > 4) {
    push(base.slice(0, -2))
    push(base.slice(0, -1))
  }
  if (base.endsWith('es') && base.length > 3) push(base.slice(0, -2))
  if (base.endsWith('s') && !base.endsWith('ss') && base.length > 3) push(base.slice(0, -1))
  if (base.endsWith('ly') && base.length > 4) push(base.slice(0, -2))
  return out
}

function dictionaryQueryKey(word: string) {
  return ['dictionary', normalizeLookupWord(word)] as const
}

function fetchOfflineDictionary(word: string) {
  return api.get<DictResponse | FreeEntry[] | FreeEntry>(
    `/api/dictionary/lookup?term=${encodeURIComponent(normalizeLookupWord(word))}`,
  )
}

function dictionaryHasDefinitions(payload: DictResponse | null | undefined) {
  return hasDictionaryDefinitions(payload as DictionaryResponse | null)
}

/** Accept both our DictResponse shape and raw Free Dictionary API payloads. */
function coerceDictionaryPayload(raw: unknown, fallbackTerm: string): DictResponse | null {
  if (!raw || typeof raw !== 'object') return null

  // Already normalized worker/client shape
  const asDict = raw as DictResponse
  if (Array.isArray(asDict.entries)) {
    if (dictionaryHasDefinitions(asDict)) {
      return {
        ...asDict,
        term: asDict.term || fallbackTerm,
        available: true,
        message: null,
        pronunciation: asDict.pronunciation ?? null,
        relatedTerms: asDict.relatedTerms ?? [],
      }
    }
    return null
  }

  // Raw Free Dictionary: [{ word, meanings, phonetic }]
  const rows = Array.isArray(raw) ? raw : [raw]
  const fe = rows[0] as FreeEntry | undefined
  if (!fe?.meanings?.length) return null

  const payload: DictResponse = {
    term: fe.word || fallbackTerm,
    available: true,
    message: null,
    pronunciation: fe.phonetic ?? null,
    entries: fe.meanings.slice(0, 5).map((m) => ({
      partOfSpeech: m.partOfSpeech,
      definitions: (m.definitions ?? []).slice(0, 5).map((d) => ({
        definition: d.definition,
        examples: d.example ? [d.example] : [],
        synonyms: [...(d.synonyms ?? []), ...(m.synonyms ?? [])].slice(0, 8),
      })),
    })),
    relatedTerms: [],
  }
  return dictionaryHasDefinitions(payload) ? payload : null
}

async function fetchFreeDictionary(term: string): Promise<DictResponse | null> {
  try {
    const r = await fetch(
      `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(term)}`,
      { signal: AbortSignal.timeout(7000) },
    )
    if (!r.ok) return null
    return coerceDictionaryPayload(await r.json(), term)
  } catch {
    return null
  }
}

async function fetchBackendDictionary(term: string): Promise<DictResponse | null> {
  try {
    const raw = await fetchOfflineDictionary(term)
    return coerceDictionaryPayload(raw, term)
  } catch {
    return null
  }
}

/**
 * Instant-first dictionary resolve with strong fallbacks:
 * 1) memory/seed/IDB
 * 2) Free Dictionary + worker proxy (normalized)
 * 3) lemma variants (masters → master)
 * Never cache empty misses for long — UI can retry.
 */
async function fetchClientDictionary(word: string): Promise<DictResponse> {
  const variants = dictionaryLookupVariants(word)
  const primary = variants[0] || normalizeLookupWord(word) || word.trim().toLowerCase()
  await ensureDictionarySeed()

  for (const candidate of variants) {
    const local = await resolveLocalDictionary(candidate)
    if (dictionaryHasDefinitions(local)) {
      const hit = local as DictResponse
      // Also remember under the original typed form.
      if (candidate !== primary) void putCachedDictionary(primary, hit as DictionaryResponse)
      return { ...hit, term: hit.term || primary }
    }
  }

  for (const candidate of variants) {
    // Prefer worker proxy (handles CORS + Gemini last resort) in parallel with direct free dict.
    const [free, backend] = await Promise.all([
      fetchFreeDictionary(candidate),
      fetchBackendDictionary(candidate),
    ])
    const winner = (dictionaryHasDefinitions(backend) ? backend : null)
      ?? (dictionaryHasDefinitions(free) ? free : null)
    if (winner) {
      void putCachedDictionary(candidate, winner as DictionaryResponse)
      void putCachedDictionary(primary, winner as DictionaryResponse)
      return { ...winner, term: winner.term || primary, available: true }
    }
  }

  // Soft empty — short-lived so the next open retries network/Gemini.
  return {
    term: primary,
    available: false,
    message: 'No definition found.',
    pronunciation: null,
    entries: [],
    relatedTerms: [],
  }
}

// ── Dictionary Panel ──────────────────────────────────────────────────────────

function DictionaryPanel({ word: initialWord, bookId, onClose, colors }: {
  word: string
  bookId?: string
  onClose: () => void
  colors: typeof THEMES['paper']
}) {
  const [lookupWord, setLookupWord] = useState(() => normalizeLookupWord(initialWord) || initialWord)
  const [inputValue, setInputValue] = useState(initialWord)
  const [speaking,   setSpeaking]   = useState(false)
  const [vocabState, setVocabState] = useState<'idle' | 'busy' | 'saved' | 'error'>('idle')
  const [vocabError, setVocabError] = useState<string | null>(null)
  const queryClient = useQueryClient()

  // Single query: local seed/IDB first, then raced network. Prefetch on word
  // selection often means this resolves from React Query cache instantly.
  const { data: dictData, isLoading, isFetching, refetch } = useQuery({
    queryKey: dictionaryQueryKey(lookupWord),
    queryFn: () => fetchClientDictionary(lookupWord),
    // Default warm cache; empty results are not written to IDB and expire via gc.
    staleTime: DICTIONARY_STALE_TIME_MS,
    gcTime: DICTIONARY_STALE_TIME_MS,
    retry: 2,
    retryDelay: 600,
    })

  const hasDefs = dictionaryHasDefinitions(dictData ?? null)
  const autoRetryRef = useRef<string | null>(null)

  // One automatic retry on a miss (covers transient Free Dict / worker failures).
  useEffect(() => {
    if (isLoading || isFetching || hasDefs || !dictData) return
    if (autoRetryRef.current === lookupWord) return
    autoRetryRef.current = lookupWord
    const t = window.setTimeout(() => { void refetch() }, 1200)
    return () => window.clearTimeout(t)
  }, [dictData, hasDefs, isFetching, isLoading, lookupWord, refetch])

  // Unified DisplayData from the single resolved payload
  const displayData = useMemo((): DisplayData | null => {
    if (!dictData) return null
    const entries = (dictData.entries ?? []).map((e) => ({
      partOfSpeech: e.partOfSpeech ?? '',
      definitions: (e.definitions ?? []).map((d) => ({
        definition: d.definition,
        examples: d.examples ?? [],
        synonyms: d.synonyms ?? [],
      })),
    }))
    // Heuristic: free-dict payloads often lack relatedTerms from our seed.
    const source: DisplayData['source'] =
      hasDefs && (dictData.relatedTerms?.length ?? 0) === 0 && entries.length > 0
        ? 'online'
        : 'offline'
    return {
      term: dictData.term ?? lookupWord,
      pronunciation: dictData.pronunciation ?? null,
      entries,
      relatedTerms: dictData.relatedTerms ?? [],
      source: hasDefs ? source : 'offline',
    }
  }, [dictData, hasDefs, lookupWord])

  // Show skeleton while first load OR while a miss is being re-fetched.
  const showLoading = (isLoading || isFetching) && !hasDefs

  async function speak() {
    const term = displayData?.term ?? lookupWord
    if (!term?.trim()) return
    setSpeaking(true)
    try {
      await speakStudioText(term)
    } finally {
      setSpeaking(false)
    }
  }

  function navigate(w: string) {
    const t = w.trim().toLowerCase()
    if (!t) return
    setLookupWord(t)
    setInputValue(t)
    setVocabState('idle')
  }

  async function saveToVocab() {
    if (vocabState === 'busy' || vocabState === 'saved') return
    setVocabState('busy')
    setVocabError(null)
    try {
      const deckId = await getOrCreateDeck()
      if (!deckId) {
        setVocabState('error')
        setVocabError('Could not open vocabulary deck')
        return
      }
      const resolved = firstDictionaryDefinition({
        term: displayData?.term ?? lookupWord,
        available: Boolean(displayData),
        pronunciation: displayData?.pronunciation ?? null,
        entries: displayData?.entries ?? [],
        relatedTerms: displayData?.relatedTerms ?? [],
      })
      const front = (resolved.term || lookupWord).trim()
      const firstExample = resolved.example
        ?? displayData?.entries
          ?.flatMap((e) => e.definitions.flatMap((d) => d.examples))
          .find((ex) => ex.trim())
      await api.post(`/api/vocabulary/decks/${deckId}/notes`, {
        noteType: 'basic',
        front,
        back: resolved.definition,
        extra: resolved.pronunciation,
        exampleSentence: firstExample,
        topic: 'Reading',
        tags: ['reader', 'dictionary'],
        sourceRef: `reader-vocab:${front.toLowerCase()}`,
        metadata: {
          source: 'dictionary',
          bookId: bookId ?? null,
          dictionarySource: displayData?.source ? `${displayData.source}-ranked` : 'dictionary-ranked',
          partOfSpeech: resolved.partOfSpeech,
          rankedDefinition: true,
        },
      })
      queryClient.invalidateQueries({ queryKey: ['decks'] })
      queryClient.invalidateQueries({ queryKey: ['deck-dashboard'] })
      setVocabState('saved')
    } catch (err) {
      console.error('Dictionary vocab save failed', err)
      setVocabState('error')
      if (err instanceof AuthError) setVocabError('Sign in to save words')
      else setVocabError(err instanceof Error ? err.message.slice(0, 80) : 'Could not save word')
    }
  }

  const POS_PILL: Record<string, { bg: string; color: string }> = {
    noun:        { bg: '#dbeafe', color: '#1d4ed8' },
    verb:        { bg: '#dcfce7', color: '#15803d' },
    adjective:   { bg: '#f3e8ff', color: '#7e22ce' },
    adverb:      { bg: '#fff7ed', color: '#c2410c' },
    pronoun:     { bg: '#fef9c3', color: '#854d0e' },
    preposition: { bg: '#f1f5f9', color: '#475569' },
    conjunction: { bg: '#ffe4e6', color: '#be123c' },
  }
  function posPill(pos: string) {
    const key = pos.toLowerCase().split(' ')[0]
    return POS_PILL[key] ?? { bg: `${colors.text}10`, color: `${colors.text}70` }
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
            style={{ color: '#f59e0b', backgroundColor: '#f59e0b18' }}>
            Go
          </button>
        )}
        <button onClick={onClose} className="p-0.5 ml-1 opacity-35 hover:opacity-70 transition-opacity shrink-0">
          <X size={15} />
        </button>
      </div>

      {/* ── Content ─────────────────────────────────────────── */}
      <div className="overflow-y-auto" style={{ maxHeight: '65vh' }}>

        {/* Loading skeleton — only when we have nothing to show yet */}
        {showLoading && (
          <div className="px-5 pt-5 pb-4 animate-pulse space-y-3">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full shrink-0" style={{ background: `${colors.text}08` }} />
              <div className="flex-1 space-y-2">
                <div className="h-7 w-32 rounded-lg" style={{ background: `${colors.text}10` }} />
                <div className="h-3 w-20 rounded" style={{ background: `${colors.text}07` }} />
              </div>
            </div>
            <div className="h-5 w-14 rounded-full" style={{ background: `${colors.text}08` }} />
            {[100, 88, 72, 90, 64].map((w, i) => (
              <div key={i} className="h-3.5 rounded" style={{ background: `${colors.text}07`, width: `${w}%` }} />
            ))}
          </div>
        )}

        {/* Result */}
        {!showLoading && displayData && (
          <div>
            {/* ── Word hero ───────────────────────────────────── */}
            <div className="px-5 pt-5 pb-4" style={{ borderBottom: `1px solid ${colors.text}0e` }}>
              <div className="flex items-start justify-between gap-3">
                {/* Left: audio + word */}
                <div className="flex items-start gap-3 min-w-0">
                  <button
                    onClick={speak}
                    aria-label="Pronounce"
                    className="w-10 h-10 rounded-full flex items-center justify-center shrink-0 transition-all active:scale-90 mt-1"
                    style={{
                      background: speaking ? '#f59e0b' : '#f59e0b18',
                      boxShadow: speaking ? '0 0 0 4px #f59e0b22' : 'none',
                    }}
                  >
                    <Volume2 size={17} strokeWidth={2} style={{ color: speaking ? '#fff' : '#f59e0b' }} />
                  </button>
                  <div className="min-w-0">
                    <h2
                      className="leading-tight break-words"
                      style={{
                        fontFamily: 'Lora, Georgia, serif',
                        fontSize: 30,
                        fontWeight: 600,
                        color: colors.text,
                        letterSpacing: '-0.01em',
                      }}
                    >
                      {displayData.term}
                    </h2>
                    {displayData.pronunciation && (
                      <p style={{ fontSize: 13, color: `${colors.text}55`, fontFamily: '"SF Mono", Consolas, monospace', marginTop: 3 }}>
                        {displayData.pronunciation}
                      </p>
                    )}
                  </div>
                </div>

                {/* Right: save to vocabulary */}
                <div className="flex flex-col items-end gap-1 mt-1 shrink-0">
                  <button
                    onClick={() => void saveToVocab()}
                    aria-label="Save to vocabulary"
                    disabled={vocabState === 'busy' || vocabState === 'saved'}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-full transition-all active:scale-95"
                    style={{
                      background: vocabState === 'saved'
                        ? '#22c55e18'
                        : vocabState === 'error'
                          ? '#ef444418'
                          : `${colors.text}0c`,
                      color: vocabState === 'saved'
                        ? '#22c55e'
                        : vocabState === 'error'
                          ? '#ef4444'
                          : `${colors.text}60`,
                      border: `1px solid ${
                        vocabState === 'saved'
                          ? '#22c55e33'
                          : vocabState === 'error'
                            ? '#ef444433'
                            : `${colors.text}14`
                      }`,
                      fontSize: 11.5,
                      fontWeight: 600,
                      letterSpacing: '0.01em',
                    }}
                  >
                    {vocabState === 'busy' ? (
                      <div className="w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin" />
                    ) : vocabState === 'saved' ? (
                      <span>✓ Saved</span>
                    ) : vocabState === 'error' ? (
                      <span>Retry save</span>
                    ) : (
                      <><Type size={11} /> Save</>
                    )}
                  </button>
                  {vocabError && (
                    <span style={{ fontSize: 10, color: '#ef4444', maxWidth: 140, textAlign: 'right' }}>
                      {vocabError}
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* ── Entries ──────────────────────────────────────── */}
            <div className="px-5 pt-4 pb-5 space-y-6">
              {displayData.entries.map((entry, ei) => (
                <div key={ei}>
                  {/* Part of speech pill */}
                  {entry.partOfSpeech && (() => {
                    const { bg, color } = posPill(entry.partOfSpeech)
                    return (
                      <div className="mb-3">
                        <span style={{
                          display: 'inline-flex', alignItems: 'center',
                          padding: '3px 10px', borderRadius: 99,
                          background: bg, color,
                          fontSize: 10.5, fontWeight: 700,
                          letterSpacing: '0.07em', textTransform: 'uppercase',
                        }}>
                          {entry.partOfSpeech}
                        </span>
                      </div>
                    )
                  })()}

                  {/* Definitions */}
                  <div className="space-y-4">
                    {entry.definitions.map((def, di) => (
                      <div key={di} className="flex gap-3">
                        {/* Numbered badge */}
                        <span style={{
                          minWidth: 22, height: 22,
                          background: '#f59e0b18',
                          color: '#f59e0b',
                          fontSize: 11, fontWeight: 800,
                          borderRadius: 6,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          flexShrink: 0, marginTop: 2,
                        }}>
                          {di + 1}
                        </span>
                        <div className="flex-1 min-w-0">
                          <p style={{ fontSize: 14.5, lineHeight: 1.65, color: colors.text }}>
                            {def.definition}
                          </p>
                          {def.examples.slice(0, 2).map((ex, xi) => (
                            <div key={xi} style={{
                              borderLeft: `2px solid #f59e0b55`,
                              paddingLeft: 10,
                              marginTop: 8,
                            }}>
                              <p style={{ fontSize: 13, fontStyle: 'italic', lineHeight: 1.55, color: `${colors.text}55` }}>
                                "{ex}"
                              </p>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Synonyms */}
                  {(() => {
                    const unique = [...new Set(entry.definitions.flatMap(d => d.synonyms))].slice(0, 7)
                    return unique.length > 0 ? (
                      <div className="flex flex-wrap items-center gap-1.5 mt-3 pt-3" style={{ borderTop: `1px solid ${colors.text}0a` }}>
                        <span style={{ fontSize: 11, color: `${colors.text}40`, fontWeight: 600, letterSpacing: '0.04em' }}>
                          SIMILAR
                        </span>
                        {unique.map(s => (
                          <button key={s} onClick={() => navigate(s)}
                            className="transition-all hover:opacity-80 active:scale-95"
                            style={{
                              padding: '2px 9px', borderRadius: 99,
                              fontSize: 12, color: `${colors.text}65`,
                              background: `${colors.text}08`,
                              border: `1px solid ${colors.text}12`,
                            }}>
                            {s}
                          </button>
                        ))}
                      </div>
                    ) : null
                  })()}
                </div>
              ))}

              {/* No definitions */}
              {displayData.entries.length === 0 && (
                <div className="space-y-3">
                  <p style={{ fontSize: 14, color: `${colors.text}45`, fontStyle: 'italic' }}>
                    No definition found for this word yet.
                  </p>
                  <button
                    type="button"
                    onClick={() => void refetch()}
                    disabled={isFetching}
                    className="text-xs font-semibold px-3 py-1.5 rounded-full"
                    style={{
                      background: `${colors.text}0c`,
                      color: `${colors.text}70`,
                      border: `1px solid ${colors.text}14`,
                      opacity: isFetching ? 0.6 : 1,
                    }}
                  >
                    {isFetching ? 'Looking up…' : 'Try again'}
                  </button>
                </div>
              )}

              {/* Related terms */}
              {displayData.relatedTerms.length > 0 && (
                <div className="pt-4" style={{ borderTop: `1px solid ${colors.text}0e` }}>
                  <p style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: `${colors.text}35`, marginBottom: 10 }}>
                    Related
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {displayData.relatedTerms.slice(0, 10).map(t => (
                      <button key={t} onClick={() => navigate(t)}
                        className="transition-all hover:opacity-80 active:scale-95"
                        style={{
                          padding: '4px 12px', borderRadius: 99,
                          fontSize: 12.5, color: `${colors.text}60`,
                          border: `1px solid ${colors.text}18`,
                        }}>
                        {t}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {displayData.source === 'online' && (
                <p style={{ fontSize: 10, textAlign: 'center', color: `${colors.text}25`, paddingTop: 4 }}>
                  via Free Dictionary API
                </p>
              )}
            </div>
          </div>
        )}

        {/* Truly nothing */}
        {!showLoading && !displayData && (
          <div className="px-5 pt-5 space-y-3">
            <p className="text-sm" style={{ color: `${colors.text}50` }}>
              No definition found for "{lookupWord}".
            </p>
            <button
              type="button"
              onClick={() => void refetch()}
              disabled={isFetching}
              className="text-xs font-semibold px-3 py-1.5 rounded-full"
              style={{
                background: `${colors.text}0c`,
                color: `${colors.text}70`,
                border: `1px solid ${colors.text}14`,
              }}
            >
              {isFetching ? 'Looking up…' : 'Try again'}
            </button>
          </div>
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
  const [error,  setError]  = useState<string | null>(null)
  const queryClient = useQueryClient()

  async function save() {
    if (saving || saved) return
    setSaving(true)
    setError(null)
    try {
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !text.trim()) {
        throw new Error('Invalid selection range for this note.')
      }
      const created = await api.post<ReaderHighlight>(`/api/books/${bookId}/highlights`, {
        start, end, color, kind: 'note',
        text: text.slice(0, 800),
        note: note.trim() || null,
      })
      queryClient.setQueryData<ReaderPayload>(['reader', bookId], (prev) =>
        appendReaderHighlight(prev, {
          id: created.id,
          start: created.start,
          end: created.end,
          color: (created.color === 'rose' || created.color === 'sky' ? created.color : color),
          text: created.text,
          note: created.note ?? (note.trim() || null),
          kind: 'note',
        }),
      )
      queryClient.invalidateQueries({ queryKey: ['highlights', bookId] })
      queryClient.invalidateQueries({ queryKey: ['reader', bookId] })
      queryClient.invalidateQueries({ queryKey: ['books'] })
      setSaved(true)
      setSaving(false)
      setTimeout(onClose, 700)
    } catch (err) {
      console.error('Note save failed', err)
      setSaving(false)
      if (err instanceof AuthError) setError('Sign in to save notes')
      else setError(err instanceof Error ? err.message.slice(0, 100) : 'Could not save note')
    }
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
        {error && (
          <p className="text-xs text-red-500 leading-snug">{error}</p>
        )}
        <button
          onClick={() => void save()}
          disabled={saving || saved}
          className="w-full py-2.5 rounded-xl text-sm font-semibold text-white transition-all active:scale-[0.98] disabled:opacity-60 mb-2"
          style={{ backgroundColor: saved ? '#22c55e' : '#2383e2' }}
        >
          {saved ? '✓ Saved' : saving ? 'Saving…' : error ? 'Retry save' : 'Save Highlight & Note'}
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
  const { getStoredAuthToken } = await import('@/lib/auth')
  const { resolveApiUrl } = await import('@/shared/api/apiOrigin')
  const target = resolveApiUrl(url)

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

  const token = getStoredAuthToken()
  const res = await fire(token)

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
      } catch (err) {
        // Surface explicit stream errors; ignore only malformed payload lines.
        if (err instanceof Error && err.message && !err.message.includes('JSON')) {
          throw err
        }
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

function AssistantChat({ bookTitle, pageContext, colors }: {
  bookTitle: string
  pageContext: string
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
      style={{ color: colors.text, height: 360, paddingBottom: 'env(safe-area-inset-bottom,0px)' }}
    >
      {/* Context label */}
      <div className="flex items-center gap-1.5 px-4 pt-3 pb-2 shrink-0">
        <div className="w-2 h-2 rounded-full bg-[#2383e2] shrink-0" />
        <p
          className="text-[12.5px] font-medium line-clamp-1 max-w-[280px]"
          style={{ opacity: 0.55, fontFamily: 'Lora, Georgia, serif', fontStyle: 'italic' }}
        >
          {bookTitle}
        </p>
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

function AppearanceContent({ appearance, onChange }: {
  appearance: Appearance
  onChange: (patch: Partial<Appearance>) => void
}) {
  const colors = THEMES[appearance.theme]

  return (
    <div className="px-3.5 pt-2.5 space-y-3"
      style={{ color: colors.text, paddingBottom: 16 }}>

      {/* Font */}
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-widest opacity-40 mb-1">Font</p>
        <div className="flex gap-1.5">
          {(['serif', 'sans'] as const).map((f) => (
            <button key={f} onClick={() => onChange({ font: f })}
              className={cn('flex-1 py-2 rounded-lg border text-sm font-medium transition-all',
                appearance.font === f ? 'border-primary bg-primary text-white shadow-sm' : 'border-border/60 opacity-55 hover:opacity-90')}
              style={{ fontFamily: f === 'serif' ? 'Lora, Georgia, serif' : 'Inter, sans-serif' }}>
              {f === 'serif' ? 'Serif' : 'Sans'}
            </button>
          ))}
          <button
            onClick={() => onChange({ bionic: !appearance.bionic })}
            title="Bionic Reading — bold initial letters for faster reading"
            style={{
              flexShrink: 0,
              padding: '7px 15px',
              borderRadius: 12,
              fontSize: 13.5,
              fontFamily: 'Inter, sans-serif',
              cursor: 'pointer',
              outline: 'none',
              background: appearance.bionic ? '#2563eb' : '#ffffff',
              border: '1px solid rgba(0,0,0,0.08)',
              boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
            }}>
            <b style={{ fontWeight: 900, color: appearance.bionic ? '#ffffff' : '#080808' }}>B</b>
            <span style={{ color: appearance.bionic ? 'rgba(255,255,255,0.7)' : '#989695' }}>R</span>
          </button>
        </div>
      </div>

      {/* Font size */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <p className="text-[10px] font-semibold uppercase tracking-widest opacity-40">Size</p>
          <span className="text-[11px] opacity-40 tabular-nums">{appearance.fontSize}px</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => onChange({ fontSize: Math.max(14, appearance.fontSize - 1) })}
            disabled={appearance.fontSize <= 14}
            className="p-1 rounded-lg border border-border/60 opacity-55 hover:opacity-90 disabled:opacity-20">
            <Minus size={13} />
          </button>
          <Slider value={[appearance.fontSize]} min={14} max={22} step={1}
            onValueChange={(val) => onChange({ fontSize: Array.isArray(val) ? val[0] : (val as number) })}
            className="flex-1" />
          <button onClick={() => onChange({ fontSize: Math.min(22, appearance.fontSize + 1) })}
            disabled={appearance.fontSize >= 22}
            className="p-1 rounded-lg border border-border/60 opacity-55 hover:opacity-90 disabled:opacity-20">
            <Plus size={13} />
          </button>
        </div>
      </div>

      {/* Line spacing */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <p className="text-[10px] font-semibold uppercase tracking-widest opacity-40">Spacing</p>
          <span className="text-[11px] opacity-40 tabular-nums">{appearance.lineHeight.toFixed(1)}×</span>
        </div>
        <Slider value={[Math.round(appearance.lineHeight * 10)]} min={15} max={22} step={1}
          onValueChange={(val) => onChange({ lineHeight: (Array.isArray(val) ? val[0] : (val as number)) / 10 })} />
      </div>

      {/* Width */}
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-widest opacity-40 mb-1">Width</p>
        <div className="flex gap-1.5">
          {(['narrow', 'balanced', 'wide'] as const).map((w) => (
            <button key={w} onClick={() => onChange({ width: w })}
              className={cn('flex-1 py-2 rounded-lg border text-xs font-medium capitalize transition-all',
                appearance.width === w ? 'border-primary bg-primary text-white shadow-sm' : 'border-border/60 opacity-55 hover:opacity-90')}>
              {w}
            </button>
          ))}
        </div>
      </div>

      {/* Layout: continuous scroll vs paginated page-turn */}
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-widest opacity-40 mb-1">Layout</p>
        <div className="flex gap-1.5">
          {([
            { id: 'continuous' as const, label: 'Continuous', Icon: Rows3 },
            { id: 'paginated' as const, label: 'Paginated', Icon: BookOpen },
          ]).map(({ id, label, Icon }) => (
            <button
              key={id}
              onClick={() => onChange({ layout: id })}
              className={cn(
                'flex-1 py-2 rounded-lg border text-xs font-medium transition-all flex items-center justify-center gap-1.5',
                appearance.layout === id
                  ? 'border-primary bg-primary text-white shadow-sm'
                  : 'border-border/60 opacity-55 hover:opacity-90',
              )}
            >
              <Icon size={13} />
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Align + Theme on same row */}
      <div className="flex gap-3 pb-1">
        <div className="flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-widest opacity-40 mb-1">Align</p>
          <div className="flex gap-1">
            {([
              { id: 'left' as const,    Icon: AlignLeft    },
              { id: 'center' as const,  Icon: AlignCenter  },
              { id: 'justify' as const, Icon: AlignJustify },
            ]).map(({ id, Icon }) => (
              <button key={id} onClick={() => onChange({ align: id })}
                className={cn('flex-1 py-2 rounded-lg border flex items-center justify-center transition-all',
                  appearance.align === id ? 'border-primary bg-primary text-white shadow-sm' : 'border-border/60 opacity-55 hover:opacity-90')}>
                <Icon size={14} />
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-widest opacity-40 mb-1">Theme</p>
          <div className="flex gap-1">
            {([
              { id: 'paper' as const, bg: '#fbf8f4', fg: '#1c1c1e', title: 'Cream' },
              { id: 'white' as const, bg: '#eee2c6', fg: '#1f1a14', title: 'Paper' },
              { id: 'dark'  as const, bg: '#1a1a18', fg: '#e8e6e1', title: 'Dark' },
            ]).map(({ id, bg, fg, title }) => (
              <button key={id} onClick={() => onChange({ theme: id })}
                className={cn(
                  'flex-1 py-2 rounded-lg border text-xs font-medium transition-all',
                  id === 'white' && 'reader-theme-kindle',
                  appearance.theme === id ? 'ring-2 ring-primary ring-offset-1' : 'hover:opacity-80',
                )}
                style={{ backgroundColor: bg, color: fg, borderColor: `${fg}22` }}
                title={title}>
                <span className="flex flex-col items-center gap-0.5 leading-none">
                  <span style={{ fontFamily: 'Lora, serif', fontSize: 13 }}>Aa</span>
                  <span className="text-[9px] font-medium tracking-wide opacity-70">{title}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Play Bar ──────────────────────────────────────────────────────────────────
// Persistent bottom bar visible while audio is buffering / playing / paused.
// Lives outside the sheet so it stays visible when the sheet is closed.

interface AudioHandle {
  toggle: () => void
  stop: () => void
}

function PlayBar({ phase, curIdx, totalChunks, voiceLabel, rate, onRateChange, colors, handle, onOpenSheet, statusText, followPaused, onResumeFollow }: {
  phase:        AudioPhase
  curIdx:       number
  totalChunks:  number
  voiceLabel:   string
  rate:         number
  onRateChange: (r: number) => void
  colors:       typeof THEMES['paper']
  handle:       AudioHandle | null
  onOpenSheet:  () => void
  statusText?:  string | null
  /** User scrolled away — auto-scroll to the spoken line is paused. */
  followPaused?: boolean
  onResumeFollow?: () => void
}) {
  const isBuffering = phase === 'buffering'
  const isPlaying   = phase === 'playing'
  const primaryLabel = isBuffering
    ? 'Cancel audio'
    : isPlaying
      ? 'Pause audio'
      : 'Resume audio'
  const headline = isBuffering && statusText
    ? statusText
    : followPaused
      ? 'Playing (scroll free)'
      : 'Now playing'

  const progressPct = totalChunks > 1
    ? Math.round(((curIdx + (isPlaying ? 1 : 0)) / totalChunks) * 100)
    : isPlaying ? 35 : 0

  function nudgeRate(delta: number) {
    const next = Math.round(Math.max(0.5, Math.min(2.5, rate + delta)) * 10) / 10
    onRateChange(next)
  }

  return (
    <motion.div
      className="fixed z-40 flex items-center gap-2 px-3"
      style={{
        bottom: 0,
        left: '50%',
        height: 48,
        borderRadius: '10px 10px 0 0',
        backgroundColor: colors.bg,
        borderTop: `1px solid ${colors.text}12`,
        borderLeft: `1px solid ${colors.text}08`,
        borderRight: `1px solid ${colors.text}08`,
        boxShadow: '0 -2px 12px rgba(0,0,0,0.07)',
        maxWidth: 680,
        width: 'calc(100vw - 2rem)',
        transform: 'translateX(-50%)',
      }}
      initial={{ y: '100%', x: '-50%' }}
      animate={{ y: 0, x: '-50%' }}
      exit={{ y: '100%', x: '-50%' }}
      transition={{ type: 'spring', damping: 32, stiffness: 300 }}
    >
      {/* Left: info — clicking voice opens audio sheet */}
      <div className="flex flex-col shrink-0" style={{ minWidth: 100 }}>
        <span className="text-[10px] font-semibold leading-none" style={{ color: colors.text }}>
          {headline}
        </span>
        <div className="flex items-center gap-1 mt-0.5">
          {/* Voice name — opens audio sheet */}
          <button
            className="text-[11px] transition-opacity hover:opacity-100"
            style={{ color: `${colors.text}80` }}
            onClick={onOpenSheet}
            title="Change voice"
          >
            {voiceLabel}
          </button>
          <span style={{ color: `${colors.text}40`, fontSize: 10 }}>·</span>
          {/* Speed — − / value / + */}
          <div className="flex items-center gap-0.5">
            <button
              className="text-[12px] leading-none transition-opacity hover:opacity-100 px-0.5"
              style={{ color: `${colors.text}80` }}
              onClick={() => nudgeRate(-0.1)}
              title="Decrease speed"
            >
              −
            </button>
            <span className="text-[11px] tabular-nums" style={{ color: `${colors.text}80` }}>
              {rate.toFixed(1)}×
            </span>
            <button
              className="text-[12px] leading-none transition-opacity hover:opacity-100 px-0.5"
              style={{ color: `${colors.text}80` }}
              onClick={() => nudgeRate(0.1)}
              title="Increase speed"
            >
              +
            </button>
          </div>
        </div>
      </div>

      {/* Center: play button + progress bar */}
      <div className="flex items-center gap-2 flex-1 min-w-0">
        <button
          onClick={() => handle?.toggle()}
          disabled={!handle}
          aria-label={primaryLabel}
          title={primaryLabel}
          className="flex items-center justify-center active:scale-90 transition-transform disabled:opacity-40 shrink-0"
          style={{
            width: 26, height: 26, borderRadius: '50%',
            background: '#2383e2',
          }}
        >
          {isBuffering
            ? <div className="w-3 h-3 border-[1.5px] border-white border-t-transparent rounded-full animate-spin" />
            : isPlaying
              ? <Pause size={12} color="white" fill="white" />
              : <Play  size={12} color="white" fill="white" />
          }
        </button>

        {/* Progress track */}
        <div className="flex-1 h-[3px] rounded-full overflow-hidden" style={{ background: `${colors.text}15` }}>
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{ width: `${progressPct}%`, background: '#2383e2' }}
          />
        </div>
      </div>

      {followPaused && onResumeFollow && (
        <button
          type="button"
          onClick={onResumeFollow}
          className="shrink-0 rounded-md px-2 py-1 text-[10px] font-semibold transition-opacity hover:opacity-90"
          style={{
            background: 'rgba(35, 131, 226, 0.14)',
            color: '#2383e2',
          }}
          title="Keep the page scrolled to the line being read"
        >
          Follow
        </button>
      )}

      {/* Right: close */}
      <button
        onClick={() => handle?.stop()}
        className="flex items-center justify-center shrink-0 transition-opacity"
        style={{ width: 22, height: 22, opacity: 0.4 }}
        onMouseEnter={e => (e.currentTarget.style.opacity = '0.7')}
        onMouseLeave={e => (e.currentTarget.style.opacity = '0.4')}
        aria-label="Stop"
      >
        <X size={13} style={{ color: colors.text }} />
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

  const [appearance,    setAppearance]    = useState<Appearance>(() => loadBookSettings(bookId).appearance)
  const [sheet,         setSheet]         = useState<'none' | 'appearance' | 'audio' | 'chat'>('none')
  const [scrollPct,     setScrollPct]     = useState(0)
  const [pageIndex,     setPageIndex]     = useState(0)
  const [pageBreaks,    setPageBreaks]    = useState<ReaderPageBreak[]>([])
  const [barVisible,    setBarVisible]    = useState(true)
  const [selection,     setSelection]     = useState<SelectionState | null>(null)
  const [panel,         setPanel]         = useState<SecondaryPanel | null>(null)
  const [toast,         setToast]         = useState<string | null>(null)
  const [playbackRange, setPlaybackRange] = useState<{ start: number; end: number } | null>(null)
  const [rollingCacheState, setRollingCacheState] = useState<RollingCacheState>(() => getRollingCacheState())
  const [audioPrefs, setAudioPrefs] = useState(() => loadBookSettings(bookId).audioPrefs)
  const [audioRate,     setAudioRate]     = useState(() => loadBookSettings(bookId).audioRate)
  const settingsBookIdRef = useRef(bookId)
  const ttsProvider = audioPrefs.provider

  const lastScrollY           = useRef(0)
  const latestScrollPct       = useRef(0)
  const scrollTimer           = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveTimer             = useRef<ReturnType<typeof setTimeout> | null>(null)
  const justShowedMenu        = useRef(false)
  const scrolledToOffsetRef   = useRef(false)
  const activeAudioCueKeyRef    = useRef<string | null>(null)
  const activeAudioCueRangeRef  = useRef<{ start: number; end: number } | null>(null)
  /** True while we programmatically scroll to keep the cue in view — ignore for pause detection. */
  const programmaticScrollRef   = useRef(false)
  /** User scrolled away during playback — stop yanking the viewport back to the highlight. */
  const audioFollowPausedRef    = useRef(false)
  const [audioFollowPaused, setAudioFollowPaused] = useState(false)
  const presynthGridRef         = useRef<Array<{ start: number; end: number }> | null>(null)
  const readerTextRef         = useRef<HTMLDivElement | null>(null)
  const readerScrollRef       = useRef<HTMLDivElement | null>(null)
  const pageStageRef          = useRef<HTMLDivElement | null>(null)
  const pageLayerRef          = useRef<HTMLDivElement | null>(null)
  const pageInnerRef          = useRef<HTMLDivElement | null>(null)
  const incomingPageRef       = useRef<HTMLDivElement | null>(null)
  const layoutRef             = useRef<ReaderLayout>(appearance.layout)
  const pageIndexRef          = useRef(0)
  const pageBreaksRef         = useRef<ReaderPageBreak[]>([])
  const pendingPageOffsetRef  = useRef<number | null>(null)
  const prevLayoutRef         = useRef<ReaderLayout>(appearance.layout)
  const pageTurnRef           = useRef({
    tracking: false,
    axis: null as 'x' | 'y' | null,
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    lastT: 0,
    vx: 0,
    vy: 0,
    offset: 0,
    incomingDir: 0 as -1 | 0 | 1,
    animating: false,
    gen: 0,
  })
  layoutRef.current = appearance.layout
  pageIndexRef.current = pageIndex
  pageBreaksRef.current = pageBreaks
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
  const applyAudioSelection = useCallback((selection: AudioSelection) => {
    setAudioPrefs((current) => audioPrefsWithSelection(current, selection))
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
  const providerCatalog = normalizeTtsProviders(providersData?.providers)
  const activeProviderInfo = providerCatalog.find(p => p.id === ttsProvider)
  const kokoroProviderAvailable = providerCatalog.some(p => p.id === 'kokoro' && p.available)
  const fallbackProviderInfo = providersData?.providers
    ? pickFallbackProvider(providerCatalog)
    : null
  // Prefer Kokoro by default; only fall back when the selected engine is missing/unavailable.
  const useProviderFallback = Boolean(
    providersData?.providers
    && fallbackProviderInfo
    && (!activeProviderInfo || !activeProviderInfo.available),
  )
  const effectiveTtsProvider = useProviderFallback && fallbackProviderInfo ? fallbackProviderInfo.id : ttsProvider
  const selectedTtsVoice = resolvedVoiceForProvider(ttsProvider, activeProviderInfo, audioPrefs)
  const effectiveTtsVoice = useProviderFallback && fallbackProviderInfo
    ? resolvedVoiceForProvider(fallbackProviderInfo.id, fallbackProviderInfo, audioPrefs)
    : selectedTtsVoice
  const effectiveProviderInfo = providerCatalog.find(p => p.id === effectiveTtsProvider)
  const playBarVoiceLabel = effectiveProviderInfo
    ?.voices.find(v => v.id === effectiveTtsVoice)
    ?.label ?? effectiveTtsVoice ?? effectiveProviderInfo?.name ?? 'Voice'
  const {
    wordAudioPhase,
    wordAudioCurIdx,
    wordAudioTotal,
    wordAudioStatusText,
    playWord: playWordRaw,
    toggleWordAudio,
    stopWordAudio,
    isAudioActive,
    warmCloudAtOffset,
  } = useTtsSessionController({
    bookId,
    bookText: payload?.text ?? '',
    provider: effectiveTtsProvider,
    voice: effectiveTtsVoice,
    rate: audioRate,
    presynthGridRef,
    syncAudioFollowCue,
    clearAudioFollow,
    showToast,
  })
  // New Play always re-enables auto-follow so starting from a tap is natural.
  const playWord = useCallback(async (
    word: string,
    startOffset: number,
    reason?: 'voice-switch',
  ) => {
    audioFollowPausedRef.current = false
    setAudioFollowPaused(false)
    return playWordRaw(word, startOffset, reason)
  }, [playWordRaw])
  const hasReaderText = Boolean(payload?.text)

  function getReaderScrollMetrics() {
    const el = readerScrollRef.current
    if (el) {
      return {
        y: el.scrollTop,
        max: Math.max(0, el.scrollHeight - el.clientHeight),
        view: el.clientHeight,
      }
    }
    return {
      y: window.scrollY,
      max: Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
      view: window.innerHeight,
    }
  }

  function scrollReaderTo(top: number, behavior: ScrollBehavior = 'auto') {
    const el = readerScrollRef.current
    if (el) el.scrollTo({ top, behavior })
    else window.scrollTo({ top, behavior })
  }

  function scrollReaderBy(delta: number, behavior: ScrollBehavior = 'auto') {
    const el = readerScrollRef.current
    if (el) el.scrollBy({ top: delta, behavior })
    else window.scrollBy({ top: delta, behavior })
  }

  function getPagedChrome() {
    const frame = pageLayerRef.current ?? pageStageRef.current ?? readerScrollRef.current
    if (!frame) {
      return { headerH: READER_HEADER_HEIGHT, top: 0, viewH: Math.max(120, window.innerHeight - 140) }
    }
    const cs = getComputedStyle(frame)
    const pad = Number.parseFloat(cs.paddingTop || '0') + Number.parseFloat(cs.paddingBottom || '0')
    const viewH = Math.max(120, frame.clientHeight - pad)
    return { headerH: READER_HEADER_HEIGHT, top: 0, viewH }
  }

  function getPageViewHeight() {
    return getPagedChrome().viewH
  }

  function clipReaderText(root: HTMLElement | null, pageIndex: number) {
    if (!root) return
    const text = root.hasAttribute('data-reader-text')
      ? root
      : root.querySelector<HTMLElement>('[data-reader-text]')
    if (!text) return
    const { top, bottom } = pageClipRange(pageBreaksRef.current, pageIndex, getPageViewHeight())
    const height = Math.max(bottom, text.scrollHeight, text.offsetHeight)
    const insetBottom = Math.max(0, height - bottom)
    text.style.clipPath = `inset(${Math.max(0, top)}px 0 ${insetBottom}px 0)`
  }

  function clearReaderTextClip(root: HTMLElement | null) {
    if (!root) return
    const text = root.hasAttribute('data-reader-text')
      ? root
      : root.querySelector<HTMLElement>('[data-reader-text]')
    if (text) text.style.clipPath = ''
    else root.style.clipPath = ''
  }

  function clearIncomingPage() {
    const incoming = incomingPageRef.current
    if (!incoming) return
    incoming.innerHTML = ''
    incoming.style.visibility = 'hidden'
    incoming.style.transition = 'none'
    incoming.style.transform = 'translate3d(0, 0, 0)'
    incoming.dataset.dir = ''
  }

  function applyRestingPageTransform(page?: ReaderPageBreak) {
    const scroller = readerScrollRef.current
    if (scroller) scroller.scrollTop = 0
    const index = pageIndexRef.current
    const top = page?.top ?? pageBreaksRef.current[index]?.top ?? 0
    const inner = pageInnerRef.current
    const layer = pageLayerRef.current
    if (inner) {
      inner.style.transition = 'none'
      inner.style.transform = `translate3d(0, ${pageRestY(top)}px, 0)`
    }
    if (layer) {
      layer.style.transition = 'none'
      layer.style.transform = 'translate3d(0, 0, 0)'
      layer.style.boxShadow = 'none'
    }
    clipReaderText(readerTextRef.current, index)
    clearIncomingPage()
  }

  function clearPagedTransforms() {
    const inner = pageInnerRef.current
    const layer = pageLayerRef.current
    if (inner) {
      inner.style.transition = 'none'
      inner.style.transform = ''
    }
    if (layer) {
      layer.style.transition = 'none'
      layer.style.transform = ''
      layer.style.boxShadow = 'none'
    }
    clearReaderTextClip(readerTextRef.current)
    clearIncomingPage()
  }

  function mountIncomingPage(dir: 1 | -1, axis: 'x' | 'y' = 'x'): boolean {
    const host = incomingPageRef.current
    const inner = pageInnerRef.current
    const stage = pageStageRef.current
    const nextIndex = pageIndexRef.current + dir
    const page = pageBreaksRef.current[nextIndex]
    if (!host || !inner || !page) return false
    if (host.dataset.dir === String(dir) && host.firstChild) {
      clipReaderText(host, nextIndex)
      return true
    }
    host.innerHTML = ''
    const clone = inner.cloneNode(true) as HTMLElement
    clone.setAttribute('aria-hidden', 'true')
    clone.style.pointerEvents = 'none'
    clone.style.transition = 'none'
    clone.style.transform = `translate3d(0, ${pageRestY(page.top)}px, 0)`
    host.appendChild(clone)
    clipReaderText(clone, nextIndex)
    host.dataset.dir = String(dir)
    host.style.visibility = 'visible'
    host.style.transition = 'none'
    const size = axis === 'x'
      ? (stage?.clientWidth ?? window.innerWidth)
      : (stage?.clientHeight ?? window.innerHeight)
    host.style.transform = axis === 'x'
      ? `translate3d(${dir * size}px, 0, 0)`
      : `translate3d(0, ${dir * size}px, 0)`
    return true
  }

  function applyPageTurnOffset(offset: number, axis: 'x' | 'y') {
    const layer = pageLayerRef.current
    const incoming = incomingPageRef.current
    const stage = pageStageRef.current
    if (!layer || !stage) return
    const size = Math.max(1, axis === 'x' ? stage.clientWidth : stage.clientHeight)
    layer.style.transition = 'none'
    layer.style.transform = axis === 'x'
      ? `translate3d(${offset}px, 0, 0)`
      : `translate3d(0, ${offset}px, 0)`
    const progress = Math.min(1, Math.abs(offset) / size)
    layer.style.boxShadow = offset === 0
      ? 'none'
      : axis === 'x'
        ? `inset ${offset > 0 ? 16 : -16}px 0 22px rgba(0,0,0,${0.08 * progress})`
        : `inset 0 ${offset > 0 ? 16 : -16}px 22px rgba(0,0,0,${0.08 * progress})`
    const dir = offset === 0 ? pageTurnRef.current.incomingDir : (offset < 0 ? 1 : -1)
    if (dir !== 0 && incoming?.firstChild) {
      incoming.style.transition = 'none'
      incoming.style.transform = axis === 'x'
        ? `translate3d(${dir * size + offset}px, 0, 0)`
        : `translate3d(0, ${dir * size + offset}px, 0)`
    }
  }

  function commitPageIndex(next: number, reason: 'user' | 'follow' | 'restore') {
    const pages = pageBreaksRef.current
    const page = pages[next]
    if (!page) return

    if (reason === 'user' && isAudioActive() && !audioFollowPausedRef.current) {
      audioFollowPausedRef.current = true
      setAudioFollowPaused(true)
    }

    programmaticScrollRef.current = true
    pageIndexRef.current = next
    setPageIndex(next)

    const textLen = payload?.text.length ?? 0
    const pct = textLen > 0 ? Math.min(1, page.startOffset / textLen) : 0
    latestScrollPct.current = pct
    setScrollPct(pct)
    setBarVisible(true)

    if (reason === 'user') {
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => saveProgress(pct), 400)
    }

    window.setTimeout(() => {
      programmaticScrollRef.current = false
    }, 80)
  }

  function collectReaderLineBoxes(root: HTMLElement): ReaderLineBox[] {
    const paragraphs = Array.from(root.querySelectorAll<HTMLElement>('[data-reader-paragraph-start]'))
    const rootRect = root.getBoundingClientRect()
    const lines: ReaderLineBox[] = []

    for (const para of paragraphs) {
      const paraStart = Number(para.dataset.readerParagraphStart)
      if (!Number.isFinite(paraStart)) continue
      const range = document.createRange()
      range.selectNodeContents(para)
      const raw = Array.from(range.getClientRects())
        .filter((rect) => rect.width > 0 && rect.height > 0)
        .sort((a, b) => a.top - b.top || a.left - b.left)
      const merged: Array<{ top: number; bottom: number }> = []
      for (const rect of raw) {
        const top = Math.floor(rect.top - rootRect.top)
        const bottom = Math.ceil(rect.bottom - rootRect.top)
        const prev = merged[merged.length - 1]
        if (prev && Math.abs(top - prev.top) <= 3) {
          prev.bottom = Math.max(prev.bottom, bottom)
        } else {
          merged.push({ top, bottom })
        }
      }
      for (const line of merged) {
        lines.push({ ...line, startOffset: paraStart })
      }
    }

    return lines
  }

  function yForSourceOffset(offset: number): number | null {
    const root = readerTextRef.current
    const text = payload?.text ?? ''
    if (!root || !text) return null
    const start = Math.max(0, Math.min(offset, Math.max(0, text.length - 1)))
    const end = Math.min(text.length, start + 1)
    const range = domRangeForSourceOffsets(start, end, root)
    if (!range) return null
    const rect = range.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) return null
    return rect.top - root.getBoundingClientRect().top
  }

  async function revealPage(
    index: number,
    reason: 'user' | 'follow' | 'restore' = 'user',
    axis: 'x' | 'y' = 'x',
  ) {
    const pages = pageBreaksRef.current
    if (pages.length === 0) return
    const next = clampPageIndex(index, pages.length)
    const page = pages[next]
    if (!page) return
    const current = pageIndexRef.current
    const currentPage = pages[current]
    const instant = reason === 'restore'
      || prefersReducedMotion()
      || Math.abs(next - current) !== 1
      || !currentPage
      || reason === 'follow'

    if (instant) {
      commitPageIndex(next, reason)
      applyRestingPageTransform(page)
      return
    }

    const turn = pageTurnRef.current
    turn.tracking = false
    turn.gen += 1
    const gen = turn.gen
    turn.animating = true
    programmaticScrollRef.current = true
    const dir = (next > current ? 1 : -1) as 1 | -1
    pageLayerRef.current?.getAnimations().forEach((animation) => animation.cancel())
    incomingPageRef.current?.getAnimations().forEach((animation) => animation.cancel())
    pageInnerRef.current?.getAnimations().forEach((animation) => animation.cancel())

    try {
      if (axis === 'x') {
        const stage = pageStageRef.current
        const layer = pageLayerRef.current
        const incoming = incomingPageRef.current
        const width = Math.max(1, stage?.clientWidth ?? window.innerWidth)
        if (!mountIncomingPage(dir, 'x') || !layer || !incoming) {
          commitPageIndex(next, reason)
          applyRestingPageTransform(page)
          return
        }
        const distance = -dir * width - turn.offset
        const duration = pageTurnDurationMs(distance, turn.vx)
        turn.offset = -dir * width
        await Promise.all([
          animateTransform(layer, `translate3d(${-dir * width}px, 0, 0)`, duration),
          animateTransform(incoming, 'translate3d(0, 0, 0)', duration),
        ])
        if (pageTurnRef.current.gen !== gen) return
      } else {
        const stage = pageStageRef.current
        const layer = pageLayerRef.current
        const incoming = incomingPageRef.current
        const height = Math.max(1, stage?.clientHeight ?? window.innerHeight)
        if (!mountIncomingPage(dir, 'y') || !layer || !incoming) {
          commitPageIndex(next, reason)
          applyRestingPageTransform(page)
          return
        }
        const distance = -dir * height - turn.offset
        const duration = pageTurnDurationMs(distance, turn.vy)
        turn.offset = -dir * height
        await Promise.all([
          animateTransform(layer, `translate3d(0, ${-dir * height}px, 0)`, duration),
          animateTransform(incoming, 'translate3d(0, 0, 0)', duration),
        ])
        if (pageTurnRef.current.gen !== gen) return
      }

      commitPageIndex(next, reason)
      applyRestingPageTransform(page)
    } finally {
      if (pageTurnRef.current.gen === gen) {
        turn.animating = false
        turn.offset = 0
        turn.axis = null
        turn.incomingDir = 0
        turn.vx = 0
        turn.vy = 0
      }
    }
  }

  function goToPage(index: number, reason: 'user' | 'follow' | 'restore' = 'user') {
    void revealPage(index, reason, 'x')
  }

  function measurePagedLayout() {
    const root = readerTextRef.current
    if (!root || !payload?.text) return

    const prevClip = root.style.clipPath
    root.style.clipPath = 'none'
    const lines = collectReaderLineBoxes(root)
    const pages = pageBreaksFromLineBoxes(lines, getPageViewHeight())
    const unchanged = pages.length === pageBreaksRef.current.length
      && pages.every((page, i) => {
        const prev = pageBreaksRef.current[i]
        return prev != null
          && prev.top === page.top
          && prev.bottom === page.bottom
          && prev.startOffset === page.startOffset
      })
    if (!unchanged) {
      pageBreaksRef.current = pages
      setPageBreaks(pages)
    }

    const pending = pendingPageOffsetRef.current
    if (pending != null) pendingPageOffsetRef.current = null
    const offset = pending
      ?? activeAudioCueRangeRef.current?.start
      ?? Math.round(latestScrollPct.current * payload.text.length)
    const y = yForSourceOffset(offset)
    const next = y == null
      ? pageIndexForOffset(pages, offset)
      : pageIndexForY(pages, y)
    if (pageTurnRef.current.tracking || pageTurnRef.current.animating) {
      if (prevClip) root.style.clipPath = prevClip
      return
    }

    if (unchanged && next === pageIndexRef.current) {
      const page = pages[next]
      if (page) {
        programmaticScrollRef.current = true
        applyRestingPageTransform(page)
        window.setTimeout(() => { programmaticScrollRef.current = false }, 80)
      }
      return
    }
    goToPage(next, pending != null ? 'restore' : 'follow')
  }

  useEffect(() => {
    primeBrowserSpeechVoices()
  }, [])

  // Lock background scroll while Audio/Appearance sheet is open (iOS overscroll
  // otherwise moves the book page and "deforms" the fixed panel).
  useEffect(() => {
    if (sheet !== 'audio' && sheet !== 'appearance') return

    const html = document.documentElement
    const body = document.body
    const prevHtmlOverflow = html.style.overflow
    const prevBodyOverflow = body.style.overflow
    const prevBodyTouch = body.style.touchAction
    const scrollY = window.scrollY

    const scroller = readerScrollRef.current
    const prevScrollerOverflow = scroller?.style.overflow ?? ''
    html.style.overflow = 'hidden'
    body.style.overflow = 'hidden'
    body.style.touchAction = 'none'
    if (scroller) scroller.style.overflow = 'hidden'
    // Freeze position so iOS doesn't jump when overflow is restored.
    body.style.position = 'fixed'
    body.style.top = `-${scrollY}px`
    body.style.left = '0'
    body.style.right = '0'
    body.style.width = '100%'

    const allowScrollTarget = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return false
      // Only nested scrollers may move; backdrop/page must stay still.
      return Boolean(
        target.closest('[data-slot="select-content"]')
        || target.closest('[data-reader-sheet]'),
      )
    }

    const onTouchMove = (e: TouchEvent) => {
      if (allowScrollTarget(e.target)) return
      e.preventDefault()
    }
    document.addEventListener('touchmove', onTouchMove, { passive: false })

    return () => {
      document.removeEventListener('touchmove', onTouchMove)
      html.style.overflow = prevHtmlOverflow
      body.style.overflow = prevBodyOverflow
      body.style.touchAction = prevBodyTouch
      if (scroller) scroller.style.overflow = prevScrollerOverflow
      body.style.position = ''
      body.style.top = ''
      body.style.left = ''
      body.style.right = ''
      body.style.width = ''
      window.scrollTo(0, scrollY)
    }
  }, [sheet])

  useEffect(() => {
    const flush = () => {
      void flushPerformanceTelemetry()
    }
    window.addEventListener('pagehide', flush)
    window.addEventListener('beforeunload', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      window.removeEventListener('beforeunload', flush)
      flush()
    }
  }, [])

  // Restore scroll position — also handles ?offset= from notes navigation
  useEffect(() => {
    if (!payload?.text) return

    const applyOffset = (offset: number) => {
      const pct = payload.text.length ? Math.min(1, Math.max(0, offset / payload.text.length)) : 0
      latestScrollPct.current = pct
      setScrollPct(pct)
      if (appearance.layout === 'paginated') {
        pendingPageOffsetRef.current = offset
        if (pageBreaksRef.current.length > 0) {
          const y = yForSourceOffset(offset)
          const next = y == null ? 0 : pageIndexForY(pageBreaksRef.current, y)
          goToPage(next, 'restore')
        }
        return
      }
      const { max } = getReaderScrollMetrics()
      scrollReaderTo(pct * max, 'auto')
    }

    if (!scrolledToOffsetRef.current) {
      const params = new URLSearchParams(window.location.search)
      const offsetStr = params.get('offset')
      if (offsetStr !== null) {
        const offset = parseInt(offsetStr, 10)
        if (!isNaN(offset) && offset >= 0) {
          scrolledToOffsetRef.current = true
          applyOffset(offset)
          window.history.replaceState({}, '', window.location.pathname)
          return
        }
      }
    }

    if (scrolledToOffsetRef.current) return
    if (!progressData?.reading) return
    const { textStart, textLength } = progressData.reading
    if (!textLength) return
    scrolledToOffsetRef.current = true
    applyOffset(textStart)
  }, [progressData, payload?.text, appearance.layout])

  // Paginated: measure viewport pages when type, size, or book text changes.
  // ResizeObserver callbacks are the allowed setState path; do not setState
  // synchronously in this effect body (react-hooks/set-state-in-effect).
  useLayoutEffect(() => {
    const prev = prevLayoutRef.current
    prevLayoutRef.current = appearance.layout

    if (appearance.layout !== 'paginated') {
      if (pageBreaksRef.current.length > 0) {
        pageBreaksRef.current = []
      }
      clearPagedTransforms()
      if (prev === 'paginated' && payload?.text) {
        const { max } = getReaderScrollMetrics()
        programmaticScrollRef.current = true
        scrollReaderTo(latestScrollPct.current * max, 'auto')
        window.setTimeout(() => { programmaticScrollRef.current = false }, 80)
      }
      return
    }

    const scroller = readerScrollRef.current
    const text = readerTextRef.current
    if (!scroller) return
    const ro = new ResizeObserver(() => measurePagedLayout())
    ro.observe(scroller)
    if (text) ro.observe(text)
    const fonts = document.fonts
    const onFonts = () => measurePagedLayout()
    fonts?.addEventListener?.('loadingdone', onFonts)
    void fonts?.ready?.then(onFonts)
    return () => {
      ro.disconnect()
      fonts?.removeEventListener?.('loadingdone', onFonts)
    }
  }, [
    appearance.layout,
    appearance.fontSize,
    appearance.lineHeight,
    appearance.width,
    appearance.font,
    appearance.bionic,
    appearance.align,
    appearance.theme,
    payload?.text,
  ])

  useEffect(() => {
    if (appearance.layout !== 'paginated') return

    function onKey(e: KeyboardEvent) {
      if (sheet !== 'none' || panel) return
      const target = e.target
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return
      if ((target as HTMLElement | null)?.isContentEditable) return
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'PageDown') {
        e.preventDefault()
        goToPage(pageIndexRef.current + 1, 'user')
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp') {
        e.preventDefault()
        goToPage(pageIndexRef.current - 1, 'user')
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [appearance.layout, sheet, panel])

  // Finger-tracked page turns: follow the swipe, then spring to the next page.
  useEffect(() => {
    if (appearance.layout !== 'paginated') return
    const el = readerScrollRef.current
    if (!el) return

    const turn = pageTurnRef.current

    const onStart = (e: PointerEvent) => {
      if (!e.isPrimary || e.button !== 0 || sheet !== 'none' || panel || turn.animating) {
        turn.tracking = false
        return
      }
      turn.tracking = true
      turn.axis = null
      turn.startX = e.clientX
      turn.startY = e.clientY
      turn.lastX = e.clientX
      turn.lastY = e.clientY
      turn.lastT = performance.now()
      turn.vx = 0
      turn.vy = 0
      turn.offset = 0
      turn.incomingDir = 0
    }

    const onMove = (e: PointerEvent) => {
      if (!turn.tracking || !e.isPrimary) return
      if (dragRef.current.mode === 'selecting' || dragRef.current.mode === 'deciding') return
      if (sheet !== 'none' || panel) return
      const now = performance.now()
      const dt = Math.max(8, now - turn.lastT)
      const sampleX = (e.clientX - turn.lastX) / dt
      const sampleY = (e.clientY - turn.lastY) / dt
      turn.vx = turn.vx * 0.65 + sampleX * 0.35
      turn.vy = turn.vy * 0.65 + sampleY * 0.35
      turn.lastX = e.clientX
      turn.lastY = e.clientY
      turn.lastT = now

      const dx = e.clientX - turn.startX
      const dy = e.clientY - turn.startY
      if (!turn.axis) {
        turn.axis = lockPageTurnAxis(dx, dy)
        if (!turn.axis) return
      }
      if (e.cancelable) e.preventDefault()
      if (!el.hasPointerCapture(e.pointerId)) {
        try { el.setPointerCapture(e.pointerId) } catch { /* ignore */ }
      }
      window.getSelection()?.removeAllRanges()

      const pages = pageBreaksRef.current
      const canPrev = pageIndexRef.current > 0
      const canNext = pageIndexRef.current < pages.length - 1
      const axis = turn.axis
      const size = axis === 'x'
        ? Math.max(1, pageStageRef.current?.clientWidth ?? el.clientWidth)
        : Math.max(1, pageStageRef.current?.clientHeight ?? el.clientHeight)
      const raw = axis === 'x' ? dx : dy
      turn.offset = resistPageTurnOffset(raw, size, canPrev, canNext)
      const dir = turn.offset === 0 ? 0 : (turn.offset < 0 ? 1 : -1)
      if (dir !== 0 && dir !== turn.incomingDir) {
        turn.incomingDir = dir
        mountIncomingPage(dir, axis)
      }
      applyPageTurnOffset(turn.offset, axis)
    }

    const finishGesture = (clientX: number, clientY: number) => {
      if (!turn.tracking) return
      turn.tracking = false
      const axis = turn.axis
      turn.axis = null
      if (!axis || dragRef.current.mode === 'selecting') {
        applyRestingPageTransform(pageBreaksRef.current[pageIndexRef.current])
        turn.offset = 0
        turn.incomingDir = 0
        return
      }
      const pagesNow = pageBreaksRef.current
      const canPrev = pageIndexRef.current > 0
      const canNext = pageIndexRef.current < pagesNow.length - 1
      if (axis === 'x') {
        const width = Math.max(1, pageStageRef.current?.clientWidth ?? el.clientWidth)
        turn.offset = resistPageTurnOffset(clientX - turn.startX, width, canPrev, canNext)
      } else {
        const height = Math.max(1, el.clientHeight)
        turn.offset = resistPageTurnOffset(clientY - turn.startY, height, canPrev, canNext)
      }
      const velocity = axis === 'x' ? turn.vx : turn.vy
      const size = axis === 'x'
        ? Math.max(1, pageStageRef.current?.clientWidth ?? el.clientWidth)
        : Math.max(1, el.clientHeight)
      const pages = pageBreaksRef.current
      const dir = shouldCommitPageTurn({
        offset: turn.offset,
        velocity,
        size,
        canPrev: pageIndexRef.current > 0,
        canNext: pageIndexRef.current < pages.length - 1,
      })
      justShowedMenu.current = true
      if (dir === 0) {
        const current = pages[pageIndexRef.current]
        const duration = pageTurnDurationMs(turn.offset, velocity)
        const layer = pageLayerRef.current
        const incoming = incomingPageRef.current
        turn.animating = true
        const gen = ++turn.gen
        const restIncoming = axis === 'x'
          ? `translate3d(${(turn.incomingDir || 1) * size}px, 0, 0)`
          : `translate3d(0, ${(turn.incomingDir || 1) * size}px, 0)`
        const settle = layer
          ? Promise.all([
              animateTransform(layer, 'translate3d(0, 0, 0)', duration),
              incoming?.firstChild
                ? animateTransform(incoming, restIncoming, duration)
                : Promise.resolve(),
            ])
          : Promise.resolve()
        void settle.then(() => {
          if (pageTurnRef.current.gen !== gen) return
          applyRestingPageTransform(current)
          turn.animating = false
          turn.offset = 0
          turn.incomingDir = 0
        })
        return
      }
      void revealPage(pageIndexRef.current + dir, 'user', axis)
    }

    const onEnd = (e: PointerEvent) => {
      if (!e.isPrimary) return
      finishGesture(e.clientX, e.clientY)
    }

    el.addEventListener('pointerdown', onStart)
    el.addEventListener('pointermove', onMove, { passive: false })
    el.addEventListener('pointerup', onEnd)
    el.addEventListener('pointercancel', onEnd)

    let wheelAcc = 0
    let wheelTimer: ReturnType<typeof setTimeout> | null = null
    const onWheel = (e: WheelEvent) => {
      if (sheet !== 'none' || panel) return
      e.preventDefault()
      wheelAcc += e.deltaY
      if (wheelTimer) clearTimeout(wheelTimer)
      wheelTimer = setTimeout(() => { wheelAcc = 0 }, 280)
      if (wheelAcc > 36) {
        wheelAcc = 0
        goToPage(pageIndexRef.current + 1, 'user')
      } else if (wheelAcc < -36) {
        wheelAcc = 0
        goToPage(pageIndexRef.current - 1, 'user')
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })

    return () => {
      el.removeEventListener('pointerdown', onStart)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onEnd)
      el.removeEventListener('pointercancel', onEnd)
      el.removeEventListener('wheel', onWheel)
      if (wheelTimer) clearTimeout(wheelTimer)
    }
  }, [appearance.layout, sheet, panel, payload?.text])

  // Persist this book's voice, rate, and appearance. Switching books loads
  // that book's snapshot first so we never write the previous book onto it.
  useEffect(() => {
    if (!bookId) return
    if (settingsBookIdRef.current !== bookId) {
      const next = loadBookSettings(bookId)
      setAppearance(next.appearance)
      setAudioPrefs(next.audioPrefs)
      setAudioRate(next.audioRate)
      settingsBookIdRef.current = bookId
      return
    }
    saveBookSettings(bookId, { appearance, audioPrefs, audioRate })
  }, [bookId, appearance, audioPrefs, audioRate])

  // Rolling cache: subscribe to its progress for inline UI in the audio panel.
  useEffect(() => {
    return subscribeRollingCache(setRollingCacheState)
  }, [])

  // Voice or provider changed → the rolling cache was filling the OLD voice's
  // chunks. Stop it; the user will hit "Use this voice" again if they want the
  // new one cached. The cleanup also runs on unmount (route change), so the
  // queue never outlives the reader screen.
  useEffect(() => {
    return () => { cancelRollingCache() }
  }, [effectiveTtsProvider, effectiveTtsVoice, bookId])

  // "Use this voice" — start the background queue that walks the whole book
  // synth-and-persisting every chunk to IndexedDB. Voice-agnostic from the
  // worker's perspective; pacingFor gives Kokoro a slight stretch so prosody
  // doesn't sound rushed.
  const commitVoiceForBook = useCallback((selection?: { provider: string; voice: string | null }) => {
    const providerToCache = selection?.provider ?? effectiveTtsProvider
    const voiceToCache = selection ? selection.voice : effectiveTtsVoice
    if (!bookId || !payload?.text) return false
    if (providerToCache !== 'kokoro') return false
    if (!voiceToCache) return false
    if (!isModelReady()) return false
    const grid = presynthGridRef.current
    if (!grid || !grid.length) return false
    const { lengthScale } = pacingFor('kokoro')
    const speed = lengthScale > 0 ? 1 / lengthScale : 1
    // Start from the chunk the user is currently reading so the next plays
    // benefit first; the loop continues to the end of the book.
    const offset = Math.max(0, Math.floor(latestScrollPct.current * payload.text.length))
    let fromIdx = 0
    for (let i = 0; i < grid.length; i += 1) {
      if (grid[i].end > offset) { fromIdx = i; break }
    }
    return startRollingCache({
      bookId,
      voice: voiceToCache,
      speed,
      text: payload.text,
      grid,
      fromIdx,
    })
  }, [bookId, payload?.text, effectiveTtsProvider, effectiveTtsVoice])

  // Kokoro should be ready before the user presses play. Start the in-browser
  // rolling cache automatically as soon as the ONNX model is warm, prioritizing
  // the current reading position.
  useEffect(() => {
    if (!bookId || !payload?.text || effectiveTtsProvider !== 'kokoro' || !effectiveTtsVoice) return

    let stopped = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let unsubscribe: (() => void) | null = null

    const tryStart = () => {
      if (stopped) return
      if (commitVoiceForBook()) {
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        unsubscribe?.()
        unsubscribe = null
        return
      }
      if (!timer) {
        timer = setTimeout(() => {
          timer = null
          tryStart()
        }, 1500)
      }
    }

    tryStart()
    unsubscribe = subscribeModelStatus((state) => {
      if (state.status === 'ready') tryStart()
    })

    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      unsubscribe?.()
    }
  }, [bookId, payload?.text, effectiveTtsProvider, effectiveTtsVoice, commitVoiceForBook])

  useEffect(() => {
    if (!hasReaderText || !kokoroProviderAvailable) return
    let cancelled = false
    let timeoutId: ReturnType<typeof setTimeout> | null = null
    let idleId: number | null = null
    const warm = () => {
      if (!cancelled) startWarmup()
    }

    if ('requestIdleCallback' in window) {
      idleId = window.requestIdleCallback(warm, { timeout: 5000 })
    } else {
      timeoutId = setTimeout(warm, 3000)
    }

    return () => {
      cancelled = true
      if (idleId !== null) window.cancelIdleCallback(idleId)
      if (timeoutId) clearTimeout(timeoutId)
    }
  }, [hasReaderText, kokoroProviderAvailable])

  // Background warmup — fire as soon as a local provider is selected so the model is
  // loaded by the time the user opens the audio sheet. Fire-and-forget, no UI blocking.
  useEffect(() => {
    if (!['neutts_local', 'qwen_local'].includes(effectiveTtsProvider)) return
    if (!hasReaderText) return   // wait until book is loaded
    api.post('/api/providers/warmup', { provider: effectiveTtsProvider, voice: effectiveTtsVoice ?? null, model: null })
      .catch(() => { /* silent — warmup is best-effort */ })
  }, [effectiveTtsProvider, effectiveTtsVoice, hasReaderText])

  // Compute the presynthesis grid client-side the moment book text is available.
  // Prefers ending each chunk at a real sentence boundary (.!? + whitespace) within
  // ±40% of the target so the TTS engine doesn't render end-of-utterance prosody
  // mid-sentence. Must stay byte-for-byte identical to the backend
  // _chunk_text_for_presynth() in server/app.py so cache keys match exactly.
  useEffect(() => {
    if (!payload?.text || effectiveTtsProvider !== 'kokoro') {
      presynthGridRef.current = null
      return
    }
    const text = payload.text
    const GRID_SIZE = CHUNK_CHARS.kokoro ?? 160
    const minSize = Math.max(1, Math.floor(GRID_SIZE * 0.5))
    const maxSize = Math.floor(GRID_SIZE * 1.4)
    const grid: Array<{ start: number; end: number }> = []
    let pos = 0
    while (pos < text.length) {
      let end = Math.min(pos + GRID_SIZE, text.length)
      if (end < text.length) {
        const searchStart = pos + minSize
        const searchEnd = Math.min(pos + maxSize, text.length)
        let boundary = -1
        for (let i = searchEnd - 1; i >= searchStart; i -= 1) {
          const ch = text[i]
          if (ch === '.' || ch === '!' || ch === '?') {
            const nxt = i + 1 < text.length ? text[i + 1] : ' '
            if (/\s/.test(nxt)) {
              boundary = i + 2
              break
            }
          }
        }
        if (boundary > 0 && boundary <= text.length) {
          end = boundary
        } else if (!/\s/.test(text[end])) {
          const wsIdx = text.lastIndexOf(' ', end)
          if (wsIdx > pos) end = wsIdx + 1
        }
      }
      if (text.slice(pos, end).trim()) grid.push({ start: pos, end })
      pos = Math.max(end, pos + 1)
    }
    presynthGridRef.current = grid
  }, [payload?.text, effectiveTtsProvider])

  // Hosted Kokoro/Gemini: warm the viewport slice so Play often hits edge/IDB.
  // Immediate warm when the book opens; light debounce only on scroll moves.
  const aheadWarmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const didImmediateWarm = useRef(false)
  useEffect(() => {
    if (effectiveTtsProvider !== 'kokoro' && effectiveTtsProvider !== 'google') return
    if (!payload?.text || !bookId || !effectiveTtsVoice) return
    if (wordAudioPhase !== 'idle') return

    const runWarm = () => {
      const start = audioSliceStart(payload.text.length, scrollPct)
      warmCloudAtOffset(start)
    }

    if (!didImmediateWarm.current) {
      didImmediateWarm.current = true
      runWarm()
      return
    }

    if (aheadWarmTimer.current) clearTimeout(aheadWarmTimer.current)
    aheadWarmTimer.current = setTimeout(runWarm, 350)

    return () => {
      if (aheadWarmTimer.current) clearTimeout(aheadWarmTimer.current)
    }
  }, [
    effectiveTtsProvider,
    effectiveTtsVoice,
    payload?.text,
    bookId,
    scrollPct,
    wordAudioPhase,
    warmCloudAtOffset,
  ])

  // Unlock AudioContext on first gesture so Play doesn't stall on autoplay policy.
  useEffect(() => {
    const unlock = () => {
      try {
        const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        if (!Ctx) return
        const ctx = new Ctx()
        void ctx.resume().finally(() => { void ctx.close().catch(() => undefined) })
      } catch { /* ignore */ }
    }
    window.addEventListener('pointerdown', unlock, { once: true, passive: true })
    window.addEventListener('keydown', unlock, { once: true })
    return () => {
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
    }
  }, [])

  function patchAppearance(patch: Partial<Appearance>) {
    setAppearance(a => ({ ...a, ...patch }))
  }

  function saveProgress(pct: number) {
    if (!payload?.text || !bookId) return
    const textLength = payload.text.length
    const textStart  = Math.round(pct * textLength)
    const paged = layoutRef.current === 'paginated' && pageBreaksRef.current.length > 0
    const reading: ReadingProgress = {
      pageNumber: paged
        ? pageIndexRef.current + 1
        : Math.max(1, Math.round(pct * 100)),
      totalPages: paged ? pageBreaksRef.current.length : 100,
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
      if (layoutRef.current === 'paginated') return
      const { y, max } = getReaderScrollMetrics()
      const pct = max > 0 ? Math.min(1, y / max) : 0
      latestScrollPct.current = pct
      setScrollPct(pct)
      const activeCueRange = activeAudioCueRangeRef.current
      if (activeCueRange) {
        // Inline playback mark scrolls with the page — do not re-layout on scroll.
        if (!programmaticScrollRef.current && isAudioActive() && !audioFollowPausedRef.current) {
          audioFollowPausedRef.current = true
          setAudioFollowPaused(true)
        }
      }
      const goingDown = y > lastScrollY.current && y > 60
      setBarVisible(!goingDown)
      lastScrollY.current = y
      if (scrollTimer.current) clearTimeout(scrollTimer.current)
      scrollTimer.current = setTimeout(() => setBarVisible(true), 1500)
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => saveProgress(pct), 4000)
    }
    const scroller = readerScrollRef.current
    scroller?.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      scroller?.removeEventListener('scroll', onScroll)
      window.removeEventListener('scroll', onScroll)
    }
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
      if (effectiveTtsProvider === 'kokoro' || effectiveTtsProvider === 'google') {
        warmCloudAtOffset(state.startOffset)
      }
    } catch { /* swallow */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload?.text, scrollPct, effectiveTtsProvider, warmCloudAtOffset])

  const handleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (justShowedMenu.current) { justShowedMenu.current = false; return }

    if (selection) {
      setSelection(null)
      window.getSelection()?.removeAllRanges()
      return
    }

    // Single click → expand to word
    const word = getWordAtPoint(e.clientX, e.clientY)
    if (!word) {
      if (layoutRef.current === 'paginated' && !selection) {
        const x = e.clientX
        if (x < window.innerWidth * 0.18) goToPage(pageIndexRef.current - 1, 'user')
        else if (x > window.innerWidth * 0.82) goToPage(pageIndexRef.current + 1, 'user')
      }
      return
    }

    // Do NOT add to native selection → no browser selection toolbar appears
    // We show our own highlight overlay instead
    window.getSelection()?.removeAllRanges()

    const state = buildStateFromRange(word.range, 'word', word.text)
    if (!state) return

    // Show selection menu only — TTS starts from the Play action, not on tap.
    // Speculatively warm hosted Kokoro/Gemini so Play is often a cache hit.
    setSelection(state)
    if (effectiveTtsProvider === 'kokoro' || effectiveTtsProvider === 'google') {
      warmCloudAtOffset(state.startOffset)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, payload?.text, scrollPct, effectiveTtsProvider, warmCloudAtOffset])

  // ── Mobile drag-to-select ─────────────────────────────────────────────────
  // Touch a word and slide your finger across the sentence to grow the
  // selection word-by-word. Vertical drags fall through to native scroll.
  const dragRef = useRef<{
    startRange: Range | null
    startX: number
    startY: number
    mode: 'idle' | 'deciding' | 'selecting' | 'scrolling' | 'paging'
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

  const handleTouchEnd = useCallback((ev: React.TouchEvent<HTMLDivElement>) => {
    const r = dragRef.current
    if (r.mode === 'selecting') {
      // Selection state is already up-to-date from the last touchmove.
      // Mark so the trailing click event doesn't reset it.
      justShowedMenu.current = true
      setIsDragSelecting(false)
    } else if (r.mode === 'scrolling') {
      // Vertical scroll — suppress the trailing synthetic click that some browsers fire
      justShowedMenu.current = true
    } else if (r.mode === 'paging') {
      // Page turn is committed by the scroller swipe handler so the
      // finger-follow animation can settle on the same gesture.
      justShowedMenu.current = true
    } else if (r.mode === 'deciding' && ev.changedTouches.length > 0) {
      // Touch ended before onMove could classify it — if it moved at all, it was a scroll
      const t = ev.changedTouches[0]
      if (Math.hypot(t.clientX - r.startX, t.clientY - r.startY) > 5) {
        justShowedMenu.current = true
      }
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
        // If the gesture is mostly vertical, defer to scroll — or page-turn in paginated.
        if (Math.abs(dy) > Math.abs(dx) * 1.4 && Math.abs(dy) > 8) {
          r.mode = layoutRef.current === 'paginated' ? 'paging' : 'scrolling'
          return
        }
        r.mode = 'selecting'
        setIsDragSelecting(true)
      }

      if (r.mode === 'scrolling') return
      if (r.mode === 'paging') {
        if (e.cancelable) e.preventDefault()
        return
      }

      if (r.mode === 'selecting') {
        // touch-action: pan-y keeps vertical page scroll native. Only cancel
        // the horizontal sweep so the browser does not treat it as a pan.
        if (e.cancelable) e.preventDefault()
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

  // Audio follow stays in the route because it maps source offsets to DOM ranges.

  function clearAudioFollow() {
    activeAudioCueKeyRef.current = null
    activeAudioCueRangeRef.current = null
    setPlaybackRange(null)
    audioFollowPausedRef.current = false
    setAudioFollowPaused(false)
  }

  function resumeAudioFollow() {
    audioFollowPausedRef.current = false
    setAudioFollowPaused(false)
    const range = activeAudioCueRangeRef.current
    if (range) showAudioFollow(range.start, range.end, true)
  }

  function showAudioFollow(startOffset: number, endOffset: number, follow: boolean) {
    setPlaybackRange({ start: startOffset, end: endOffset })

    const root = readerTextRef.current
    if (!root) return

    const range = domRangeForSourceOffsets(startOffset, endOffset, root)
    if (!range) return

    const fallbackRect = range.getBoundingClientRect()
    if (fallbackRect.width === 0 && fallbackRect.height === 0) return

    const rects = selectionRectsFromRange(range, fallbackRect)

    // Respect user scroll: highlight still updates, viewport stays put.
    if (!follow || audioFollowPausedRef.current || rects.length === 0) return

    if (layoutRef.current === 'paginated') {
      const pages = pageBreaksRef.current
      if (pages.length === 0) return
      const y = Math.min(...rects.map((rect) => rect.top)) - root.getBoundingClientRect().top
      const next = pageIndexForY(pages, y + 0.5)
      if (next !== pageIndexRef.current) goToPage(next, 'follow')
      return
    }

    const top = Math.min(...rects.map((rect) => rect.top))
    const bottom = Math.max(...rects.map((rect) => rect.top + rect.height))
    const view = getReaderScrollMetrics().view
    const safeTop = view * 0.22
    const safeBottom = view * 0.72
    if (top >= safeTop && bottom <= safeBottom) return

    const centerY = (top + bottom) / 2
    const targetY = view * 0.42
    const delta = centerY - targetY
    if (Math.abs(delta) < 12) return

    programmaticScrollRef.current = true
    // Instant scroll avoids fighting the user's finger/wheel with smooth animation.
    scrollReaderBy(delta, 'auto')
    window.setTimeout(() => {
      programmaticScrollRef.current = false
    }, 80)
  }

  function syncAudioFollowCue(chunk: TtsAudioChunk, currentTime: number, follow: boolean) {
    const cues = (chunk.cues ?? []).filter((cue) => cue.end > cue.start)
    const activeCue = cues.find((cue, index) => {
      const cueStart = Math.max(0, cue.timeStart)
      const cueEnd = Math.max(cueStart, cue.timeEnd)
      const isLastCue = index === cues.length - 1
      return currentTime >= cueStart && (currentTime < cueEnd || (isLastCue && currentTime <= cueEnd + 0.2))
    }) ?? (cues.length
      ? (currentTime < cues[0].timeStart ? cues[0] : cues[cues.length - 1])
      : null)

    const cueStart = activeCue?.start ?? chunk.start
    const cueEnd = activeCue?.end ?? chunk.end
    const phrase = expandToReadingPhrase(cueStart, cueEnd, payload?.text ?? '')
    const nextKey = `${phrase.start}:${phrase.end}`

    activeAudioCueRangeRef.current = { start: phrase.start, end: phrase.end }
    if (activeAudioCueKeyRef.current === nextKey) return

    activeAudioCueKeyRef.current = nextKey
    showAudioFollow(phrase.start, phrase.end, follow && !audioFollowPausedRef.current)
  }
  // ── Derived ───────────────────────────────────────────────────────────────

  const colors     = THEMES[appearance.theme]
  const fontFamily = appearance.font === 'serif'
    ? 'Lora, Georgia, serif'
    : '"Inter Variable", Inter, system-ui, sans-serif'
  const paragraphs = useMemo(
    () => buildReaderParagraphs(payload?.text ?? ''),
    [payload?.text],
  )
  const readerHighlights = useMemo(
    () => (payload?.highlights ?? []).filter((h) => h.end > h.start),
    [payload?.highlights],
  )
  const readPct = Math.round(scrollPct * 100)
  const paginated = appearance.layout === 'paginated'
  const pageCount = Math.max(1, pageBreaks.length)
  const pageLabel = pageBreaks.length > 0
    ? `${pageIndex + 1} / ${pageCount}`
    : '—'
  const activePlayBarPhase = wordAudioPhase
  const activePlayBarCurIdx = wordAudioCurIdx
  const activePlayBarTotal = wordAudioTotal
  const activePlayBarHandle = wordAudioPhase !== 'idle'
    ? { toggle: toggleWordAudio, stop: stopWordAudio }
    : null

  return (
    <div
      data-reader-layout={appearance.layout}
      data-reader-theme={appearance.theme}
      className={cn(
        'h-svh flex flex-col overflow-hidden',
        appearance.theme === 'white' && 'reader-theme-kindle',
      )}
      style={{
        backgroundColor: colors.bg,
        color: colors.text,
        maxWidth: '100vw',
      }}
    >
      {/* ── Top bar (full-width) ──────────────────────────────────── */}
      <header
        data-reader-header=""
        className={cn(
          'z-40 flex items-center px-3 shrink-0 overflow-hidden',
          paginated ? 'relative' : 'fixed top-0 left-0 right-0',
        )}
        style={{
          height: 'calc(52px + env(safe-area-inset-top, 0px))',
          paddingTop: 'env(safe-area-inset-top, 0px)',
          backgroundColor: appearance.theme === 'white' && !paginated
            ? 'rgba(238,226,198,0.78)'
            : colors.bg,
          backgroundImage: 'none',
          backdropFilter: paginated ? 'none' : 'blur(14px)',
          WebkitBackdropFilter: paginated ? 'none' : 'blur(14px)',
          isolation: 'isolate',
          borderBottom: `1px solid ${colors.text}12`,
          opacity: paginated || barVisible ? 1 : 0,
          transform: paginated || barVisible ? 'translateY(0)' : 'translateY(-14px)',
          transition: 'opacity 200ms, transform 200ms',
          pointerEvents: paginated || barVisible ? 'auto' : 'none',
        }}
      >
        {/* Left: back to library */}
        <div className="flex items-center flex-1">
          <Link
            to="/library"
            className="flex items-center gap-1 px-2 py-1.5 rounded-lg transition-opacity opacity-60 hover:opacity-100 shrink-0"
            style={{ color: colors.text, fontSize: 13 }}
            aria-label="Back to Library"
          >
            <ChevronLeft size={15} />
            Library
          </Link>
        </div>

        {/* Center: title + progress (absolutely centered) */}
        <div className="absolute left-1/2 -translate-x-1/2 flex flex-col items-center pointer-events-none" style={{ minWidth: 0 }}>
          <span
            className="text-[13px] font-medium truncate"
            style={{ fontFamily: 'Lora, Georgia, serif', color: colors.text, maxWidth: 'min(200px, calc(100vw - 220px))' }}
          >
            {payload?.book.title ?? ''}
          </span>
          <span className="text-[10.5px]" style={{ color: `${colors.text}80` }}>
            {paginated ? pageLabel : `${readPct}%`}
          </span>
        </div>

        {/* Right: icon buttons */}
        <div className="flex items-center gap-0.5 flex-1 justify-end">
          <button
            onClick={() => setSheet(s => s === 'chat' ? 'none' : 'chat')}
            className="flex items-center justify-center rounded-lg transition-all"
            style={{
              width: 34, height: 34,
              background: sheet === 'chat' ? `${colors.text}12` : 'transparent',
              color: sheet === 'chat' ? colors.text : `${colors.text}80`,
            }}
            aria-label="Assistant"
          >
            <MessageSquare size={15} />
          </button>
          <button
            onClick={() => setSheet(s => s === 'audio' ? 'none' : 'audio')}
            className="flex items-center justify-center rounded-lg transition-all"
            style={{
              width: 34, height: 34,
              background: sheet === 'audio' ? `${colors.text}12` : 'transparent',
              color: sheet === 'audio' ? colors.text : `${colors.text}80`,
            }}
            aria-label="Audio"
          >
            <Volume2 size={15} />
          </button>
          <button
            onClick={() => setSheet(s => s === 'appearance' ? 'none' : 'appearance')}
            className="flex items-center justify-center rounded-lg transition-all"
            style={{
              width: 34, height: 34,
              background: sheet === 'appearance' ? `${colors.text}12` : 'transparent',
              color: sheet === 'appearance' ? colors.text : `${colors.text}80`,
            }}
            aria-label="Appearance"
          >
            <Settings2 size={15} />
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

      {/* ── Scrollable / paged text ───────────────────────────────────── */}
      <div
        ref={readerScrollRef}
        className={cn(
          'min-h-0 flex-1 overflow-x-hidden overscroll-y-contain',
          paginated ? 'overflow-y-hidden mb-24' : 'overflow-y-auto',
        )}
        style={{
          touchAction: paginated ? 'none' : 'pan-y',
          WebkitOverflowScrolling: paginated ? 'auto' : 'touch',
          overflow: paginated ? 'hidden' : undefined,
          userSelect: paginated ? 'none' : undefined,
          WebkitUserSelect: paginated ? 'none' : undefined,
        }}
      >
      <div
        ref={pageStageRef}
        className={cn(paginated && 'reader-page-stage relative h-full overflow-hidden')}
      >
        {paginated && (
          <div
            ref={incomingPageRef}
            className="reader-page-incoming absolute inset-0 overflow-hidden pointer-events-none"
            aria-hidden
            style={{ visibility: 'hidden' }}
          />
        )}
      <div
        ref={pageLayerRef}
        className={cn(paginated && 'reader-page-current relative h-full overflow-hidden')}
      >
      <div
        ref={pageInnerRef}
        className={cn(
          'reader-page-inner mx-auto px-5',
          paginated ? 'pb-4' : 'pb-36 transition-[max-width,padding] duration-200',
        )}
        style={{
          paddingTop: paginated ? 0 : 'calc(72px + env(safe-area-inset-top, 0px))',
          maxWidth: `${WIDTH_PX[appearance.width]}px`,
          WebkitTouchCallout: 'none',  // suppress iOS long-press callout
          touchAction: paginated ? 'none' : 'pan-y',
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
          <div ref={readerTextRef} data-reader-text="" style={{ fontFamily, fontSize: `${appearance.fontSize}px`, lineHeight: appearance.lineHeight, textAlign: appearance.align, color: colors.text, overflowWrap: 'break-word', wordBreak: 'break-word' }}>
            <ReaderParagraphs
              paragraphs={paragraphs}
              bionic={appearance.bionic}
              highlights={readerHighlights}
              playback={playbackRange}
              playbackColor={colors.playback}
              virtualize={!paginated}
            />
          </div>
        )}
      </div>
      </div>
      </div>
      </div>

      {/* ── Bottom progress bar (floating pill) ─────────────────────── */}
      <div
        className="fixed z-40 flex items-center gap-2.5 px-3"
        style={{
          bottom: 'calc(18px + env(safe-area-inset-bottom, 0px))',
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
          onClick={() => paginated
            ? goToPage(pageIndex - 1, 'user')
            : scrollReaderBy(-Math.round(getReaderScrollMetrics().view * 0.8), 'smooth')}
          className="flex items-center justify-center w-8 h-8 rounded-full shrink-0 hover:opacity-55 transition-opacity disabled:opacity-25"
          style={{ color: colors.text }}
          aria-label={paginated ? 'Previous page' : 'Scroll up'}
          disabled={paginated && pageIndex <= 0}
        >
          <ChevronLeft size={16} />
        </button>

        <div
          className="flex-1 h-[3px] rounded-full"
          style={{ background: `${colors.text}18` }}
        >
          <div
            className="h-full rounded-full transition-all duration-300"
            style={{
              width: `${paginated ? Math.round(((pageIndex + 1) / pageCount) * 100) : readPct}%`,
              background: colors.text,
            }}
          />
        </div>

        <span
          className="text-[11px] shrink-0 tabular-nums"
          style={{ color: `${colors.text}80`, fontFamily: '"Inter", system-ui, sans-serif' }}
        >
          {paginated ? pageLabel : `${readPct}%`}
        </span>

        <button
          onClick={() => paginated
            ? goToPage(pageIndex + 1, 'user')
            : scrollReaderBy(Math.round(getReaderScrollMetrics().view * 0.8), 'smooth')}
          className="flex items-center justify-center w-8 h-8 rounded-full shrink-0 hover:opacity-55 transition-opacity disabled:opacity-25"
          style={{ color: colors.text }}
          aria-label={paginated ? 'Next page' : 'Scroll down'}
          disabled={paginated && pageIndex >= pageCount - 1}
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
            onWarmAtOffset={(offset) => {
              if (effectiveTtsProvider === 'kokoro' || effectiveTtsProvider === 'google') {
                warmCloudAtOffset(offset)
              }
            }}
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
            <DictionaryPanel word={p.word} bookId={bookId} onClose={closePanel} colors={colors} />
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

      {/* ── Reader Popover (Audio / Appearance) ──────────────────────── */}
      {(() => {
        const isOpen = sheet === 'audio' || sheet === 'appearance'

        const TABS: Array<{ id: 'audio' | 'appearance'; label: string; Icon: typeof Volume2 }> = [
          { id: 'audio',      label: 'Audio',      Icon: Volume2 },
          { id: 'appearance', label: 'Appearance', Icon: Settings2 },
        ]

        return (
          <>
            {/* Backdrop — catch clicks and block background pan on mobile */}
            <div
              className="fixed inset-0 z-[200]"
              style={{
                pointerEvents: isOpen ? 'all' : 'none',
                touchAction: isOpen ? 'none' : undefined,
              }}
              onClick={() => setSheet('none')}
            />

            {/* Panel */}
            <div
              data-reader-sheet=""
              className="fixed z-[201] flex flex-col overflow-hidden"
              style={{
                bottom: 'calc(20px + env(safe-area-inset-bottom, 0px))',
                right: 14,
                width: 'min(380px, calc(100vw - 28px))',
                maxHeight: 'calc(100dvh - 100px)',
                borderRadius: 14,
                backgroundColor: colors.bg,
                border: `1px solid ${colors.text}10`,
                boxShadow: '0 8px 32px rgba(0,0,0,0.14), 0 2px 8px rgba(0,0,0,0.08)',
                transformOrigin: 'bottom right',
                transform: isOpen ? 'scale(1) translateY(0)' : 'scale(0.88) translateY(12px)',
                opacity: isOpen ? 1 : 0,
                pointerEvents: isOpen ? 'all' : 'none',
                transition: 'transform 220ms cubic-bezier(0.32,0.72,0,1), opacity 180ms ease',
                overscrollBehavior: 'contain',
              }}
            >
              {/* Tab header */}
              <div className="flex items-center justify-between p-2.5 flex-shrink-0" style={{ paddingBottom: 0 }}>
                <div className="flex rounded-lg p-0.5" style={{ background: `${colors.text}08` }}>
                  {TABS.map(({ id, label, Icon }) => (
                    <button
                      key={id}
                      onClick={() => setSheet(s => (s === id ? 'none' : id) as typeof s)}
                      className="flex items-center gap-1 px-2.5 py-1 text-[12px] font-medium rounded-md transition-all whitespace-nowrap"
                      style={{
                        background: sheet === id ? colors.bar : 'transparent',
                        color: sheet === id ? colors.text : `${colors.text}80`,
                        boxShadow: sheet === id ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
                      }}
                    >
                      <Icon size={12} /> {label}
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => setSheet('none')}
                  className="flex items-center justify-center rounded-full transition-all"
                  style={{
                    width: 28, height: 28,
                    border: `1px solid ${colors.text}18`,
                    background: `${colors.text}08`,
                    color: `${colors.text}80`,
                  }}
                  aria-label="Close"
                >
                  <ChevronDown size={14} />
                </button>
              </div>

              {/* Content area */}
              {isOpen && (
                <div
                  className="overflow-y-auto overscroll-y-contain"
                  style={{ flex: 1, overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch' }}
                >
                  <div style={{ display: sheet === 'audio' ? 'block' : 'none' }}>
                    <AudioPreviewPanel
                      key={`${effectiveTtsProvider}:${effectiveTtsVoice ?? ''}`}
                      colors={colors}
                      provider={effectiveTtsProvider}
                      voice={effectiveTtsVoice}
                      onSelectionChange={applyAudioSelection}
                      onError={showToast}
                      rate={audioRate}
                      onRateChange={setAudioRate}
                      onCommitVoice={commitVoiceForBook}
                      rollingCacheState={rollingCacheState}
                      currentBookId={bookId ?? null}
                    />
                  </div>
                  <div style={{ display: sheet === 'appearance' ? 'block' : 'none' }}>
                    <AppearanceContent
                      appearance={appearance}
                      onChange={patchAppearance}
                    />
                  </div>
                </div>
              )}
            </div>
          </>
        )
      })()}

      {/* ── Assistant chat sheet (separate) ──────────────────────────── */}
      {sheet === 'chat' && (() => {
        const ft  = payload?.text ?? ''
        const mid = Math.floor(scrollPct * ft.length)
        const ctx = ft.slice(Math.max(0, mid - 1000), Math.min(ft.length, mid + 1000))
        return (
          <BottomSheet open onClose={() => setSheet('none')} bg={colors.bg}>
            <AssistantChat
              bookTitle={payload?.book.title ?? 'this book'}
              pageContext={ctx}
              colors={colors}
            />
          </BottomSheet>
        )
      })()}

      {/* ── Play bar (visible while audio is active) ──────────────────── */}
      <AnimatePresence>
        {activePlayBarPhase !== 'idle' && (
          <PlayBar
            phase={activePlayBarPhase}
            curIdx={activePlayBarCurIdx}
            totalChunks={activePlayBarTotal}
            statusText={wordAudioStatusText}
            voiceLabel={playBarVoiceLabel}
            rate={audioRate}
            onRateChange={setAudioRate}
            colors={colors}
            handle={activePlayBarHandle}
            onOpenSheet={() => setSheet('audio')}
            followPaused={audioFollowPaused}
            onResumeFollow={resumeAudioFollow}
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
