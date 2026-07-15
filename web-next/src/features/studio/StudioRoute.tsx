import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { BookOpen, Check, Circle, Sparkles, X } from 'lucide-react'
import { api } from '@/shared/api/client'
import { isVocabWord, isUsableDefinition } from './vocabUtils'
import {
  aggregateSessionResults,
  buildDefinitionMcqOptions,
  buildRemedialStep,
  buildSmartSessionPlan,
  objectiveResultToRating,
  pickDistractors,
  prioritizeWordsForMode,
  sessionAccuracy,
  sessionLimitForMode,
  worseRating,
  type ExerciseKind,
  type Rating as PlanRating,
  type SessionMode,
} from './sessionPlan'
import { StudioHeader, useStudioSummary } from './StudioHeader'
import { speakStudioText } from './studioVoice'
import {
  formatStudyDefinition,
  isFabricatedContextSentence,
  isRealBookSentence,
  lookupWordDefinition,
  shouldRefreshDefinition,
} from '@/shared/storage/dictionaryLookup'

const C = {
  bg: 'transparent',
  surface: 'rgba(255,255,255,0.55)',
  card: '#ffffff',
  cardHi: '#f8f8f8',
  border: 'rgba(0,0,0,0.08)',
  borderHi: 'rgba(0,0,0,0.14)',
  gold: '#f47b24',
  goldDim: '#d4651a',
  cream: '#111111',
  text: '#1a1a1a',
  muted: '#9ca3af',
  mutedHi: '#6b7280',
  green: '#16a34a',
  amber: '#f59e0b',
  red: '#dc2626',
  violet: '#7c3aed',
  blue: '#2563eb',
  orange: '#f47b24',
}
const GRAD = '#faf7f2'
const CARD_SHADOW = '0 2px 16px rgba(0,0,0,0.07), 0 1px 4px rgba(0,0,0,0.05)'

const FONT = {
  display: 'Lora, "Iowan Old Style", Palatino, Georgia, serif',
  ui: '"Inter Variable", Inter, -apple-system, "Helvetica Neue", sans-serif',
  mono: '"SF Mono", "JetBrains Mono", Consolas, monospace',
}

type Rating = 'again' | 'hard' | 'good' | 'easy'

interface VocabCheck {
  verdict: 'correct' | 'partial' | 'incorrect'
  feedback: string
  suggestion?: string | null
}

async function aiCheckVocab(payload: {
  mode: 'sentence' | 'definition' | 'mnemonic'
  word: string
  definition: string
  userInput: string
  bookSentence?: string | null
}): Promise<VocabCheck> {
  return api.post<VocabCheck>('/api/ai/vocab-check', {
    mode: payload.mode,
    word: payload.word,
    definition: payload.definition,
    user_input: payload.userInput,
    book_sentence: payload.bookSentence ?? null,
  })
}

interface CoachHistoryItem {
  role: 'assistant' | 'learner'
  text: string
  step: string
}

interface CoachResponse {
  provider: string
  verdict: 'correct' | 'close' | 'incorrect'
  feedbackTitle: string
  feedbackBody: string
  correction: string
  nextPrompt: string
  suggestedRating: Rating
  canRate: boolean
  turnCount: number
}

async function coachCard(cardId: string, body: {
  mode: 'review' | 'lesson'
  step: 'answer' | 'retry' | 'usage'
  turnIndex: number
  learnerResponse: string
  history: CoachHistoryItem[]
}): Promise<CoachResponse> {
  return api.post<CoachResponse>(`/api/vocabulary/cards/${cardId}/coach`, body)
}

function coachToVocabCheck(coach: CoachResponse): VocabCheck {
  const verdict: VocabCheck['verdict'] = coach.verdict === 'close' ? 'partial' : coach.verdict
  return {
    verdict,
    feedback: [coach.feedbackTitle, coach.feedbackBody].filter(Boolean).join(' ').trim() || coach.feedbackBody,
    suggestion: coach.nextPrompt || null,
  }
}

interface ProductionSentenceNote {
  sentence: string
  accepted: boolean
  note: string
}

interface ProductionResponse {
  cardId: string
  accepted: boolean
  provider: string
  feedback: string
  sentenceNotes: ProductionSentenceNote[]
  productionCount: number
  sentences: string[]
}

async function submitCardProduction(cardId: string, sentences: string[]): Promise<ProductionResponse> {
  return api.post<ProductionResponse>(`/api/vocabulary/cards/${cardId}/production`, { sentences })
}

interface CardContext {
  source: string
  term: string
  pronunciation: string | null
  definition: string
  contextTitle: string
  contextParagraph: string
  usageFocus: string[]
  practicePrompts: string[]
}

async function fetchCardContext(cardId: string, refreshHint?: string | null): Promise<CardContext> {
  return api.post<CardContext>(`/api/vocabulary/cards/${cardId}/context`, {
    refreshHint: refreshHint ?? null,
  })
}

type CardState = 'new' | 'learning' | 'review' | 'relearning'
type ExerciseType = ExerciseKind
type Screen = 'dashboard' | 'practice' | 'results'

const AVAILABLE_EXERCISES: ExerciseKind[] = [
  'mcq', 'cloze', 'mnemonic', 'recall', 'write-sentence', 'write-definition',
  'reverse-recall', 'listening',
]

interface DeckSummary {
  id: string
  title: string
  cardCount: number
  noteCount: number
  dueNow: number
  dueToday: number
  newAvailable: number
  newIntroducedToday: number
  reviewsCompletedToday: number
  nextDueAt: string | null
  cardsByState: Record<CardState, number>
}

interface VocabNoteCard {
  id: string
  cardType: 'basic' | 'reverse' | 'cloze'
  state: CardState
  cue: string
  answer: string
  dueAt: string
  scheduledDays: number
  reps: number
  lapses: number
}

interface VocabNote {
  id: string
  front: string
  back: string | null
  extra: string | null
  hint: string | null
  explanation: string | null
  exampleSentence: string | null
  topic: string | null
  sourceBookTitle: string | null
  mnemonic: string | null
  cards: VocabNoteCard[]
}

interface DeckDashboard {
  deck: DeckSummary
  notes: VocabNote[]
  analytics?: {
    cardsLearned?: number
    rollingRetention7d?: number | null
  }
}

interface SessionCard {
  id: string
  deckId: string
  noteId: string
  cardType: 'basic' | 'reverse' | 'cloze'
  state: CardState
  cue: string
  answer: string
  extra: string | null
  hint: string | null
  explanation: string | null
  exampleSentence: string | null
  pronunciation: string | null
  mnemonic: string | null
  topic: string | null
  sourceBookTitle: string | null
  productionTarget: string | null
  ratingPreview: Record<Rating, { dueAt: string; label: string; state: CardState }>
  debug?: { scheduledDays?: number | null }
}

interface PracticeWord {
  id: string
  noteId: string
  word: string
  phonetic: string | null
  definition: string
  sentence: string
  book: string
  chapter: string | null
  stage: CardState
  interval: number
  ease: number
  mnemonic: string | null
  card: SessionCard
}

interface SavedWord {
  id: string
  word: string
  definition: string
  book: string
  stage: CardState
  mnemonic: string | null
}

interface PracticeStep {
  id: string
  word: PracticeWord
  exercise: ExerciseType
}

interface PracticeResult {
  stepId: string
  wordId: string
  word: string
  exercise: ExerciseType
  correct: boolean
  rating?: Rating
}

interface StepCompletePayload {
  correct: boolean
  rating?: Rating
  mnemonic?: string
  typedResponse?: string
  hintsUsed?: number
  attempts?: number
}

interface PracticeSessionResponse {
  deck?: DeckSummary
  focus?: string
  items?: SessionCard[]
  /** Older worker shape */
  cards?: SessionCard[]
}

interface ReviewResponse {
  summary: DeckSummary
  nextCard: SessionCard | null
  xpAwarded?: number
  rating?: Rating
}

function xpForRatingClient(rating: Rating | null | undefined): number {
  if (rating === 'easy') return 20
  if (rating === 'good') return 15
  if (rating === 'hard') return 10
  if (rating === 'again') return 5
  return 0
}

function progressPercent(progress: number) {
  return `${Math.min(100, Math.max(0, progress * 100))}%`
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function speak(text: string) {
  void speakStudioText(text)
}

function computeIntervals(card: SessionCard | PracticeWord) {
  const source = 'card' in card ? card.card : card
  const preview = source.ratingPreview
  if (preview) {
    return {
      again: preview.again?.label ?? '<10m',
      hard: preview.hard?.label ?? '6m',
      good: preview.good?.label ?? '10m',
      easy: preview.easy?.label ?? '4d',
    }
  }
  const i = 'interval' in card ? card.interval || 0 : 0
  const ease = 'ease' in card ? card.ease || 2.5 : 2.5
  if (i === 0) return { again: '<1m', hard: '6m', good: '10m', easy: '4d' }
  return {
    again: '<10m',
    hard: `${Math.max(1, Math.round(i * 1.2))}d`,
    good: `${Math.round(i * ease)}d`,
    easy: `${Math.round(i * ease * 1.3)}d`,
  }
}

function normalizeStage(state: CardState): CardState {
  return state === 'relearning' ? 'learning' : state
}

function targetWord(card: SessionCard) {
  return (card.productionTarget || (card.cardType === 'reverse' ? card.answer : card.cue)).trim()
}

function definitionForCard(card: SessionCard) {
  const head = (card.productionTarget || (card.cardType === 'reverse' ? card.answer : card.cue)).trim()
  const candidates = [
    card.cardType === 'reverse' ? card.cue : card.answer,
    card.explanation,
    card.extra && !card.extra.startsWith('/') ? card.extra : null,
  ]
  for (const candidate of candidates) {
    const value = (candidate ?? '').trim()
    // Reject niche technical senses here so practice enriches them per-word.
    if (isUsableDefinition(value, head) && !shouldRefreshDefinition(value, head)) return value
  }
  // Prefer empty over a headword-as-definition or a known-bad grammar dump.
  const fallback = (card.cardType === 'reverse' ? card.cue : card.answer).trim()
  if (
    fallback
    && fallback.toLowerCase() !== head.toLowerCase()
    && !shouldRefreshDefinition(fallback, head)
  ) {
    return fallback
  }
  return ''
}

function sentenceForCard(card: SessionCard, word: string, definition: string) {
  const example = (card.exampleSentence ?? '').trim()
  // Never invent or reuse a fake “story” quote that pastes the dictionary gloss.
  if (isRealBookSentence(example, word, definition)) {
    return example
  }
  // Metadata context from reader selection (if present on the card payload).
  const meta = (card as SessionCard & { metadata?: Record<string, unknown> }).metadata
  const metaContext = typeof meta?.context === 'string' ? meta.context.trim() : ''
  if (isRealBookSentence(metaContext, word, definition)) {
    return metaContext
  }
  // Empty is better than a fabricated quote that confuses learners.
  return ''
}

function cardToPracticeWord(card: SessionCard): PracticeWord {
  const word = targetWord(card)
  const definition = definitionForCard(card)
  return {
    id: card.id,
    noteId: card.noteId,
    word,
    phonetic: card.pronunciation,
    definition,
    sentence: sentenceForCard(card, word, definition),
    book: card.sourceBookTitle || card.topic || 'Reader Vocabulary',
    chapter: card.topic,
    stage: normalizeStage(card.state),
    interval: Number(card.debug?.scheduledDays ?? 0),
    ease: 2.5,
    mnemonic: card.mnemonic,
    card,
  }
}

function noteToSavedWord(note: VocabNote): SavedWord {
  const firstCard = note.cards[0]
  return {
    id: note.id,
    word: note.front,
    definition: note.back || note.explanation || note.extra || 'Saved from your reading.',
    book: note.sourceBookTitle || note.topic || 'Reader Vocabulary',
    stage: normalizeStage(firstCard?.state ?? 'new'),
    mnemonic: note.mnemonic,
  }
}

function buildSessionPlan(words: PracticeWord[]): PracticeStep[] {
  return buildSmartSessionPlan(words, AVAILABLE_EXERCISES) as PracticeStep[]
}

const EXERCISE_LABEL: Record<ExerciseType, string> = {
  mcq: 'Definition pick',
  cloze: 'Fill the blank',
  mnemonic: 'Memory hook',
  recall: 'Self-check',
  'write-sentence': 'Use in a sentence',
  'write-definition': 'Write the meaning',
  'reverse-recall': 'Listen & type',
  listening: 'Listen & choose',
}

const SESSION_MODES: Array<{ id: SessionMode; label: string; hint: string }> = [
  { id: 'quick', label: 'Quick 5', hint: 'Short daily set' },
  { id: 'due', label: 'Due now', hint: 'Cards ready today' },
  { id: 'weak', label: 'Weak first', hint: 'Learning & shaky cards' },
  { id: 'full', label: 'Full set', hint: 'Up to 12 cards' },
]

function ratingFromResult(exercise: ExerciseType, result: StepCompletePayload): Rating | null {
  if (result.rating) return result.rating
  if (exercise === 'mnemonic') return null
  if (
    exercise === 'mcq'
    || exercise === 'cloze'
    || exercise === 'reverse-recall'
    || exercise === 'listening'
  ) {
    return objectiveResultToRating({
      correct: result.correct,
      hintsUsed: result.hintsUsed ?? 0,
      attempts: result.attempts ?? 1,
    })
  }
  if (result.correct) return 'good'
  return exercise === 'write-sentence' || exercise === 'write-definition' ? 'hard' : 'again'
}

function answerModeForExercise(exercise: ExerciseType) {
  return exercise === 'cloze' || exercise === 'write-definition' || exercise === 'write-sentence'
    ? 'typed'
    : 'self_report'
}

function ProgressBar({ progress, color = C.gold, height = 5 }: { progress: number; color?: string; height?: number }) {
  return (
    <div style={{ background: 'rgba(0,0,0,0.08)', borderRadius: 99, height, overflow: 'hidden' }}>
      <div
        style={{
          width: progressPercent(progress),
          height: '100%',
          background: color,
          borderRadius: 99,
          transition: 'width 0.5s cubic-bezier(0.4,0,0.2,1)',
        }}
      />
    </div>
  )
}

function Pill({ children, color = C.gold }: { children: ReactNode; color?: string }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        background: `${color}1F`,
        color,
        border: `1px solid ${color}38`,
        borderRadius: 99,
        padding: '3px 10px',
        fontSize: 10.5,
        fontWeight: 700,
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        fontFamily: FONT.ui,
      }}
    >
      {children}
    </span>
  )
}

type BtnVariant = 'primary' | 'ghost' | 'danger' | 'warn' | 'success'

function Btn({
  children,
  onClick,
  variant = 'primary',
  disabled = false,
  style = {},
}: {
  children: ReactNode
  onClick?: () => void
  variant?: BtnVariant
  disabled?: boolean
  style?: CSSProperties
}) {
  const variants: Record<BtnVariant, CSSProperties> = {
    primary: { background: C.gold, color: '#ffffff' },
    ghost: { background: 'transparent', color: C.text, border: `1px solid ${C.border}` },
    danger: { background: 'transparent', color: C.red, border: `1px solid ${C.red}44` },
    warn: { background: 'transparent', color: C.amber, border: `1px solid ${C.amber}44` },
    success: { background: 'transparent', color: C.green, border: `1px solid ${C.green}44` },
  }

  return (
    <button
      onClick={disabled ? undefined : onClick}
      onMouseDown={(e) => { if (!disabled) e.currentTarget.style.transform = 'scale(0.98)' }}
      onMouseUp={(e) => { e.currentTarget.style.transform = 'scale(1)' }}
      onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)' }}
      disabled={disabled}
      style={{
        border: 'none',
        borderRadius: 12,
        padding: '14px 22px',
        fontSize: 14.5,
        fontWeight: 700,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.35 : 1,
        transition: 'transform 0.1s, background 0.15s, border-color 0.15s',
        fontFamily: FONT.ui,
        ...variants[variant],
        ...style,
      }}
    >
      {children}
    </button>
  )
}

function AudioBtn({ text, size = 32 }: { text: string; size?: number }) {
  const [speaking, setSpeaking] = useState(false)
  const [loading, setLoading] = useState(false)

  async function go(e: React.MouseEvent) {
    e.stopPropagation()
    if (loading || speaking) return
    setLoading(true)
    try {
      await speakStudioText(text, {
        onPlaying: () => {
          setLoading(false)
          setSpeaking(true)
        },
      })
    } finally {
      setLoading(false)
      setSpeaking(false)
    }
  }
  return (
    <button
      onClick={(e) => { void go(e) }}
      aria-label={`Pronounce ${text}`}
      disabled={loading}
      title="Play with neural voice (Kokoro)"
      style={{
        width: size, height: size, borderRadius: '50%',
        background: speaking || loading ? C.blue : `${C.blue}15`,
        border: `1.5px solid ${speaking || loading ? C.blue : `${C.blue}44`}`,
        color: speaking || loading ? '#fff' : C.blue,
        cursor: loading ? 'wait' : 'pointer',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        transition: 'all 0.2s', flex: '0 0 auto',
        boxShadow: speaking || loading ? `0 0 0 4px ${C.blue}22` : 'none',
        opacity: loading ? 0.85 : 1,
      }}
      onMouseEnter={(e) => { if (!speaking && !loading) { e.currentTarget.style.background = `${C.blue}28` } }}
      onMouseLeave={(e) => { if (!speaking && !loading) { e.currentTarget.style.background = `${C.blue}15` } }}
    >
      {loading ? (
        <div
          style={{
            width: Math.round(size * 0.36),
            height: Math.round(size * 0.36),
            borderRadius: '50%',
            border: '2px solid rgba(255,255,255,0.35)',
            borderTopColor: '#fff',
            animation: 'studioSpin 0.7s linear infinite',
          }}
        />
      ) : (
      <svg width={Math.round(size * 0.44)} height={Math.round(size * 0.44)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
        <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
        <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
      </svg>
      )}
    </button>
  )
}


function ExerciseHeader({ title, subtitle, word }: { title: string; subtitle?: string; word?: string }) {
  return (
    <div style={{ marginBottom: 2, flexShrink: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 4 }}>
        <Pill color={C.gold}>{title}</Pill>
        {word && <AudioBtn text={word} size={26} />}
      </div>
      {subtitle && <div style={{ color: C.muted, fontSize: 12, fontFamily: FONT.ui }}>{subtitle}</div>}
    </div>
  )
}

/**
 * Available height for the practice column across zoom levels and shell chrome.
 * Prefers the AppShell <main> box (already excludes sidebar/header/nav), then
 * falls back to visualViewport so 70–100% browser zoom still fits.
 */
function usePracticeFrameHeight() {
  const [height, setHeight] = useState<number>(() => {
    if (typeof window === 'undefined') return 640
    return Math.max(280, Math.floor((window.visualViewport?.height ?? window.innerHeight) * 0.88))
  })

  useEffect(() => {
    const measure = () => {
      const main = document.querySelector('main')
      if (main) {
        const h = main.getBoundingClientRect().height
        // Leave a little room for studio outer padding.
        setHeight(Math.max(260, Math.floor(h - 12)))
        return
      }
      const vv = window.visualViewport
      const vh = vv?.height ?? window.innerHeight
      const isMobile = window.matchMedia('(max-width: 767px)').matches
      const chrome = isMobile ? 48 + 56 : 0
      const pad = isMobile ? 20 : 28
      setHeight(Math.max(260, Math.floor(vh - chrome - pad)))
    }
    measure()
    window.visualViewport?.addEventListener('resize', measure)
    window.visualViewport?.addEventListener('scroll', measure)
    window.addEventListener('resize', measure)
    const ro = typeof ResizeObserver !== 'undefined' && document.querySelector('main')
      ? new ResizeObserver(measure)
      : null
    const main = document.querySelector('main')
    if (ro && main) ro.observe(main)
    const mq = window.matchMedia('(max-width: 767px)')
    mq.addEventListener?.('change', measure)
    return () => {
      window.visualViewport?.removeEventListener('resize', measure)
      window.visualViewport?.removeEventListener('scroll', measure)
      window.removeEventListener('resize', measure)
      ro?.disconnect()
      mq.removeEventListener?.('change', measure)
    }
  }, [])

  return height
}

/** Pinned action footer — stays fully visible; body scrolls above it. */
function StickyActionBar({ children }: { children: ReactNode }) {
  return (
    <div
      className="studio-action-bar"
      style={{
        flexShrink: 0,
        zIndex: 6,
        marginTop: 0,
        paddingTop: 10,
        paddingBottom: 'max(4px, env(safe-area-inset-bottom, 0px))',
        background: '#ffffff',
        borderTop: '1px solid rgba(0,0,0,0.06)',
        boxShadow: '0 -6px 16px rgba(255,255,255,0.95)',
      }}
    >
      {children}
    </div>
  )
}

/** Flex column: scrollable body + pinned action footer (always fully on-screen). */
function ExerciseBody({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: '1 1 auto',
        minHeight: 0,
        height: '100%',
        maxHeight: '100%',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          flex: '1 1 auto',
          minHeight: 0,
          overflowY: 'auto',
          overflowX: 'hidden',
          WebkitOverflowScrolling: 'touch',
          overscrollBehavior: 'contain',
          paddingBottom: footer ? 8 : 0,
        }}
      >
        {children}
      </div>
      {footer ? <StickyActionBar>{footer}</StickyActionBar> : null}
    </div>
  )
}

function AICheckingBadge() {
  return (
    <div style={{
      padding: '12px 14px',
      background: `${C.violet}10`,
      border: `1px solid ${C.violet}33`,
      borderRadius: 12,
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      marginBottom: 12,
    }}>
      <Sparkles size={14} color={C.violet} />
      <span style={{ color: C.violet, fontSize: 13, fontWeight: 600 }}>AI is checking your answer…</span>
      <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 3 }}>
        {[0,1,2].map(i => (
          <span
            key={i}
            style={{
              width: 5, height: 5, borderRadius: 99,
              background: C.violet,
              opacity: 0.5,
              animation: `studioFadeIn 0.9s ${i * 0.15}s ease-in-out infinite alternate`,
            }}
          />
        ))}
      </span>
    </div>
  )
}

function AIVerdictCard({ check }: { check: VocabCheck }) {
  const verdictColor = check.verdict === 'correct' ? C.green : check.verdict === 'partial' ? C.amber : C.red
  const verdictLabel = check.verdict === 'correct' ? 'Correct' : check.verdict === 'partial' ? 'Almost there' : 'Not quite'
  const verdictIcon  = check.verdict === 'correct' ? <Check size={14} /> : check.verdict === 'incorrect' ? <X size={14} /> : <Circle size={14} fill="currentColor" />

  return (
    <div style={{
      padding: '14px 16px',
      background: `${verdictColor}0F`,
      border: `1px solid ${verdictColor}3A`,
      borderRadius: 12,
      marginBottom: 12,
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        color: verdictColor,
        fontSize: 13,
        fontWeight: 700,
        marginBottom: 6,
      }}>
        {verdictIcon}
        <span>{verdictLabel}</span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4, opacity: 0.65, fontSize: 10.5, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
          <Sparkles size={10} /> AI feedback
        </span>
      </div>
      {check.feedback && (
        <div style={{ color: C.text, fontSize: 13.5, lineHeight: 1.55 }}>
          {check.feedback}
        </div>
      )}
      {check.suggestion && (
        <div style={{
          marginTop: 10,
          padding: '8px 12px',
          background: 'rgba(0,0,0,0.04)',
          borderRadius: 8,
          fontSize: 12.5,
          color: C.mutedHi,
          lineHeight: 1.5,
          fontStyle: 'italic',
        }}>
          <span style={{ fontStyle: 'normal', fontWeight: 700, color: C.violet }}>Try: </span>
          {check.suggestion}
        </div>
      )}
    </div>
  )
}

function ExerciseMCQ({
  word,
  distractors,
  onComplete,
}: {
  word: PracticeWord
  distractors: string[]
  onComplete: (result: StepCompletePayload) => void
}) {
  const [selected, setSelected] = useState<string | null>(null)
  const usableDef = isUsableDefinition(word.definition, word.word)
  const [options] = useState(() => {
    if (!usableDef) return []
    return buildDefinitionMcqOptions(word.definition, distractors, word.word)
  })
  const bookContext = word.sentence
    && word.sentence.length > 16
    && !isFabricatedContextSentence(word.sentence, word.word, word.definition)
    ? word.sentence
    : null

  const revealed = selected !== null
  const correct = selected === word.definition

  // Keyboard: 1–4 / A–D to answer, Enter to continue
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (!revealed) {
        const map: Record<string, number> = { '1': 0, '2': 1, '3': 2, '4': 3, a: 0, b: 1, c: 2, d: 3 }
        const idx = map[e.key.toLowerCase()]
        if (idx != null && options[idx]) {
          e.preventDefault()
          setSelected(options[idx])
        }
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onComplete({ correct })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [revealed, options, correct, onComplete])

  if (!usableDef || options.length < 2) {
    return (
      <div>
        <ExerciseHeader title="Definition pick" subtitle={`from ${word.book}`} word={word.word} />
        <div style={{ padding: '14px 16px', borderRadius: 12, background: `${C.amber}14`, border: `1px solid ${C.amber}40`, color: C.amber, fontSize: 13.5, lineHeight: 1.5, marginTop: 12 }}>
          This card is missing a real definition, so a definition quiz can’t run yet. Save the word again from Define, or skip for now.
        </div>
        <div style={{ marginTop: 14 }}>
          <Btn onClick={() => onComplete({ correct: true, rating: 'hard' })} style={{ width: '100%' }}>
            Skip card
          </Btn>
        </div>
      </div>
    )
  }

  // After answering, only keep selected + correct options so the result stays on-screen.
  const visibleOptions = revealed
    ? options
        .map((opt, i) => ({ opt, i }))
        .filter(({ opt }) => opt === selected || opt === word.definition)
    : options.map((opt, i) => ({ opt, i }))

  return (
    <ExerciseBody
      footer={revealed ? (
        <Btn onClick={() => onComplete({ correct })} style={{ width: '100%', padding: '12px 16px' }}>
          Continue · Enter
        </Btn>
      ) : undefined}
    >
      <div style={{ fontSize: 11.5, color: C.muted, marginBottom: 8 }}>
        {word.book} · keys 1–4
      </div>

      {!revealed && bookContext && (
        <div style={{
          marginBottom: 10,
          padding: '8px 10px',
          background: 'rgba(0,0,0,0.03)',
          borderLeft: `3px solid ${C.gold}`,
          borderRadius: '0 10px 10px 0',
          fontSize: 12.5, lineHeight: 1.4, color: C.mutedHi, fontStyle: 'italic',
        }}>
          “{bookContext.length > 120 ? `${bookContext.slice(0, 117)}…` : bookContext}”
        </div>
      )}

      <div style={{ color: C.mutedHi, fontSize: 13, marginBottom: 10, fontFamily: FONT.ui }}>
        What does <strong style={{ color: C.text, fontFamily: FONT.display, fontSize: 15 }}>{word.word}</strong> mean here?
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {visibleOptions.map(({ opt, i }) => {
          const isSel = selected === opt
          const isCorrect = opt === word.definition
          let bg = C.cardHi
          let bd = C.border
          let col = C.text
          if (revealed) {
            if (isCorrect) { bg = `${C.green}18`; bd = `${C.green}55`; col = C.green }
            else if (isSel) { bg = `${C.red}18`; bd = `${C.red}55`; col = C.red }
          }
          return (
            <button
              key={`${i}-${opt.slice(0, 24)}`}
              onClick={() => !revealed && setSelected(opt)}
              style={{
                background: bg,
                border: `1px solid ${bd}`,
                borderRadius: 12,
                padding: '10px 12px',
                color: col,
                fontSize: 13.5,
                textAlign: 'left',
                cursor: revealed ? 'default' : 'pointer',
                fontFamily: FONT.ui,
                transition: 'all 0.18s',
                lineHeight: 1.4,
              }}
            >
              <span style={{ opacity: 0.55, fontWeight: 700, marginRight: 8 }}>{String.fromCharCode(65 + i)}.</span>
              {opt}
            </button>
          )
        })}
      </div>

      {revealed && (
        <div
          style={{
            marginTop: 12,
            padding: '10px 12px',
            background: `${correct ? C.green : C.red}12`,
            border: `1px solid ${correct ? C.green : C.red}33`,
            borderRadius: 10,
            color: correct ? C.green : C.red,
            fontSize: 13,
            fontFamily: FONT.ui,
            fontWeight: 600,
            display: 'flex',
            gap: 8,
            alignItems: 'flex-start',
          }}
        >
          {correct ? <Check size={14} style={{ marginTop: 2, flexShrink: 0 }} /> : <X size={14} style={{ marginTop: 2, flexShrink: 0 }} />}
          <div style={{ minWidth: 0 }}>
            <div>{correct ? 'Correct' : 'Not quite'}</div>
            <div style={{ marginTop: 3, fontWeight: 500, color: C.mutedHi, lineHeight: 1.4 }}>
              <strong style={{ color: C.text }}>{word.word}</strong>
              {': '}
              <em style={{ color: C.text }}>{word.definition}</em>
            </div>
          </div>
        </div>
      )}
    </ExerciseBody>
  )
}

function ExerciseListening({
  word,
  distractors,
  onComplete,
}: {
  word: PracticeWord
  distractors: string[]
  onComplete: (result: StepCompletePayload) => void
}) {
  const [selected, setSelected] = useState<string | null>(null)
  const [hasPlayed, setHasPlayed] = useState(false)
  const usableDef = isUsableDefinition(word.definition, word.word)
  const [options] = useState(() => {
    if (!usableDef) return []
    return buildDefinitionMcqOptions(word.definition, distractors, word.word)
  })

  function play() {
    speak(word.word)
    setHasPlayed(true)
  }

  // Auto-play once so the card is ready without a tall empty state.
  useEffect(() => {
    const t = window.setTimeout(() => play(), 280)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [word.id])

  const revealed = selected !== null
  const correct = selected === word.definition

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (!revealed) {
        if (e.key === ' ' || e.key.toLowerCase() === 'r') {
          e.preventDefault()
          play()
          return
        }
        const map: Record<string, number> = { '1': 0, '2': 1, '3': 2, '4': 3, a: 0, b: 1, c: 2, d: 3 }
        const idx = map[e.key.toLowerCase()]
        if (idx != null && options[idx] && hasPlayed) {
          e.preventDefault()
          setSelected(options[idx])
        }
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onComplete({ correct, hintsUsed: 0, attempts: 1 })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [revealed, options, correct, onComplete, hasPlayed])

  if (!usableDef || options.length < 2) {
    return (
      <div>
        <div style={{ padding: '14px 16px', borderRadius: 12, background: `${C.amber}14`, border: `1px solid ${C.amber}40`, color: C.amber, fontSize: 13.5, lineHeight: 1.5 }}>
          No solid definition is available for listening practice yet.
        </div>
        <div style={{ marginTop: 14 }}>
          <Btn onClick={() => onComplete({ correct: true, rating: 'hard' })} style={{ width: '100%' }}>Skip card</Btn>
        </div>
      </div>
    )
  }

  // Collapse distractors after answering so Continue stays on-screen.
  const visibleOptions = revealed
    ? options
        .map((opt, i) => ({ opt, i }))
        .filter(({ opt }) => opt === selected || opt === word.definition)
    : options.map((opt, i) => ({ opt, i }))

  return (
    <ExerciseBody
      footer={revealed ? (
        <Btn
          onClick={() => onComplete({ correct, hintsUsed: 0, attempts: 1 })}
          style={{ width: '100%', padding: '12px 16px' }}
        >
          Continue · Enter
        </Btn>
      ) : undefined}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 10 }}>
        <div style={{ fontSize: 12.5, color: C.mutedHi }}>
          {hasPlayed ? 'What does this word mean?' : 'Playing the word…'}
          <span style={{ color: C.muted }}> · keys 1–4</span>
        </div>
        <button
          type="button"
          onClick={play}
          aria-label="Replay the word"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '7px 12px',
            borderRadius: 99,
            border: `1.5px solid ${C.blue}55`,
            background: `${C.blue}12`,
            color: C.blue,
            cursor: 'pointer',
            fontSize: 12.5, fontWeight: 600, fontFamily: FONT.ui,
            flexShrink: 0,
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
          {hasPlayed ? 'Replay' : 'Play'}
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {visibleOptions.map(({ opt, i }) => {
          const isSel = selected === opt
          const isCorrectOpt = opt === word.definition
          let bg = C.cardHi
          let bd = C.border
          let col = C.text
          if (revealed) {
            if (isCorrectOpt) { bg = `${C.green}18`; bd = `${C.green}55`; col = C.green }
            else if (isSel) { bg = `${C.red}18`; bd = `${C.red}55`; col = C.red }
          }
          return (
            <button
              key={`${i}-${opt.slice(0, 24)}`}
              type="button"
              onClick={() => {
                if (revealed) return
                if (!hasPlayed) play()
                setSelected(opt)
              }}
              style={{
                background: bg,
                border: `1px solid ${bd}`,
                borderRadius: 12,
                padding: '10px 12px',
                color: col,
                fontSize: 13.5,
                textAlign: 'left',
                cursor: revealed ? 'default' : 'pointer',
                fontFamily: FONT.ui,
                transition: 'all 0.18s',
                lineHeight: 1.4,
              }}
            >
              <span style={{ opacity: 0.55, fontWeight: 700, marginRight: 8 }}>{String.fromCharCode(65 + i)}.</span>
              {opt}
            </button>
          )
        })}
      </div>

      {revealed && (
        <div
          style={{
            marginTop: 12,
            padding: '10px 12px',
            background: `${correct ? C.green : C.red}12`,
            border: `1px solid ${correct ? C.green : C.red}33`,
            borderRadius: 10,
            color: correct ? C.green : C.red,
            fontSize: 13,
            fontFamily: FONT.ui,
            fontWeight: 600,
            display: 'flex',
            gap: 8,
            alignItems: 'flex-start',
          }}
        >
          {correct ? <Check size={14} style={{ marginTop: 2, flexShrink: 0 }} /> : <X size={14} style={{ marginTop: 2, flexShrink: 0 }} />}
          <div style={{ minWidth: 0 }}>
            <div>{correct ? 'Correct' : 'Not quite'}</div>
            <div style={{ marginTop: 3, fontWeight: 500, color: C.mutedHi, lineHeight: 1.4 }}>
              <strong style={{ color: C.text }}>{word.word}</strong>
              {word.phonetic ? <span style={{ fontFamily: FONT.mono, fontSize: 12, marginLeft: 6 }}>{word.phonetic}</span> : null}
              <div style={{ marginTop: 2 }}>
                <em style={{ color: C.text }}>{word.definition}</em>
              </div>
            </div>
          </div>
        </div>
      )}
    </ExerciseBody>
  )
}

function ExerciseCloze({ word, onComplete }: { word: PracticeWord; onComplete: (result: StepCompletePayload) => void }) {
  const [input, setInput] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { inputRef.current?.focus() }, [])

  // Never run cloze on the old shared template / dictionary dump.
  const passageOk = isRealBookSentence(word.sentence, word.word, word.definition)
  if (!passageOk) {
    return (
      <ExerciseBody
        footer={
          <Btn onClick={() => onComplete({ correct: true, rating: 'hard' })} style={{ width: '100%', padding: '12px 16px' }}>
            Skip — no book passage yet
          </Btn>
        }
      >
        <ExerciseHeader title="Context Cloze" subtitle="Needs a real sentence from your reading" />
        <div style={{
          marginTop: 14, padding: '14px 16px', borderRadius: 12,
          background: `${C.amber}12`, border: `1px solid ${C.amber}40`,
          color: C.amber, fontSize: 13.5, lineHeight: 1.5,
        }}>
          This card doesn’t have a real book sentence yet (only a placeholder). Save the word again from the reader to capture context, or skip for now.
          {isUsableDefinition(word.definition, word.word) && (
            <div style={{ marginTop: 10, color: C.text, fontStyle: 'italic' }}>
              <strong style={{ fontStyle: 'normal' }}>{word.word}</strong>
              {': '}
              {word.definition}
            </div>
          )}
        </div>
      </ExerciseBody>
    )
  }

  const correct = input.trim().toLowerCase() === word.word.toLowerCase()
  const pattern = new RegExp(escapeRegExp(word.word), 'i')
  const match = word.sentence.match(pattern)
  const before = match ? word.sentence.slice(0, match.index) : ''
  const after = match ? word.sentence.slice((match.index ?? 0) + match[0].length) : word.sentence

  return (
    <ExerciseBody
      footer={!submitted ? (
        <Btn onClick={() => setSubmitted(true)} disabled={!input.trim()} style={{ width: '100%', padding: '12px 16px' }}>Check</Btn>
      ) : (
        <Btn onClick={() => onComplete({ correct, typedResponse: input })} style={{ width: '100%', padding: '12px 16px' }}>Continue</Btn>
      )}
    >
      <ExerciseHeader title="Context Cloze" subtitle="Fill the word from the book passage" />
      <div style={{ background: 'rgba(0,0,0,0.03)', border: `1px solid rgba(0,0,0,0.07)`, borderLeft: `3px solid ${C.gold}`, borderRadius: '0 12px 12px 0', padding: '14px 16px', marginTop: 14, marginBottom: 16 }}>
        <div style={{ color: C.muted, fontSize: 10.5, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 6 }}>
          {word.book}{word.chapter ? ` · ${word.chapter}` : ''}
        </div>
        <div style={{ color: C.cream, fontSize: 16, lineHeight: 1.7, fontFamily: FONT.display, fontStyle: 'italic' }}>
          "{before || 'The word '}
          <span
            style={{
              display: 'inline-block',
              minWidth: 100,
              padding: '1px 8px',
              margin: '0 2px',
              borderBottom: `2px solid ${submitted ? (correct ? C.green : C.red) : C.gold}`,
              color: submitted ? (correct ? C.green : C.red) : C.gold,
              fontStyle: 'normal',
              fontWeight: 600,
            }}
          >
            {submitted ? word.word : input || '\u00A0'}
          </span>
          {after}"
        </div>
      </div>

      {!submitted ? (
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && input.trim()) setSubmitted(true) }}
          placeholder="Type the word"
          style={{
            width: '100%',
            boxSizing: 'border-box',
            background: C.cardHi,
            border: `1px solid ${C.borderHi}`,
            borderRadius: 12,
            padding: '14px 16px',
            color: C.text,
            fontSize: 15,
            fontFamily: FONT.ui,
            outline: 'none',
            marginBottom: 4,
          }}
        />
      ) : (
        <div style={{ padding: '12px 14px', background: `${correct ? C.green : C.red}14`, border: `1px solid ${correct ? C.green : C.red}33`, borderRadius: 10, color: correct ? C.green : C.red, fontSize: 13, fontFamily: FONT.ui, fontWeight: 600, marginBottom: 4 }}>
          {correct ? 'Exactly right' : `The word was "${word.word}"`}
        </div>
      )}
    </ExerciseBody>
  )
}

function normalizeForReverseRecall(value: string): string {
  return value.trim().toLowerCase().replace(/^(the|a|an)\s+/, '')
}

function ExerciseReverseRecall({ word, onComplete }: { word: PracticeWord; onComplete: (result: StepCompletePayload) => void }) {
  // Dictation: hear the word (neural TTS), type the spelling — never show the answer until checked.
  const [input, setInput] = useState('')
  const [attempts, setAttempts] = useState(0)
  const [hintShown, setHintShown] = useState(false)
  const [revealed, setRevealed] = useState(false)
  const [lastAttemptCorrect, setLastAttemptCorrect] = useState(false)
  const [hasPlayed, setHasPlayed] = useState(false)
  const [playing, setPlaying] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const target = normalizeForReverseRecall(word.word)
  const userAnswer = normalizeForReverseRecall(input)
  const letterCount = word.word.replace(/[^a-zA-Z]/g, '').length
  const hint = word.word.charAt(0)

  async function play() {
    if (playing) return
    setPlaying(true)
    try {
      await speakStudioText(word.word)
      setHasPlayed(true)
    } finally {
      setPlaying(false)
      window.setTimeout(() => inputRef.current?.focus(), 0)
    }
  }

  // Auto-play once when the card opens (user can replay anytime).
  useEffect(() => {
    const t = window.setTimeout(() => { void play() }, 320)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [word.id])

  useEffect(() => {
    if (!revealed) inputRef.current?.focus()
  }, [revealed, hintShown])

  function check() {
    if (!input.trim()) return
    const correct = userAnswer === target
    const nextAttempts = attempts + 1
    setAttempts(nextAttempts)
    setLastAttemptCorrect(correct)
    if (correct || nextAttempts >= 2) {
      setRevealed(true)
    } else {
      setHintShown(true)
      setInput('')
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }

  function handleContinue() {
    onComplete({
      correct: lastAttemptCorrect,
      hintsUsed: hintShown ? 1 : 0,
      attempts,
      typedResponse: input,
    })
  }

  const footer = !revealed ? (
    <Btn onClick={check} disabled={!input.trim()} style={{ width: '100%', padding: '12px 16px' }}>Check</Btn>
  ) : (
    <Btn onClick={handleContinue} style={{ width: '100%', padding: '12px 16px' }}>Continue →</Btn>
  )

  return (
    <ExerciseBody footer={footer}>
      <ExerciseHeader title="Listen & type" subtitle="Hear the word, then type the spelling" />

      {!revealed ? (
        <>
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
            padding: '18px 16px 16px', marginTop: 10, marginBottom: 14,
            background: `${C.blue}08`, border: `1px solid ${C.blue}22`, borderRadius: 16,
          }}>
            <button
              type="button"
              onClick={() => { void play() }}
              disabled={playing}
              aria-label={hasPlayed ? 'Replay the word' : 'Play the word'}
              style={{
                width: 72, height: 72, borderRadius: '50%',
                border: `2px solid ${C.blue}`,
                background: playing ? C.blue : `${C.blue}14`,
                color: playing ? '#fff' : C.blue,
                cursor: playing ? 'wait' : 'pointer',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: `0 4px 16px ${C.blue}22`,
                transition: 'all 0.15s',
              }}
            >
              {playing ? (
                <div style={{
                  width: 22, height: 22, borderRadius: '50%',
                  border: '2.5px solid rgba(255,255,255,0.35)',
                  borderTopColor: '#fff',
                  animation: 'studioSpin 0.7s linear infinite',
                }} />
              ) : (
                <svg width={28} height={28} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                </svg>
              )}
            </button>
            <div style={{ fontSize: 13, color: C.mutedHi, fontFamily: FONT.ui, textAlign: 'center' }}>
              {playing ? 'Playing…' : hasPlayed ? 'Tap to replay · then type what you heard' : 'Playing the word…'}
            </div>
            <div style={{
              fontSize: 12, color: C.muted, fontFamily: FONT.mono, letterSpacing: '0.18em',
              background: 'rgba(0,0,0,0.04)', padding: '6px 12px', borderRadius: 99,
            }}>
              {Array.from({ length: Math.min(14, Math.max(3, letterCount)) }, () => '·').join(' ')}
              <span style={{ marginLeft: 8, letterSpacing: '0.04em', opacity: 0.75 }}>
                {letterCount} letter{letterCount === 1 ? '' : 's'}
              </span>
            </div>
          </div>

          {hintShown && (
            <div style={{ padding: '8px 12px', background: `${C.amber}14`, border: `1px solid ${C.amber}40`, borderRadius: 10, marginBottom: 10, color: C.amber, fontSize: 12.5, fontFamily: FONT.ui, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Sparkles size={12} />
              Hint: starts with <strong style={{ fontFamily: FONT.mono, fontSize: 14 }}>{hint}</strong>
              {isUsableDefinition(word.definition, word.word) && (
                <span style={{ color: C.mutedHi }}> · means “{word.definition.length > 48 ? `${word.definition.slice(0, 48)}…` : word.definition}”</span>
              )}
            </div>
          )}
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && input.trim()) check() }}
            placeholder="Type the word you heard"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              background: C.cardHi,
              border: `1.5px solid ${C.gold}55`,
              borderRadius: 12,
              padding: '14px 16px',
              color: C.text,
              fontSize: 17,
              fontFamily: FONT.display,
              outline: 'none',
              marginBottom: 4,
              textAlign: 'center',
              letterSpacing: '0.02em',
            }}
          />
        </>
      ) : (
        <>
          <div style={{ padding: '12px 14px', background: `${lastAttemptCorrect ? C.green : C.red}14`, border: `1px solid ${lastAttemptCorrect ? C.green : C.red}33`, borderRadius: 10, color: lastAttemptCorrect ? C.green : C.red, fontSize: 13, fontFamily: FONT.ui, fontWeight: 600, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
            {lastAttemptCorrect ? <Check size={14} /> : <X size={14} />}
            {lastAttemptCorrect
              ? (hintShown ? 'Got it with the hint' : 'Exactly right')
              : `The word was "${word.word}"`}
          </div>
          <div style={{ borderRadius: 14, overflow: 'hidden', marginBottom: 4, border: '1px solid rgba(0,0,0,0.07)' }}>
            <div style={{ padding: '14px 16px', background: `${C.gold}10`, display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: FONT.display, fontSize: 22, fontWeight: 700, color: C.cream }}>{word.word}</div>
                {word.phonetic && <div style={{ color: C.muted, fontSize: 12, fontFamily: FONT.mono, marginTop: 2 }}>{word.phonetic}</div>}
                {isUsableDefinition(word.definition, word.word) && (
                  <div style={{ color: C.mutedHi, fontSize: 13.5, fontFamily: FONT.display, fontStyle: 'italic', marginTop: 6, lineHeight: 1.45 }}>
                    {word.definition}
                  </div>
                )}
              </div>
              <AudioBtn text={word.word} />
            </div>
            {word.sentence && !isFabricatedContextSentence(word.sentence, word.word, word.definition) && (
              <div style={{ background: 'rgba(0,0,0,0.03)', borderLeft: `3px solid ${C.gold}`, padding: '10px 14px' }}>
                <div style={{ color: C.muted, fontSize: 10.5, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 4 }}>{word.book}</div>
                <div style={{ color: C.text, fontSize: 14, lineHeight: 1.6, fontFamily: FONT.display, fontStyle: 'italic' }}>"{word.sentence}"</div>
              </div>
            )}
          </div>
        </>
      )}
    </ExerciseBody>
  )
}

function ExerciseRecall({ word, onComplete }: { word: PracticeWord; onComplete: (result: StepCompletePayload) => void }) {
  const [revealed, setRevealed] = useState(false)
  const intervals = computeIntervals(word)
  const ratings: Array<{ key: Rating; label: string; interval: string; color: string }> = [
    { key: 'again', label: 'Again', interval: intervals.again, color: C.red },
    { key: 'hard', label: 'Hard', interval: intervals.hard, color: C.amber },
    { key: 'good', label: 'Good', interval: intervals.good, color: C.green },
    { key: 'easy', label: 'Easy', interval: intervals.easy, color: C.violet },
  ]

  return (
    <ExerciseBody
      footer={!revealed ? (
        <Btn onClick={() => setRevealed(true)} style={{ width: '100%', background: C.blue, padding: '12px 16px' }}>Reveal definition</Btn>
      ) : (
        <div>
          <div style={{ color: C.mutedHi, fontSize: 11.5, textAlign: 'center', marginBottom: 8, fontFamily: FONT.ui, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
            How well did you recall it?
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 6 }}>
            {ratings.map((r) => (
              <button
                key={r.key}
                onClick={() => onComplete({ rating: r.key, correct: r.key !== 'again' })}
                style={{ background: 'transparent', border: `1px solid ${r.color}44`, borderRadius: 10, padding: '10px 4px', color: r.color, cursor: 'pointer', fontFamily: FONT.ui, display: 'flex', flexDirection: 'column', gap: 3, transition: 'all 0.15s' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = `${r.color}14` }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
              >
                <span style={{ fontSize: 13, fontWeight: 700 }}>{r.label}</span>
                <span style={{ fontSize: 10.5, opacity: 0.7, fontFamily: FONT.mono }}>{r.interval}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    >
      <ExerciseHeader title="Active Recall" />
      <p style={{ color: '#4a4a46', fontSize: 14, lineHeight: 1.55, margin: '0 0 16px' }}>
        Recall the definition silently, then reveal and rate yourself.
      </p>

      {!revealed ? (
        <div
          onClick={() => setRevealed(true)}
          style={{
            background: '#eff6ff',
            border: '1.5px solid #93c5fd',
            borderRadius: 14,
            padding: '34px 20px',
            textAlign: 'center',
            cursor: 'pointer',
            marginBottom: 4,
            transition: 'background 0.15s',
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = '#dbeafe' }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = '#eff6ff' }}
        >
          <div style={{ color: '#93c5fd', fontSize: 20, letterSpacing: 10, marginBottom: 10 }}>— — — — — —</div>
          <div style={{ color: '#2563eb', fontSize: 13.5, fontWeight: 600, fontFamily: FONT.ui }}>Click to reveal</div>
        </div>
      ) : (
        <div style={{ borderRadius: 14, overflow: 'hidden', marginBottom: 4, animation: 'studioFadeIn 0.3s ease', border: '1px solid rgba(0,0,0,0.07)' }}>
          <div style={{ padding: '14px 16px', background: `${C.gold}10` }}>
            <div style={{ color: C.gold, fontSize: 16, fontFamily: FONT.display, fontStyle: 'italic', lineHeight: 1.55 }}>{word.definition}</div>
          </div>
          {word.sentence && !isFabricatedContextSentence(word.sentence, word.word, word.definition) && (
            <div style={{ background: 'rgba(0,0,0,0.03)', borderLeft: `3px solid ${C.gold}`, padding: '10px 14px' }}>
              <div style={{ color: C.muted, fontSize: 10.5, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 4 }}>{word.book}</div>
              <div style={{ color: C.text, fontSize: 14, lineHeight: 1.6, fontFamily: FONT.display, fontStyle: 'italic' }}>"{word.sentence}"</div>
            </div>
          )}
          {word.mnemonic && (
            <div style={{ padding: '10px 14px', background: `${C.violet}10`, borderTop: `1px solid ${C.violet}22` }}>
              <div style={{ color: C.violet, fontSize: 10.5, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 3 }}>Memory hook</div>
              <div style={{ color: C.text, fontSize: 13, lineHeight: 1.5 }}>{word.mnemonic}</div>
            </div>
          )}
        </div>
      )}
    </ExerciseBody>
  )
}

function ExerciseWriteSentence({ word, onComplete }: { word: PracticeWord; onComplete: (result: StepCompletePayload) => void }) {
  return word.stage === 'review'
    ? <WriteSentenceProduction word={word} onComplete={onComplete} />
    : <WriteSentenceCoached word={word} onComplete={onComplete} />
}

function lineMatchesTarget(line: string, target: string, stem: string): boolean {
  const lower = line.toLowerCase()
  return lower.includes(target) || lower.includes(stem)
}

function WriteSentenceProduction({ word, onComplete }: { word: PracticeWord; onComplete: (result: StepCompletePayload) => void }) {
  const [text, setText] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [production, setProduction] = useState<ProductionResponse | null>(null)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { ref.current?.focus() }, [])

  const target = word.word.toLowerCase()
  const stem = target.slice(0, Math.max(3, Math.min(5, target.length)))
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  const lineChecks = lines.map((line) => ({
    line,
    usesWord: lineMatchesTarget(line, target, stem),
    longEnough: line.split(/\s+/).filter(Boolean).length >= 4,
  }))
  const haveThree = lines.length >= 3
  const allValid = haveThree && lineChecks.slice(0, 3).every(c => c.usesWord && c.longEnough)

  async function submit() {
    if (!allValid || checking) return
    setSubmitted(true)
    setChecking(true)
    setError(null)
    try {
      const result = await submitCardProduction(word.id, lines.slice(0, 3))
      setProduction(result)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'AI check unavailable.')
    } finally {
      setChecking(false)
    }
  }

  function handleContinue(forceRating?: Rating) {
    if (!production) {
      onComplete({ correct: false, typedResponse: text })
      return
    }
    const rating: Rating = forceRating ?? (production.accepted ? 'good' : 'hard')
    onComplete({
      correct: production.accepted,
      rating,
      typedResponse: lines.slice(0, 3).join('\n'),
    })
  }

  let footer: ReactNode = null
  if (!submitted) {
    footer = (
      <Btn onClick={() => void submit()} disabled={!allValid} style={{ width: '100%', padding: '12px 16px' }}>
        Check with AI
      </Btn>
    )
  } else if (!checking && !production && error) {
    footer = (
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <Btn variant="warn" onClick={() => onComplete({ correct: false, typedResponse: text })}>Not quite</Btn>
        <Btn variant="success" onClick={() => onComplete({ correct: true, typedResponse: text })}>Yes, good</Btn>
      </div>
    )
  } else if (!checking && production) {
    footer = (
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <Btn variant="danger" onClick={() => handleContinue('again')}>Again</Btn>
        <Btn onClick={() => handleContinue()} disabled={checking}>{production.accepted ? 'Mark good →' : 'Continue →'}</Btn>
      </div>
    )
  }

  return (
    <ExerciseBody footer={footer}>
      <ExerciseHeader title="Production Checkpoint" subtitle="Write 3 sentences in your own words" />
      {isUsableDefinition(word.definition, word.word) && (
        <div style={{
          background: `${C.gold}10`, border: `1px solid ${C.gold}28`, borderRadius: 12,
          padding: '10px 12px', marginTop: 10, marginBottom: 10,
          color: C.gold, fontSize: 13.5, fontFamily: FONT.display, fontStyle: 'italic', lineHeight: 1.45,
        }}>
          {word.definition}
        </div>
      )}
      {!submitted ? (
        <>
          <textarea
            ref={ref}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={`Three sentences using "${word.word}", one per line`}
            rows={5}
            style={{ width: '100%', boxSizing: 'border-box', background: C.cardHi, border: `1px solid ${C.borderHi}`, borderRadius: 12, padding: '12px 14px', color: C.text, fontSize: 14, fontFamily: FONT.display, outline: 'none', resize: 'vertical', maxHeight: 180, minHeight: 100, marginBottom: 8, lineHeight: 1.6 }}
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 4, fontSize: 11, fontFamily: FONT.ui }}>
            {[0, 1, 2].map((i) => {
              const c = lineChecks[i]
              const ok = c?.usesWord && c?.longEnough
              return (
                <span key={i} style={{ color: ok ? C.green : C.muted, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  {ok ? <Check size={12} /> : <Circle size={12} />}
                  Sentence {i + 1}
                  {c && !ok && (
                    <span style={{ color: C.muted, fontSize: 10.5 }}>
                      {!c.usesWord ? '— uses the word' : ''}
                      {c.usesWord && !c.longEnough ? '— 4+ words' : ''}
                    </span>
                  )}
                </span>
              )
            })}
          </div>
        </>
      ) : (
        <>
          {checking && <AICheckingBadge />}
          {!checking && production && (
            <>
              <div style={{
                padding: '10px 12px',
                background: production.accepted ? `${C.green}10` : `${C.amber}10`,
                border: `1px solid ${production.accepted ? C.green : C.amber}3A`,
                borderRadius: 12,
                marginBottom: 10,
                color: production.accepted ? C.green : C.amber,
                fontSize: 13,
                fontWeight: 600,
                fontFamily: FONT.ui,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}>
                {production.accepted ? <Check size={14} /> : <Circle size={14} />}
                {production.accepted ? 'Accepted — strong production' : 'Needs work — see notes below'}
              </div>
              {production.feedback && (
                <div style={{ padding: '10px 12px', background: 'rgba(0,0,0,0.03)', border: `1px solid rgba(0,0,0,0.07)`, borderRadius: 10, marginBottom: 10, color: C.text, fontSize: 13, lineHeight: 1.5 }}>
                  {production.feedback}
                </div>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 4 }}>
                {production.sentenceNotes.map((sn, i) => {
                  const tone = sn.accepted ? C.green : C.amber
                  return (
                    <div key={i} style={{ padding: '10px 12px', background: `${tone}10`, border: `1px solid ${tone}3A`, borderRadius: 10 }}>
                      <div style={{ color: tone, fontSize: 10.5, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                        {sn.accepted ? <Check size={11} /> : <Circle size={11} />}
                        Sentence {i + 1}
                      </div>
                      <div style={{ color: C.text, fontSize: 13.5, fontFamily: FONT.display, fontStyle: 'italic', lineHeight: 1.5, marginBottom: sn.note ? 4 : 0 }}>"{sn.sentence}"</div>
                      {sn.note && <div style={{ color: C.mutedHi, fontSize: 12, lineHeight: 1.45 }}>{sn.note}</div>}
                    </div>
                  )
                })}
              </div>
            </>
          )}
          {!checking && error && (
            <div style={{ padding: '10px 12px', background: `${C.amber}14`, border: `1px solid ${C.amber}40`, borderRadius: 12, marginBottom: 4, color: C.amber, fontSize: 12.5 }}>
              {error} You can still continue and self-rate.
            </div>
          )}
        </>
      )}
    </ExerciseBody>
  )
}

function WriteSentenceCoached({ word, onComplete }: { word: PracticeWord; onComplete: (result: StepCompletePayload) => void }) {
  const [text, setText] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [coach, setCoach] = useState<CoachResponse | null>(null)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [turnIndex, setTurnIndex] = useState(1)
  const [history, setHistory] = useState<CoachHistoryItem[]>([])
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { ref.current?.focus() }, [])

  const target = word.word.toLowerCase()
  const stem = target.slice(0, Math.max(3, Math.min(5, target.length)))
  const wordUsed = lineMatchesTarget(text, target, stem)
  const longEnough = text.trim().split(/\s+/).filter(Boolean).length >= 4
  const valid = wordUsed && longEnough
  const canRetry = !!coach && coach.verdict !== 'correct' && turnIndex < 2 && !checking

  async function submit() {
    if (!valid || checking) return
    setSubmitted(true)
    setChecking(true)
    setError(null)
    try {
      const step = turnIndex === 1 ? 'answer' : 'retry'
      const result = await coachCard(word.id, {
        mode: 'review',
        step,
        turnIndex,
        learnerResponse: text,
        history,
      })
      setCoach(result)
      setHistory((h) => [
        ...h,
        { role: 'learner', text, step },
        { role: 'assistant', text: result.feedbackBody, step },
      ])
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'AI check unavailable.')
    } finally {
      setChecking(false)
    }
  }

  function startRetry() {
    setSubmitted(false)
    setText('')
    setCoach(null)
    setTurnIndex(2)
    setTimeout(() => ref.current?.focus(), 0)
  }

  function handleContinue() {
    if (!coach) {
      onComplete({ correct: wordUsed, typedResponse: text })
      return
    }
    onComplete({
      correct: coach.verdict !== 'incorrect',
      rating: coach.suggestedRating,
      typedResponse: text,
    })
  }

  let footer: ReactNode = null
  if (!submitted) {
    footer = <Btn onClick={() => void submit()} disabled={!valid} style={{ width: '100%', padding: '12px 16px' }}>Check with AI</Btn>
  } else if (!checking && !coach && error) {
    footer = (
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <Btn variant="warn" onClick={() => onComplete({ correct: false, typedResponse: text })}>Not quite</Btn>
        <Btn variant="success" onClick={() => onComplete({ correct: true, typedResponse: text })}>Yes, good</Btn>
      </div>
    )
  } else if (canRetry) {
    footer = (
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <Btn variant="ghost" onClick={startRetry}>Try again</Btn>
        <Btn onClick={handleContinue} disabled={checking}>Use this answer →</Btn>
      </div>
    )
  } else if (submitted && !checking) {
    footer = <Btn onClick={handleContinue} disabled={checking} style={{ width: '100%', padding: '12px 16px' }}>Continue →</Btn>
  }

  return (
    <ExerciseBody footer={footer}>
      <ExerciseHeader title="Write Your Own Sentence" subtitle="Use the word in a context that's yours" />
      {isUsableDefinition(word.definition, word.word) && (
        <div style={{
          background: `${C.gold}10`, border: `1px solid ${C.gold}28`, borderRadius: 12,
          padding: '10px 12px', marginTop: 10, marginBottom: 10,
          color: C.gold, fontSize: 13.5, fontFamily: FONT.display, fontStyle: 'italic', lineHeight: 1.45,
        }}>
          {word.definition}
        </div>
      )}
      {!submitted ? (
        <>
          {turnIndex === 2 && coach === null && (
            <div style={{ padding: '10px 12px', background: `${C.amber}14`, border: `1px solid ${C.amber}40`, borderRadius: 12, marginBottom: 10, color: C.amber, fontSize: 12.5, fontFamily: FONT.ui }}>
              One more attempt — try a different angle this time.
            </div>
          )}
          <textarea ref={ref} value={text} onChange={(e) => setText(e.target.value)} placeholder={`Write a sentence using "${word.word}"`} rows={3} style={{ width: '100%', boxSizing: 'border-box', background: C.cardHi, border: `1px solid ${C.borderHi}`, borderRadius: 12, padding: '12px 14px', color: C.text, fontSize: 14, fontFamily: FONT.display, outline: 'none', resize: 'vertical', maxHeight: 140, marginBottom: 8, lineHeight: 1.5 }} />
          <div style={{ display: 'flex', gap: 10, marginBottom: 4, fontSize: 11, fontFamily: FONT.ui }}>
            <span style={{ color: wordUsed ? C.green : C.muted, display: 'inline-flex', alignItems: 'center', gap: 4 }}>{wordUsed ? <Check size={12} /> : <Circle size={12} />} uses the word</span>
            <span style={{ color: longEnough ? C.green : C.muted, display: 'inline-flex', alignItems: 'center', gap: 4 }}>{longEnough ? <Check size={12} /> : <Circle size={12} />} 4+ words</span>
          </div>
        </>
      ) : (
        <>
          <div style={{ padding: '12px 14px', background: 'rgba(0,0,0,0.04)', border: `1px solid rgba(0,0,0,0.07)`, borderRadius: 12, marginBottom: 10 }}>
            <div style={{ color: C.muted, fontSize: 10.5, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 4 }}>Your sentence</div>
            <div style={{ color: C.text, fontSize: 14.5, fontFamily: FONT.display, fontStyle: 'italic', lineHeight: 1.5 }}>"{text}"</div>
          </div>
          {checking && <AICheckingBadge />}
          {!checking && coach && <AIVerdictCard check={coachToVocabCheck(coach)} />}
          {!checking && error && (
            <div style={{ padding: '10px 12px', background: `${C.amber}14`, border: `1px solid ${C.amber}40`, borderRadius: 12, marginBottom: 4, color: C.amber, fontSize: 12.5 }}>
              {error} You can still continue and self-rate.
            </div>
          )}
        </>
      )}
    </ExerciseBody>
  )
}

function ExerciseWriteDefinition({ word, onComplete }: { word: PracticeWord; onComplete: (result: StepCompletePayload) => void }) {
  const [text, setText] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [coach, setCoach] = useState<CoachResponse | null>(null)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [turnIndex, setTurnIndex] = useState(1)
  const [history, setHistory] = useState<CoachHistoryItem[]>([])
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { ref.current?.focus() }, [])

  const canRetry = !!coach && coach.verdict !== 'correct' && turnIndex < 2 && !checking

  async function submit() {
    if (!text.trim() || checking) return
    setSubmitted(true)
    setChecking(true)
    setError(null)
    try {
      const step = turnIndex === 1 ? 'answer' : 'retry'
      const result = await coachCard(word.id, {
        mode: 'review',
        step,
        turnIndex,
        learnerResponse: text,
        history,
      })
      setCoach(result)
      setHistory((h) => [
        ...h,
        { role: 'learner', text, step },
        { role: 'assistant', text: result.feedbackBody, step },
      ])
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'AI check unavailable.')
    } finally {
      setChecking(false)
    }
  }

  function startRetry() {
    setSubmitted(false)
    setText('')
    setCoach(null)
    setTurnIndex(2)
    setTimeout(() => ref.current?.focus(), 0)
  }

  function handleContinue() {
    if (!coach) {
      onComplete({ correct: true, typedResponse: text })
      return
    }
    onComplete({
      correct: coach.verdict !== 'incorrect',
      rating: coach.suggestedRating,
      typedResponse: text,
    })
  }

  let footer: ReactNode = null
  if (!submitted) {
    footer = <Btn onClick={() => void submit()} disabled={!text.trim()} style={{ width: '100%', padding: '12px 16px' }}>Check with AI</Btn>
  } else if (!checking && !coach && error) {
    footer = (
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
        <Btn variant="danger" onClick={() => onComplete({ rating: 'again', correct: false, typedResponse: text })}>Off</Btn>
        <Btn variant="warn" onClick={() => onComplete({ rating: 'hard', correct: true, typedResponse: text })}>Partial</Btn>
        <Btn variant="success" onClick={() => onComplete({ rating: 'good', correct: true, typedResponse: text })}>Spot on</Btn>
      </div>
    )
  } else if (canRetry) {
    footer = (
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <Btn variant="ghost" onClick={startRetry}>Try again</Btn>
        <Btn onClick={handleContinue} disabled={checking}>Use this answer →</Btn>
      </div>
    )
  } else if (submitted && !checking) {
    footer = <Btn onClick={handleContinue} disabled={checking} style={{ width: '100%', padding: '12px 16px' }}>Continue →</Btn>
  }

  return (
    <ExerciseBody footer={footer}>
      <ExerciseHeader title="Free Recall" subtitle="Write the definition from memory" />
      {!submitted ? (
        <>
          {turnIndex === 2 && coach === null && (
            <div style={{ padding: '10px 12px', background: `${C.amber}14`, border: `1px solid ${C.amber}40`, borderRadius: 12, marginBottom: 10, color: C.amber, fontSize: 12.5, fontFamily: FONT.ui }}>
              One more attempt — try to be more precise this time.
            </div>
          )}
          <textarea ref={ref} value={text} onChange={(e) => setText(e.target.value)} placeholder="What does this word mean?" rows={3} style={{ width: '100%', boxSizing: 'border-box', background: C.cardHi, border: `1px solid ${C.borderHi}`, borderRadius: 12, padding: '12px 14px', color: C.text, fontSize: 14, fontFamily: FONT.ui, outline: 'none', resize: 'vertical', maxHeight: 140, marginTop: 10, marginBottom: 4, lineHeight: 1.5 }} />
        </>
      ) : (
        <>
          <div style={{ marginTop: 10, marginBottom: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ padding: '12px 14px', background: 'rgba(0,0,0,0.04)', borderRadius: 10, border: `1px solid rgba(0,0,0,0.07)` }}>
              <div style={{ color: C.muted, fontSize: 10.5, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 4 }}>You wrote</div>
              <div style={{ color: C.text, fontSize: 14, fontFamily: FONT.ui, lineHeight: 1.5 }}>{text}</div>
            </div>
            <div style={{ padding: '12px 14px', background: `${C.gold}12`, borderRadius: 10, border: `1px solid ${C.gold}33` }}>
              <div style={{ color: C.gold, fontSize: 10.5, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 4, fontFamily: FONT.ui }}>Actual definition</div>
              <div style={{ color: C.text, fontSize: 14, fontFamily: FONT.display, fontStyle: 'italic', lineHeight: 1.5 }}>{word.definition}</div>
            </div>
          </div>
          {checking && <AICheckingBadge />}
          {!checking && coach && <AIVerdictCard check={coachToVocabCheck(coach)} />}
          {!checking && error && (
            <div style={{ padding: '10px 12px', background: `${C.amber}14`, border: `1px solid ${C.amber}40`, borderRadius: 12, marginBottom: 4, color: C.amber, fontSize: 12.5 }}>
              {error} You can still continue and self-rate.
            </div>
          )}
        </>
      )}
    </ExerciseBody>
  )
}

function ExerciseMnemonic({ word, onComplete }: { word: PracticeWord; onComplete: (result: StepCompletePayload) => void }) {
  const [text, setText] = useState(word.mnemonic ?? '')
  const [saved, setSaved] = useState(false)
  const [check, setCheck] = useState<VocabCheck | null>(null)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { ref.current?.focus() }, [])

  async function save() {
    if (text.trim().length < 10 || checking) return
    setSaved(true)
    setChecking(true)
    setError(null)
    try {
      const result = await aiCheckVocab({
        mode: 'mnemonic',
        word: word.word,
        definition: word.definition,
        userInput: text,
      })
      setCheck(result)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'AI check unavailable.')
    } finally {
      setChecking(false)
    }
  }

  function applySuggestion() {
    if (check?.suggestion) {
      setText(check.suggestion)
      setSaved(false)
      setCheck(null)
      setTimeout(() => ref.current?.focus(), 50)
    }
  }

  let footer: ReactNode = null
  if (!saved) {
    footer = (
      <Btn onClick={() => void save()} disabled={text.trim().length < 10} style={{ width: '100%', background: C.violet, color: '#ffffff', padding: '12px 16px' }}>
        Save & check with AI
      </Btn>
    )
  } else if (!checking) {
    footer = (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {check?.suggestion && (
          <Btn variant="ghost" onClick={applySuggestion} style={{ width: '100%', fontSize: 13, padding: '11px 14px' }}>
            Use AI's suggestion
          </Btn>
        )}
        <Btn onClick={() => onComplete({ correct: true, mnemonic: text })} style={{ width: '100%', padding: '12px 16px' }}>
          Continue →
        </Btn>
      </div>
    )
  }

  return (
    <ExerciseBody footer={footer}>
      <ExerciseHeader title="Memory Hook" subtitle="Build a mnemonic you'll see next time" />
      {isUsableDefinition(word.definition, word.word) && (
        <div style={{
          background: `linear-gradient(135deg, ${C.violet}12, rgba(0,0,0,0.03))`,
          border: `1px solid ${C.violet}25`, borderRadius: 12,
          padding: '10px 12px', marginTop: 10, marginBottom: 10,
          color: C.gold, fontSize: 13.5, fontFamily: FONT.display, fontStyle: 'italic', lineHeight: 1.45,
        }}>
          {word.definition}
        </div>
      )}
      {!saved ? (
        <textarea ref={ref} value={text} onChange={(e) => setText(e.target.value)} placeholder="An image, sound, or mini-story that makes it stick…" rows={3} style={{ width: '100%', boxSizing: 'border-box', background: C.cardHi, border: `1px solid ${C.violet}44`, borderRadius: 12, padding: '12px 14px', color: C.text, fontSize: 14, fontFamily: FONT.display, outline: 'none', resize: 'vertical', maxHeight: 140, marginBottom: 4, lineHeight: 1.5 }} />
      ) : (
        <>
          <div style={{ padding: '12px 14px', background: `${C.violet}18`, border: `1px solid ${C.violet}55`, borderRadius: 12, marginBottom: 10 }}>
            <div style={{ color: C.violet, fontSize: 10.5, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 6 }}>Your memory hook</div>
            <div style={{ color: C.text, fontSize: 14, fontFamily: FONT.display, fontStyle: 'italic', lineHeight: 1.5 }}>"{text}"</div>
          </div>
          {checking && <AICheckingBadge />}
          {!checking && check && <AIVerdictCard check={check} />}
          {!checking && error && (
            <div style={{ padding: '10px 12px', background: `${C.amber}14`, border: `1px solid ${C.amber}40`, borderRadius: 12, marginBottom: 4, color: C.amber, fontSize: 12.5 }}>
              {error} Saving your hook anyway.
            </div>
          )}
        </>
      )}
    </ExerciseBody>
  )
}

function Dashboard({
  deck,
  words,
  analytics,
  sessionMode,
  onModeChange,
  onStart,
  startDisabled,
  starting,
  enrichProgress,
  error,
  missedCount,
  onPracticeMissed,
}: {
  deck: DeckSummary
  words: SavedWord[]
  analytics?: DeckDashboard['analytics']
  sessionMode: SessionMode
  onModeChange: (mode: SessionMode) => void
  onStart: () => void
  startDisabled: boolean
  starting: boolean
  enrichProgress: { done: number; total: number } | null
  error: string | null
  missedCount: number
  onPracticeMissed: () => void
}) {
  const stageColor: Record<CardState, string> = { new: C.blue, learning: C.amber, review: C.green, relearning: C.violet }
  const dailyGoal = Math.max(10, Math.min(30, deck.dueToday || deck.dueNow || 10))
  const progress = Math.min(1, (deck.reviewsCompletedToday || 0) / dailyGoal)
  const ready = deck.dueNow + deck.newAvailable
  const stats = [
    { label: 'Due', value: deck.dueToday || deck.dueNow, color: C.gold },
    { label: 'New', value: deck.newAvailable ?? deck.cardsByState.new ?? 0, color: C.blue },
    { label: 'Total', value: deck.cardCount, color: C.orange },
    { label: 'Review', value: deck.cardsByState.review ?? 0, color: C.green },
  ]
  void analytics

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ marginBottom: 2 }}>
        <div style={{ fontSize: 26, fontWeight: 900, color: C.cream, lineHeight: 1.15, letterSpacing: '-0.02em' }}>
          {startDisabled ? 'All caught up!' : 'Practice vocabulary'}
        </div>
        <div style={{ color: C.mutedHi, fontSize: 13, marginTop: 4 }}>
          {ready > 0
            ? `${ready} card${ready === 1 ? '' : 's'} ready · definitions, cloze, and recall from your books`
            : 'Nothing due right now — come back after saving more words or when cards mature.'}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
        {stats.map((s) => (
          <div key={s.label} className="studio-card" style={{ padding: '10px 12px' }}>
            <div style={{ color: s.color, fontSize: 20, fontWeight: 900, letterSpacing: '-0.02em' }}>{s.value}</div>
            <div style={{ color: C.muted, fontSize: 10.5, marginTop: 1 }}>{s.label}</div>
          </div>
        ))}
      </div>

      <div className="studio-card" style={{ padding: 16 }}>
        <div style={{ color: C.text, fontSize: 13, fontWeight: 700, marginBottom: 10 }}>Session type</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 14 }}>
          {SESSION_MODES.map((m) => {
            const active = sessionMode === m.id
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => onModeChange(m.id)}
                style={{
                  textAlign: 'left',
                  padding: '10px 12px',
                  borderRadius: 12,
                  border: `1.5px solid ${active ? C.blue : C.border}`,
                  background: active ? `${C.blue}10` : C.cardHi,
                  cursor: 'pointer',
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 700, color: active ? C.blue : C.text }}>{m.label}</div>
                <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>{m.hint}</div>
              </button>
            )
          })}
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
          <span style={{ color: C.text, fontSize: 12.5, fontWeight: 600 }}>Today</span>
          <span style={{ color: C.gold, fontSize: 12, fontWeight: 700 }}>
            {deck.reviewsCompletedToday} / {dailyGoal} reviews
          </span>
        </div>
        <ProgressBar progress={progress} color={C.gold} height={5} />

        <Btn
          onClick={onStart}
          disabled={startDisabled || starting}
          style={{ width: '100%', marginTop: 14, borderRadius: 12, fontSize: 14.5, padding: '13px 20px' }}
        >
          {enrichProgress
            ? `Preparing words…  ${enrichProgress.done}/${enrichProgress.total}`
            : starting
              ? 'Starting…'
              : startDisabled
                ? 'All caught up ✓'
                : `Start ${SESSION_MODES.find((m) => m.id === sessionMode)?.label ?? 'session'} →`}
        </Btn>

        {missedCount > 0 && (
          <Btn
            variant="ghost"
            onClick={onPracticeMissed}
            disabled={starting}
            style={{ width: '100%', marginTop: 8, borderRadius: 12, fontSize: 13.5 }}
          >
            Retry {missedCount} missed word{missedCount === 1 ? '' : 's'}
          </Btn>
        )}

        {error && <div style={{ color: C.red, fontSize: 12, marginTop: 8 }}>{error}</div>}
      </div>

      <div>
        <div style={{ color: C.mutedHi, fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 8 }}>
          Your words
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {words.slice(0, 18).map((w) => (
            <div key={w.id} className="studio-card" style={{ padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ color: C.cream, fontWeight: 700, fontSize: 15, fontFamily: FONT.display, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.word}</div>
                  <Pill color={stageColor[w.stage]}>{w.stage}</Pill>
                </div>
                <div style={{ color: C.mutedHi, fontSize: 12, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {isUsableDefinition(w.definition, w.word) ? w.definition : w.book}
                </div>
              </div>
              <AudioBtn text={w.word} size={26} />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function PracticeScreen({
  step,
  stepIndex,
  totalSteps,
  distractors,
  onComplete,
  busy,
  sessionLabel,
}: {
  step: PracticeStep
  stepIndex: number
  totalSteps: number
  distractors: string[]
  onComplete: (result: StepCompletePayload) => void
  busy: boolean
  sessionLabel?: string
}) {
  const [xpAnim, setXpAnim] = useState<string | null>(null)
  const frameHeight = usePracticeFrameHeight()
  const progress = (stepIndex + 0.15) / Math.max(1, totalSteps)

  function handleComplete(payload: StepCompletePayload) {
    if (payload.correct) {
      const xp = payload.rating === 'easy' ? '+20 xp' : payload.rating === 'hard' ? '+10 xp' : '+15 xp'
      setXpAnim(xp)
      setTimeout(() => setXpAnim(null), 1400)
    }
    onComplete(payload)
  }

  // Listening + listen-and-type must NOT show the headword (that spoils the exercise).
  // Write/production exercises are tall after AI feedback — use compact hero + scroll body.
  const isListening = step.exercise === 'listening'
  const isDictation = step.exercise === 'reverse-recall'
  const compactHero = step.exercise === 'mcq'
    || step.exercise === 'write-sentence'
    || step.exercise === 'write-definition'
    || step.exercise === 'mnemonic'

  return (
    <div
      className="studio-practice-frame"
      style={{
        display: 'flex',
        flexDirection: 'column',
        // visualViewport-based height so browser zoom (70–100%) keeps Continue in view
        height: frameHeight,
        maxHeight: frameHeight,
        minHeight: 0,
        opacity: busy ? 0.72 : 1,
        pointerEvents: busy ? 'none' : 'auto',
        boxSizing: 'border-box',
      }}
    >
      {/* Session progress — sticky top (compact so tall cards fit under zoom) */}
      <div style={{ marginBottom: 8, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <span style={{
            fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
            color: C.blue, background: `${C.blue}12`, border: `1px solid ${C.blue}28`,
            padding: '3px 8px', borderRadius: 99,
          }}>
            {EXERCISE_LABEL[step.exercise] ?? step.exercise}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {xpAnim && (
              <span style={{ fontSize: 13, fontWeight: 800, color: C.green, animation: 'xpPop 1.4s ease forwards' }}>
                {xpAnim}
              </span>
            )}
            <span style={{ color: C.muted, fontSize: 12, fontFamily: FONT.mono }}>
              {stepIndex + 1}/{totalSteps}
              {sessionLabel ? ` · ${sessionLabel}` : ''}
            </span>
          </div>
        </div>
        <ProgressBar progress={progress} color={C.blue} height={4} />
      </div>

      {/* Word hero */}
      {step.exercise === 'cloze' ? (
        <div style={{ textAlign: 'center', paddingBottom: 12, flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
            <span style={{ fontSize: 13, color: C.mutedHi, fontStyle: 'italic' }}>Fill the blank from the passage</span>
          </div>
        </div>
      ) : isListening ? (
        <div style={{ textAlign: 'center', paddingBottom: 10, flexShrink: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: C.mutedHi }}>Listen carefully</div>
          <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>Pick the meaning — the word is hidden</div>
        </div>
      ) : isDictation ? (
        <div style={{ textAlign: 'center', paddingBottom: 10, flexShrink: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: C.mutedHi }}>Listen & type</div>
          <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>Spelling is hidden — use the play button</div>
        </div>
      ) : compactHero ? (
        <div style={{ textAlign: 'center', paddingBottom: 6, flexShrink: 0 }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <h2 style={{
              fontSize: 24, fontWeight: 700, fontFamily: FONT.display, color: C.text,
              letterSpacing: '-0.02em', lineHeight: 1.1, margin: 0,
            }}>
              {step.word.word}
            </h2>
            <AudioBtn text={step.word.word} size={28} />
          </div>
          {step.word.phonetic && (
            <div style={{ fontSize: 11, color: C.muted, fontFamily: FONT.mono, marginTop: 2 }}>{step.word.phonetic}</div>
          )}
        </div>
      ) : (
        <div style={{ textAlign: 'center', paddingBottom: 10, flexShrink: 0 }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10, marginBottom: 2 }}>
            <h2 style={{ fontSize: 28, fontWeight: 700, fontFamily: FONT.display, color: C.text, letterSpacing: '-0.02em', lineHeight: 1, margin: 0 }}>
              {step.word.word}
            </h2>
            <AudioBtn text={step.word.word} size={30} />
          </div>
          {step.word.phonetic && (
            <div style={{ fontSize: 11, color: C.muted, fontFamily: FONT.mono, marginBottom: 2 }}>{step.word.phonetic}</div>
          )}
          <div style={{ fontSize: 11, color: C.muted, fontStyle: 'italic' }}>from <em>{step.word.book}</em></div>
        </div>
      )}

      {/* Exercise card — fills remaining height; body scrolls, actions stay pinned */}
      <div
        key={step.id}
        className="studio-card studio-practice-card"
        style={{
          padding: '12px 12px 8px',
          animation: 'studioSlideIn 0.28s cubic-bezier(0.22,1,0.36,1)',
          flex: '1 1 auto',
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {step.exercise === 'mcq' && <ExerciseMCQ word={step.word} distractors={distractors} onComplete={handleComplete} />}
        {step.exercise === 'cloze' && <ExerciseCloze word={step.word} onComplete={handleComplete} />}
        {step.exercise === 'recall' && <ExerciseRecall word={step.word} onComplete={handleComplete} />}
        {step.exercise === 'reverse-recall' && <ExerciseReverseRecall word={step.word} onComplete={handleComplete} />}
        {step.exercise === 'listening' && <ExerciseListening word={step.word} distractors={distractors} onComplete={handleComplete} />}
        {step.exercise === 'write-sentence' && <ExerciseWriteSentence word={step.word} onComplete={handleComplete} />}
        {step.exercise === 'write-definition' && <ExerciseWriteDefinition word={step.word} onComplete={handleComplete} />}
        {step.exercise === 'mnemonic' && <ExerciseMnemonic word={step.word} onComplete={handleComplete} />}
      </div>

      {busy && <div style={{ color: C.muted, fontSize: 12, textAlign: 'center', marginTop: 6, flexShrink: 0 }}>Saving progress…</div>}
    </div>
  )
}

function outcomeStyle(outcome: 'correct' | 'retry' | 'again') {
  if (outcome === 'correct') {
    return { label: 'Correct', color: C.green }
  }
  if (outcome === 'retry') {
    return { label: 'Missed · recovered', color: C.amber }
  }
  return { label: 'Again', color: C.red }
}

function ResultsScreen({
  results,
  wordDetails,
  sessionXp,
  onDone,
  onPracticeAgain,
  onPracticeMissed,
}: {
  results: PracticeResult[]
  wordDetails: Map<string, { definition: string; book: string }>
  sessionXp: number
  onDone: () => void
  onPracticeAgain: () => void
  onPracticeMissed: () => void
}) {
  // Any miss on a word counts — do not let a later remedial hide an intentional mistake.
  const aggregated = aggregateSessionResults(results)
  const stats = sessionAccuracy(results)
  const missed = aggregated.filter((w) => w.needsRepeat)
  const celebration = stats.totalSteps > 0 && stats.stepAccuracy >= 80 && stats.wordsToRepeat === 0
  const earnedXp = sessionXp > 0
    ? sessionXp
    : results.reduce((sum, r) => sum + xpForRatingClient(r.rating), 0)

  if (stats.totalSteps === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, textAlign: 'center', paddingTop: 24 }}>
        <div style={{ fontSize: 22, fontWeight: 800, color: C.cream }}>No session data</div>
        <div style={{ color: C.mutedHi, fontSize: 14, lineHeight: 1.5 }}>
          This run didn’t record any exercises. Start a new session to earn XP and build your streak.
        </div>
        <Btn onClick={onPracticeAgain} style={{ width: '100%', background: C.blue, borderRadius: 14, fontSize: 14.5, padding: '14px 20px' }}>
          Start a session
        </Btn>
        <Btn variant="ghost" onClick={onDone} style={{ width: '100%', borderRadius: 14, fontSize: 14.5, padding: '14px 20px' }}>
          Back to words
        </Btn>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ textAlign: 'center', paddingTop: 12 }}>
        <div style={{ fontSize: 44, lineHeight: 1, marginBottom: 14 }}>{celebration ? '🎉' : stats.wordsToRepeat > 0 ? '📚' : '✓'}</div>
        <div style={{ fontSize: 24, fontWeight: 800, color: C.cream, letterSpacing: '-0.02em', marginBottom: 6 }}>
          Session complete
        </div>
        <div style={{ color: C.mutedHi, fontSize: 14 }}>
          {stats.correctSteps}/{stats.totalSteps} exercises right · {stats.wordCount} word{stats.wordCount !== 1 ? 's' : ''}
        </div>
        {earnedXp > 0 && (
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 10,
            background: `${C.gold}14`, color: C.gold, border: `1px solid ${C.gold}33`,
            borderRadius: 99, padding: '6px 12px', fontSize: 13, fontWeight: 800,
          }}>
            +{earnedXp} XP this session
          </div>
        )}
        {stats.wordsToRepeat > 0 && (
          <div style={{ color: C.amber, fontSize: 13, marginTop: 6, fontWeight: 600 }}>
            {stats.wordsToRepeat} word{stats.wordsToRepeat === 1 ? '' : 's'} worth another pass
          </div>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
        {[
          { label: 'Accuracy', value: `${stats.stepAccuracy}%`, color: C.blue },
          { label: 'Solid', value: stats.wordsCorrect, color: C.green },
          { label: 'To repeat', value: stats.wordsToRepeat, color: stats.wordsToRepeat > 0 ? C.amber : C.muted },
        ].map((s) => (
          <div key={s.label} className="studio-card" style={{ padding: '14px 12px', textAlign: 'center' }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: s.color, letterSpacing: '-0.02em' }}>{s.value}</div>
            <div style={{ fontSize: 11, color: C.muted, marginTop: 3 }}>{s.label}</div>
          </div>
        ))}
      </div>

      <div className="studio-card" style={{ padding: '4px 0' }}>
        {aggregated.map((r, i) => {
          const style = outcomeStyle(r.outcome)
          const detail = wordDetails.get(r.wordId ?? '') ?? wordDetails.get(r.word)
          return (
            <div
              key={r.wordId ?? r.word}
              style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12,
                padding: '12px 18px',
                borderBottom: i < aggregated.length - 1 ? '1px solid rgba(0,0,0,0.05)' : 'none',
              }}
            >
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 15, fontWeight: 600, color: C.cream, fontFamily: FONT.display }}>{r.word}</div>
                {detail?.definition && (
                  <div style={{ fontSize: 12.5, color: C.mutedHi, marginTop: 3, lineHeight: 1.45 }} className="line-clamp-2">
                    {detail.definition}
                  </div>
                )}
                {r.attempts > 1 && (
                  <div style={{ fontSize: 11, color: C.muted, marginTop: 3 }}>
                    {r.misses} miss{r.misses === 1 ? '' : 'es'} · {r.attempts} attempt{r.attempts === 1 ? '' : 's'}
                  </div>
                )}
              </div>
              <span style={{
                fontSize: 11.5, fontWeight: 700, flexShrink: 0, marginTop: 2,
                color: style.color,
                background: `${style.color}15`,
                padding: '4px 10px', borderRadius: 99,
                border: `1px solid ${style.color}33`,
              }}>
                {style.label}
              </span>
            </div>
          )
        })}
      </div>

      {missed.length > 0 && (
        <div className="studio-card" style={{ padding: '12px 14px', background: `${C.amber}08`, border: `1px solid ${C.amber}33` }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: C.amber, marginBottom: 4 }}>Practical tip</div>
          <div style={{ fontSize: 12.5, color: C.mutedHi, lineHeight: 1.5 }}>
            Re-run only the missed words while they’re fresh — short spaced loops beat long perfect sessions.
          </div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {missed.length > 0 && (
          <Btn
            onClick={onPracticeMissed}
            style={{ width: '100%', background: C.amber, borderRadius: 14, fontSize: 14.5, padding: '14px 20px' }}
          >
            Practice {missed.length} missed word{missed.length === 1 ? '' : 's'}
          </Btn>
        )}
        <Btn
          onClick={onPracticeAgain}
          style={{ width: '100%', background: C.blue, borderRadius: 14, fontSize: 14.5, padding: '14px 20px' }}
        >
          New full session
        </Btn>
        <Btn
          variant="ghost"
          onClick={onDone}
          style={{ width: '100%', borderRadius: 14, fontSize: 14.5, padding: '14px 20px' }}
        >
          Back to words
        </Btn>
      </div>
    </div>
  )
}

export function StudioRoute() {
  const queryClient = useQueryClient()
  const summaryQuery = useStudioSummary(true)
  const [screen, setScreen] = useState<Screen>('dashboard')
  const [deckSummary, setDeckSummary] = useState<DeckSummary | null>(null)
  const [sessionPlan, setSessionPlan] = useState<PracticeStep[]>([])
  const [practiceWords, setPracticeWords] = useState<PracticeWord[]>([])
  const [stepIndex, setStepIndex] = useState(0)
  const [results, setResults] = useState<PracticeResult[]>([])
  const [ratedCardIds, setRatedCardIds] = useState<Set<string>>(() => new Set())
  const [appendedRemedials, setAppendedRemedials] = useState(0)
  const [starting, setStarting] = useState(false)
  const [enrichProgress, setEnrichProgress] = useState<{ done: number; total: number } | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const [sessionMode, setSessionMode] = useState<SessionMode>('quick')
  const [sessionXp, setSessionXp] = useState(0)
  const stepStartedAt = useRef(Date.now())
  const sessionResultsRef = useRef<PracticeResult[]>([])

  const { data: decks = [], isLoading: decksLoading } = useQuery({
    queryKey: ['decks'],
    queryFn: async () => {
      const res = await api.get<{ items: DeckSummary[] }>('/api/vocabulary/decks')
      return res.items ?? []
    },
    staleTime: 60_000,
  })
  const deck = decks[0]

  const { data: dashboard, isLoading: dashboardLoading } = useQuery({
    queryKey: ['deck-dashboard', deck?.id],
    queryFn: () => api.get<DeckDashboard>(`/api/vocabulary/decks/${deck!.id}`),
    enabled: Boolean(deck?.id),
    staleTime: 60_000,
  })

  const activeDeck = deckSummary ?? dashboard?.deck ?? deck ?? null
  const savedWords = useMemo(
    () => (dashboard?.notes ?? [])
      .filter((n) => isVocabWord(n.front))
      .map(noteToSavedWord),
    [dashboard?.notes],
  )
  const distractorCandidates = useMemo(() => {
    const fromSaved = savedWords.map((w) => ({ word: w.word, definition: w.definition }))
    const fromSession = practiceWords.map((w) => ({ word: w.word, definition: w.definition }))
    return [...fromSaved, ...fromSession]
      .filter((c) => c.word && isUsableDefinition(c.definition, c.word))
  }, [practiceWords, savedWords])
  const currentStep = sessionPlan[stepIndex]
  const isLoading = decksLoading || (Boolean(deck?.id) && dashboardLoading)

  const startSession = useCallback(async (opts?: {
    mode?: SessionMode
    onlyWordIds?: string[]
  }) => {
    if (!deck) {
      setStartError('No vocabulary deck found. Save a word from the reader first.')
      return
    }
    if (starting) return
    const mode = opts?.mode ?? sessionMode
    const onlyIds = opts?.onlyWordIds
    setStarting(true)
    setStartError(null)
    setEnrichProgress(null)
    try {
      const limit = onlyIds?.length
        ? Math.max(onlyIds.length, 1)
        : sessionLimitForMode(mode)
      const focus = mode === 'weak' ? 'weak' : mode === 'due' ? 'mixed' : 'mixed'
      const res = await api.post<PracticeSessionResponse>(`/api/vocabulary/decks/${deck.id}/practice-sessions`, {
        focus,
        // Request a generous pool; worker now fills non-due cards after a session.
        limit: Math.max(limit, 24),
      })
      const sessionItems = res.items ?? res.cards ?? []
      if (!Array.isArray(sessionItems)) {
        throw new Error('Practice session response was missing items.')
      }
      const allWords = sessionItems.map(cardToPracticeWord)
      let words = allWords.filter((w) => isVocabWord(w.word))

      if (onlyIds && onlyIds.length > 0) {
        const want = new Set(onlyIds)
        words = words.filter((w) => want.has(w.id) || want.has(w.noteId) || want.has(w.word))
        // If API queue didn't include all missed ids, keep what we can from last session cache.
        if (words.length === 0 && practiceWords.length > 0) {
          words = practiceWords.filter((w) => want.has(w.id) || want.has(w.noteId) || want.has(w.word))
        }
      } else {
        words = prioritizeWordsForMode(words, mode).slice(0, limit)
      }

      // Prefer study-ready defs, but never hard-fail a restart if cards exist.
      const withDefs = words.filter((w) => isUsableDefinition(w.definition, w.word))
      if (withDefs.length > 0) words = withDefs

      if (words.length === 0) {
        setScreen('dashboard')
        setStartError(
          onlyIds?.length
            ? 'Could not reload those missed words. Try a full session.'
            : allWords.length > 0
              ? 'Your cards need definitions before practice. Open Words to backfill, then try again.'
              : 'No practice items are ready yet. Save a word from the reader first.',
        )
        return
      }

      // Always sanitize: each word gets its own ranked definition; kill shared fake
      // "In the story, the idea of…" templates so cloze never sees them.
      const needsEnrichment = words.some((w) => (
        shouldRefreshDefinition(w.definition, w.word)
        || !isUsableDefinition(w.definition, w.word)
        || isFabricatedContextSentence(w.sentence, w.word, w.definition)
        || (Boolean(w.sentence) && !isRealBookSentence(w.sentence, w.word, w.definition))
      ))
      if (needsEnrichment) {
        setEnrichProgress({ done: 0, total: words.length })
        const enrichedById = new Map<string, { definition: string; sentence: string; phonetic: string | null }>()
        let done = 0
        await Promise.all(
          words.map(async (w) => {
            const needsDef = shouldRefreshDefinition(w.definition, w.word)
              || !isUsableDefinition(w.definition, w.word)
            const sentenceIsFake = Boolean(w.sentence)
              && !isRealBookSentence(w.sentence, w.word, w.definition)
            try {
              // Real book line only (never the shared template).
              let bookContext = isRealBookSentence(w.sentence, w.word, w.definition)
                ? w.sentence
                : ''
              if (!bookContext) {
                try {
                  const ctx = await fetchCardContext(w.id)
                  if (isRealBookSentence(ctx.contextParagraph, w.word, ctx.definition)) {
                    bookContext = ctx.contextParagraph
                  }
                } catch { /* optional */ }
              }

              let nextDef = w.definition
              let nextPhonetic = w.phonetic
              let dictExample: string | null = null

              // Look up THIS word only (never reuse another card's gloss).
              if (needsDef) {
                const hit = await lookupWordDefinition(w.word, { context: bookContext || null })
                if (hit && isUsableDefinition(hit.definition, w.word)) {
                  nextDef = formatStudyDefinition(hit.definition, hit.partOfSpeech)
                  nextPhonetic = hit.pronunciation ?? nextPhonetic
                  dictExample = hit.example
                }
              }

              // Prefer real book context; else a dictionary example that contains the word;
              // else empty (cloze will not be scheduled without a real sentence).
              let nextSentence = bookContext
              if (!nextSentence && dictExample && isRealBookSentence(dictExample, w.word, nextDef)) {
                nextSentence = dictExample
              }
              if (sentenceIsFake && !nextSentence) nextSentence = ''

              // Persist per-word fix. Use '' (not null) so COALESCE overwrites the old template.
              if (deck?.id && (needsDef || sentenceIsFake)) {
                void api.post(`/api/vocabulary/decks/${deck.id}/notes`, {
                  noteType: 'basic',
                  front: w.word,
                  back: nextDef || w.definition || w.word,
                  extra: nextPhonetic,
                  // Empty string clears fabricated example_sentence in D1.
                  exampleSentence: nextSentence || '',
                  topic: w.book || 'Reading',
                  metadata: {
                    dictionarySource: 'ranked-per-word',
                    rankedDefinition: true,
                    clearedFabricatedContext: sentenceIsFake,
                  },
                }).catch(() => { /* non-blocking */ })
              }

              enrichedById.set(w.id, {
                definition: nextDef,
                sentence: nextSentence,
                phonetic: nextPhonetic,
              })
            } catch (err) {
              console.warn('Definition enrich failed for', w.word, err)
              // Still strip fabricated sentence from the live session even if lookup fails.
              if (sentenceIsFake) {
                enrichedById.set(w.id, {
                  definition: w.definition,
                  sentence: '',
                  phonetic: w.phonetic,
                })
              }
            } finally {
              done += 1
              setEnrichProgress({ done, total: words.length })
            }
          }),
        )
        if (enrichedById.size > 0) {
          words = words.map((w) => {
            const hit = enrichedById.get(w.id)
            if (!hit) return w
            return {
              ...w,
              definition: hit.definition || w.definition,
              sentence: hit.sentence,
              phonetic: hit.phonetic ?? w.phonetic,
              card: { ...w.card, productionTarget: w.word },
            }
          })
        }
        setEnrichProgress(null)
      }

      // Hard filter: no practice step may carry a fabricated template.
      words = words.map((w) => (
        isRealBookSentence(w.sentence, w.word, w.definition)
          ? w
          : { ...w, sentence: '' }
      ))

      const plan = buildSessionPlan(words)
      if (plan.length === 0) {
        setStartError('No practice items are ready yet.')
        return
      }

      setDeckSummary(res.deck ?? activeDeck)
      setPracticeWords(words)
      setSessionPlan(plan)
      sessionResultsRef.current = []
      setResults([])
      setSessionXp(0)
      setRatedCardIds(new Set())
      setAppendedRemedials(0)
      setStepIndex(0)
      stepStartedAt.current = Date.now()
      setScreen('practice')
    } catch (error) {
      console.error('Failed to start studio session', error)
      const message = error instanceof Error ? error.message : String(error)
      setStartError(
        /401|Unauthorized|sign in/i.test(message)
          ? 'Sign in again to practice.'
          : 'Could not start a practice session. Try again.',
      )
    } finally {
      setStarting(false)
      setEnrichProgress(null)
    }
  }, [activeDeck, deck, practiceWords, sessionMode, starting])

  const persistMnemonic = useCallback(async (step: PracticeStep, mnemonic: string) => {
    const trimmed = mnemonic.trim()
    if (!trimmed) return
    setPracticeWords((words) => words.map((word) => (
      word.noteId === step.word.noteId ? { ...word, mnemonic: trimmed, card: { ...word.card, mnemonic: trimmed } } : word
    )))
    setSessionPlan((steps) => steps.map((item) => (
      item.word.noteId === step.word.noteId
        ? { ...item, word: { ...item.word, mnemonic: trimmed, card: { ...item.word.card, mnemonic: trimmed } } }
        : item
    )))
    await api.patch(`/api/vocabulary/notes/${step.word.noteId}/mnemonic`, { mnemonic: trimmed })
    queryClient.invalidateQueries({ queryKey: ['deck-dashboard', step.word.card.deckId] })
  }, [queryClient])

  const completeStep = useCallback(async (payload: StepCompletePayload) => {
    const step = sessionPlan[stepIndex]
    if (!step || submitting) return
    setSubmitting(true)
    try {
      if (payload.mnemonic) {
        await persistMnemonic(step, payload.mnemonic)
      }

      const rating = ratingFromResult(step.exercise, payload)
      // A miss is any incorrect answer or an explicit "again" self-rate.
      const missed = !payload.correct || rating === 'again' || payload.rating === 'again'
      const effectiveRating: Rating | null = rating
        ?? (missed ? 'again' : payload.correct ? 'good' : 'again')

      // Persist the *worst* rating seen for this card in the session so a later
      // remedial success cannot erase an earlier "again" from spaced repetition.
      let awarded = 0
      if (effectiveRating) {
        const previous = ratedCardIds.has(step.word.card.id)
        const priorResults = sessionResultsRef.current.filter((r) => r.wordId === step.word.id)
        const priorWorst = priorResults.reduce<Rating | null>((acc, r) => (
          worseRating(acc, (r.rating as PlanRating | undefined) ?? (r.correct ? 'good' : 'again'))
        ), null)
        const shouldSubmit = !previous || (
          effectiveRating === 'again'
          && priorWorst !== 'again'
        )
        if (shouldSubmit) {
          const responseMs = Math.max(0, Date.now() - stepStartedAt.current)
          try {
            const review = await api.post<ReviewResponse>(`/api/vocabulary/cards/${step.word.card.id}/reviews`, {
              rating: effectiveRating,
              responseMs,
              answerMode: answerModeForExercise(step.exercise),
              typedResponse: payload.typedResponse ?? null,
            })
            setDeckSummary(review.summary)
            setRatedCardIds((prev) => new Set(prev).add(step.word.card.id))
            awarded = review.xpAwarded ?? xpForRatingClient(effectiveRating)
            setSessionXp((x) => x + awarded)
            // Keep streak / XP chips live without waiting for a full refetch.
            queryClient.setQueryData(['learning-summary'], (prev: {
              streakDays: number
              xpToday: number
              xpThisWeek: number
              dailyGoal: number
              dailyGoalProgress: number
              reviewsToday?: number
            } | undefined) => {
              if (!prev) {
                return {
                  streakDays: 1,
                  xpToday: awarded,
                  xpThisWeek: awarded,
                  dailyGoal: 20,
                  dailyGoalProgress: Math.min(1, 1 / 20),
                  reviewsToday: 1,
                }
              }
              const reviewsToday = (prev.reviewsToday ?? 0) + 1
              return {
                ...prev,
                streakDays: Math.max(prev.streakDays, 1),
                xpToday: prev.xpToday + awarded,
                xpThisWeek: prev.xpThisWeek + awarded,
                dailyGoalProgress: Math.min(1, reviewsToday / (prev.dailyGoal || 20)),
                reviewsToday,
              }
            })
          } catch (reviewErr) {
            console.error('Review save failed; keeping session progress locally', reviewErr)
            // Don't block the session UI if the review API hiccups.
            awarded = xpForRatingClient(effectiveRating)
            setSessionXp((x) => x + awarded)
            setRatedCardIds((prev) => new Set(prev).add(step.word.card.id))
          }
        } else {
          // Still count local session XP for non-submitted remedials.
          awarded = xpForRatingClient(effectiveRating)
          setSessionXp((x) => x + Math.max(0, Math.floor(awarded / 2)))
        }
      }

      const entry: PracticeResult = {
        stepId: step.id,
        wordId: step.word.id,
        word: step.word.word,
        exercise: step.exercise,
        // Normalize: again-rating always counts as not correct in the session log.
        correct: !missed,
        rating: effectiveRating ?? undefined,
      }
      const nextResults = [...sessionResultsRef.current, entry]
      sessionResultsRef.current = nextResults
      setResults(nextResults)

      const nextIndex = stepIndex + 1
      const isLastStep = nextIndex >= sessionPlan.length
      const failed = missed
      // Adaptive re-queueing: append remedial on any failed objective item, or
      // when the last step would otherwise end the session on a failure.
      const shouldAppendRemedial = failed && (
        step.exercise === 'mcq'
        || step.exercise === 'cloze'
        || step.exercise === 'listening'
        || step.exercise === 'reverse-recall'
        || step.exercise === 'write-definition'
        || step.exercise === 'recall'
        || isLastStep
      )
      if (shouldAppendRemedial) {
        const remedial = buildRemedialStep(step, AVAILABLE_EXERCISES, appendedRemedials)
        if (remedial) {
          setSessionPlan((p) => [...p, remedial as PracticeStep])
          setAppendedRemedials((c) => c + 1)
          setStepIndex(nextIndex)
          stepStartedAt.current = Date.now()
          return
        }
      }
      if (isLastStep) {
        setScreen('results')
        queryClient.invalidateQueries({ queryKey: ['decks'] })
        queryClient.invalidateQueries({ queryKey: ['deck-dashboard'] })
        queryClient.invalidateQueries({ queryKey: ['learning-summary'] })
      } else {
        setStepIndex(nextIndex)
        stepStartedAt.current = Date.now()
      }
    } catch (error) {
      console.error('Failed to save practice step', error)
      setStartError('Could not save this practice step. Try again.')
    } finally {
      setSubmitting(false)
    }
  }, [appendedRemedials, persistMnemonic, queryClient, ratedCardIds, results, sessionPlan, stepIndex, submitting])

  // Derive missed list from results (no setState-in-effect).
  const missedWordIds = useMemo(() => {
    const log = results.length > 0 ? results : sessionResultsRef.current
    if (log.length === 0) return [] as string[]
    return aggregateSessionResults(log)
      .filter((w) => w.needsRepeat)
      .map((w) => w.wordId || w.word)
  }, [results])

  function resetSessionLocalState() {
    sessionResultsRef.current = []
    setResults([])
    setSessionXp(0)
    setRatedCardIds(new Set())
    setAppendedRemedials(0)
    setStepIndex(0)
  }

  function backToDashboard() {
    queryClient.invalidateQueries({ queryKey: ['decks'] })
    queryClient.invalidateQueries({ queryKey: ['deck-dashboard'] })
    queryClient.invalidateQueries({ queryKey: ['learning-summary'] })
    setScreen('dashboard')
    setDeckSummary(null)
    setSessionPlan([])
    setPracticeWords([])
    resetSessionLocalState()
  }

  function practiceAgain() {
    // Always force a full restart from results — don't depend on current due queue.
    setSessionMode('full')
    setDeckSummary(null)
    setSessionPlan([])
    setPracticeWords([])
    resetSessionLocalState()
    setStartError(null)
    setScreen('dashboard')
    // Kick off immediately; dashboard shows the starting skeleton while starting=true.
    void startSession({ mode: 'full' })
  }

  function practiceMissed() {
    const ids = missedWordIds.length > 0
      ? missedWordIds
      : aggregateSessionResults(sessionResultsRef.current).filter((w) => w.needsRepeat).map((w) => w.wordId || w.word)
    setDeckSummary(null)
    setSessionPlan([])
    resetSessionLocalState()
    setStartError(null)
    setScreen('dashboard')
    if (ids.length === 0) {
      void startSession({ mode: 'full' })
      return
    }
    void startSession({ onlyWordIds: ids, mode: 'full' })
  }

  // Allow practice whenever the deck has cards — "due" modes still prefer ready ones.
  const startDisabled = !activeDeck || (activeDeck.cardCount ?? 0) === 0

  const wordDetails = useMemo(() => {
    const map = new Map<string, { definition: string; book: string }>()
    for (const w of practiceWords) {
      map.set(w.id, { definition: w.definition, book: w.book })
      map.set(w.word, { definition: w.definition, book: w.book })
    }
    return map
  }, [practiceWords])

  return (
    <div
      style={{
        background: GRAD,
        minHeight: screen === 'practice' ? undefined : '100%',
        // Practice fills the parent main pane; no 100svh (that double-counts shell chrome / zoom).
        height: screen === 'practice' ? '100%' : undefined,
        overflow: screen === 'practice' ? 'hidden' : undefined,
        color: C.text,
        fontFamily: FONT.ui,
        display: 'flex',
        justifyContent: 'center',
        padding: screen === 'practice' ? 0 : '0 0 40px',
        boxSizing: 'border-box',
      }}
    >
      <style>{`
        @keyframes studioFadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes studioSlideIn { from { opacity: 0; transform: translateX(18px) scale(0.97); } to { opacity: 1; transform: translateX(0) scale(1); } }
        @keyframes studioSpin { to { transform: rotate(360deg); } }
        @keyframes xpPop { 0% { opacity:0; transform:translateY(4px) scale(0.9); } 15% { opacity:1; transform:translateY(0) scale(1.1); } 80% { opacity:1; transform:translateY(-2px) scale(1); } 100% { opacity:0; transform:translateY(-12px); } }
        .studio-scope input::placeholder, .studio-scope textarea::placeholder { color: ${C.muted}; opacity: 1; }
        .studio-scope input:focus, .studio-scope textarea:focus { border-color: ${C.gold} !important; outline: none; box-shadow: 0 0 0 3px ${C.gold}28; }
        .studio-card { background: #fff; border-radius: 20px; box-shadow: ${CARD_SHADOW}; }
        .studio-practice-card > * { min-height: 0; flex: 1 1 auto; display: flex; flex-direction: column; }
      `}</style>
      <div
        className="studio-scope"
        style={{
          width: '100%',
          maxWidth: 560,
          // Practice mode: tight padding; height comes from visualViewport measure.
          padding: screen === 'practice' ? '10px 14px 8px' : '20px 16px 80px',
          boxSizing: 'border-box',
          height: screen === 'practice' ? '100%' : undefined,
          minHeight: 0,
          display: screen === 'practice' ? 'flex' : undefined,
          flexDirection: screen === 'practice' ? 'column' : undefined,
          overflow: screen === 'practice' ? 'hidden' : undefined,
        }}
      >
        {(screen === 'dashboard' || screen === 'results') && activeDeck && (
          <StudioHeader summary={summaryQuery.data} isLoading={summaryQuery.isLoading} />
        )}

        {isLoading || (starting && screen === 'dashboard') ? (
          <div style={{ display: 'grid', gap: 12 }}>
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} style={{ height: i === 0 ? 130 : 80, borderRadius: 20, background: 'rgba(255,255,255,0.5)', animation: 'studioFadeIn 1s ease infinite alternate' }} />
            ))}
          </div>
        ) : !activeDeck ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '92px 18px', textAlign: 'center' }}>
            <div style={{ width: 72, height: 72, borderRadius: 22, background: '#fff', boxShadow: CARD_SHADOW, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 18 }}>
              <BookOpen size={30} color={C.muted} />
            </div>
            <div style={{ color: C.cream, fontWeight: 800, fontSize: 18, marginBottom: 6 }}>No vocabulary deck yet</div>
            <div style={{ color: C.mutedHi, fontSize: 14, lineHeight: 1.6 }}>Save words from the reader and they will appear here for practice.</div>
          </div>
        ) : screen === 'dashboard' ? (
          <Dashboard
            deck={activeDeck}
            words={savedWords}
            analytics={dashboard?.analytics}
            sessionMode={sessionMode}
            onModeChange={setSessionMode}
            onStart={() => void startSession({ mode: sessionMode })}
            startDisabled={startDisabled}
            starting={starting}
            enrichProgress={enrichProgress}
            error={startError}
            missedCount={missedWordIds.length}
            onPracticeMissed={practiceMissed}
          />
        ) : screen === 'practice' && currentStep ? (
          <PracticeScreen
            step={currentStep}
            stepIndex={stepIndex}
            totalSteps={sessionPlan.length}
            sessionLabel={SESSION_MODES.find((m) => m.id === sessionMode)?.label}
            distractors={pickDistractors(
              currentStep.word.word,
              distractorCandidates,
              3,
              currentStep.word.definition,
            )}
            onComplete={completeStep}
            busy={submitting}
          />
        ) : screen === 'practice' ? (
          <div style={{ color: C.mutedHi, textAlign: 'center', padding: '48px 16px' }}>
            Preparing next card…
          </div>
        ) : screen === 'results' ? (
          <ResultsScreen
            results={results.length > 0 ? results : sessionResultsRef.current}
            wordDetails={wordDetails}
            sessionXp={sessionXp}
            onDone={backToDashboard}
            onPracticeAgain={practiceAgain}
            onPracticeMissed={practiceMissed}
          />
        ) : (
          <Dashboard
            deck={activeDeck}
            words={savedWords}
            analytics={dashboard?.analytics}
            sessionMode={sessionMode}
            onModeChange={setSessionMode}
            onStart={() => void startSession({ mode: sessionMode })}
            startDisabled={startDisabled}
            starting={starting}
            enrichProgress={enrichProgress}
            error={startError}
            missedCount={missedWordIds.length}
            onPracticeMissed={practiceMissed}
          />
        )}
      </div>
    </div>
  )
}
