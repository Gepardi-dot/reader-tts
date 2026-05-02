import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { BookOpen, Check, Circle, Sparkles, X } from 'lucide-react'
import { api } from '@/shared/api/client'
import { isVocabWord, isPlaceholderDefinition } from './vocabUtils'

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

function verdictToRating(v: VocabCheck['verdict']): Rating {
  return v === 'correct' ? 'good' : v === 'partial' ? 'hard' : 'again'
}

interface AIDefinition {
  definition: string
  partOfSpeech: string | null
  example: string | null
}

async function aiDefineWord(word: string, bookSentence?: string | null): Promise<AIDefinition> {
  return api.post<AIDefinition>('/api/ai/define-word', {
    word,
    book_sentence: bookSentence ?? null,
  })
}

type CardState = 'new' | 'learning' | 'review' | 'relearning'
type ExerciseType = 'mcq' | 'cloze' | 'mnemonic' | 'recall' | 'write-sentence' | 'write-definition'
type Screen = 'dashboard' | 'practice' | 'results'

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
}

interface PracticeSessionResponse {
  deck: DeckSummary
  focus: string
  items: SessionCard[]
}

interface ReviewResponse {
  summary: DeckSummary
  nextCard: SessionCard | null
}

function progressPercent(progress: number) {
  return `${Math.min(100, Math.max(0, progress * 100))}%`
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function speak(text: string) {
  try {
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.rate = 0.85
    window.speechSynthesis.speak(utterance)
  } catch {
    // Speech synthesis is optional; unsupported browsers can ignore this.
  }
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
  const answer = (card.cardType === 'reverse' ? card.cue : card.answer).trim()
  return answer || card.explanation || card.extra || 'Saved from your reading.'
}

function sentenceForCard(card: SessionCard, word: string, definition: string) {
  return card.exampleSentence || card.explanation || card.extra || `${word} means ${definition}.`
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
  const steps: PracticeStep[] = []
  words.forEach((word, index) => {
    const base = `${word.id}-${index}`
    if (word.stage === 'new') {
      steps.push({ id: `${base}-mcq`, word, exercise: 'mcq' })
      if (!word.mnemonic) steps.push({ id: `${base}-mnemonic`, word, exercise: 'mnemonic' })
      return
    }
    if (word.stage === 'learning' || word.stage === 'relearning') {
      steps.push({ id: `${base}-cloze`, word, exercise: 'cloze' })
      steps.push({ id: `${base}-recall`, word, exercise: 'recall' })
      return
    }
    steps.push({ id: `${base}-${index % 3 === 0 ? 'recall' : index % 3 === 1 ? 'write-sentence' : 'write-definition'}`, word, exercise: index % 3 === 0 ? 'recall' : index % 3 === 1 ? 'write-sentence' : 'write-definition' })
  })
  return steps.slice(0, 12)
}

function ratingFromResult(exercise: ExerciseType, result: StepCompletePayload): Rating | null {
  if (result.rating) return result.rating
  if (exercise === 'mnemonic') return null
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
  function go(e: React.MouseEvent) {
    e.stopPropagation()
    speak(text)
    setSpeaking(true)
    setTimeout(() => setSpeaking(false), 2200)
  }
  return (
    <button
      onClick={go}
      aria-label={`Pronounce ${text}`}
      style={{
        width: size, height: size, borderRadius: '50%',
        background: speaking ? C.blue : `${C.blue}15`,
        border: `1.5px solid ${speaking ? C.blue : `${C.blue}44`}`,
        color: speaking ? '#fff' : C.blue,
        cursor: 'pointer',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        transition: 'all 0.2s', flex: '0 0 auto',
        boxShadow: speaking ? `0 0 0 4px ${C.blue}22` : 'none',
      }}
      onMouseEnter={(e) => { if (!speaking) { e.currentTarget.style.background = `${C.blue}28` } }}
      onMouseLeave={(e) => { if (!speaking) { e.currentTarget.style.background = `${C.blue}15` } }}
    >
      <svg width={Math.round(size * 0.44)} height={Math.round(size * 0.44)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
        <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
        <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
      </svg>
    </button>
  )
}


function ExerciseHeader({ title, subtitle, word }: { title: string; subtitle?: string; word?: string }) {
  return (
    <div style={{ marginBottom: 2 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 4 }}>
        <Pill color={C.gold}>{title}</Pill>
        {word && <AudioBtn text={word} size={26} />}
      </div>
      {subtitle && <div style={{ color: C.muted, fontSize: 12, fontFamily: FONT.ui }}>{subtitle}</div>}
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
  const [options] = useState(() => {
    const fallback = ['Brief and direct', 'Difficult to understand', 'Full of careful detail', 'Done with strong emotion']
    const pool = [...distractors, ...fallback].filter(item => item && item !== word.definition)
    return shuffle([word.definition, ...Array.from(new Set(pool)).slice(0, 3)])
  })

  const revealed = selected !== null
  const correct = selected === word.definition

  return (
    <div>
      <ExerciseHeader title="Multiple Choice" subtitle={`from ${word.book}`} word={word.word} />
      <div style={{ fontFamily: FONT.display, fontSize: 24, fontWeight: 700, color: C.cream, marginTop: 10, marginBottom: 4, letterSpacing: '-0.01em', lineHeight: 1.3 }}>
        {word.word}
      </div>
      {word.phonetic && <div style={{ color: C.muted, fontSize: 13, fontFamily: FONT.mono, marginBottom: 16 }}>{word.phonetic}</div>}
      <div style={{ color: C.mutedHi, fontSize: 13, marginBottom: 10, fontFamily: FONT.ui }}>Which definition is correct?</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {options.map((opt, i) => {
          const isSel = selected === opt
          const isCorrect = opt === word.definition
          let bg = C.cardHi
          let bd = C.border
          let col = C.text
          if (revealed) {
            if (isCorrect) { bg = `${C.green}20`; bd = `${C.green}66`; col = C.green }
            else if (isSel) { bg = `${C.red}20`; bd = `${C.red}66`; col = C.red }
          }
          return (
            <button
              key={opt}
              onClick={() => !revealed && setSelected(opt)}
              style={{
                background: bg,
                border: `1px solid ${bd}`,
                borderRadius: 12,
                padding: '13px 15px',
                color: col,
                fontSize: 14,
                textAlign: 'left',
                cursor: revealed ? 'default' : 'pointer',
                fontFamily: FONT.ui,
                transition: 'all 0.2s',
                lineHeight: 1.4,
              }}
            >
              {String.fromCharCode(65 + i)}. {opt}
            </button>
          )
        })}
      </div>

      {revealed && (
        <>
          <div
            style={{
              marginTop: 14,
              padding: '12px 14px',
              background: `${correct ? C.green : C.red}14`,
              border: `1px solid ${correct ? C.green : C.red}33`,
              borderRadius: 10,
              color: correct ? C.green : C.red,
              fontSize: 13,
              fontFamily: FONT.ui,
              fontWeight: 600,
              display: 'flex',
              gap: 8,
              alignItems: 'center',
            }}
          >
            {correct ? <Check size={14} /> : <X size={14} />}
            {correct ? 'Correct' : 'Not quite'}
          </div>
          <div style={{ marginTop: 14 }}>
            <Btn onClick={() => onComplete({ correct })} style={{ width: '100%' }}>Continue</Btn>
          </div>
        </>
      )}

    </div>
  )
}

function ExerciseCloze({ word, onComplete }: { word: PracticeWord; onComplete: (result: StepCompletePayload) => void }) {
  const [input, setInput] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { inputRef.current?.focus() }, [])

  const correct = input.trim().toLowerCase() === word.word.toLowerCase()
  const pattern = new RegExp(escapeRegExp(word.word), 'i')
  const match = word.sentence.match(pattern)
  const before = match ? word.sentence.slice(0, match.index) : ''
  const after = match ? word.sentence.slice((match.index ?? 0) + match[0].length) : word.sentence

  return (
    <div>
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
        <>
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
              marginBottom: 12,
            }}
          />
          <Btn onClick={() => setSubmitted(true)} disabled={!input.trim()} style={{ width: '100%' }}>Check</Btn>
        </>
      ) : (
        <>
          <div style={{ padding: '12px 14px', background: `${correct ? C.green : C.red}14`, border: `1px solid ${correct ? C.green : C.red}33`, borderRadius: 10, color: correct ? C.green : C.red, fontSize: 13, fontFamily: FONT.ui, fontWeight: 600, marginBottom: 12 }}>
            {correct ? 'Exactly right' : `The word was "${word.word}"`}
          </div>
          <Btn onClick={() => onComplete({ correct, typedResponse: input })} style={{ width: '100%' }}>Continue</Btn>
        </>
      )}

    </div>
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
    <div>
      <ExerciseHeader title="Active Recall" />
      <p style={{ color: '#4a4a46', fontSize: 14, lineHeight: 1.55, margin: '0 0 16px' }}>
        Recall the definition silently, then reveal and rate yourself.
      </p>

      {!revealed ? (
        <>
          <div
            onClick={() => setRevealed(true)}
            style={{
              background: '#eff6ff',
              border: '1.5px solid #93c5fd',
              borderRadius: 14,
              padding: '34px 20px',
              textAlign: 'center',
              cursor: 'pointer',
              marginBottom: 14,
              transition: 'background 0.15s',
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = '#dbeafe' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = '#eff6ff' }}
          >
            <div style={{ color: '#93c5fd', fontSize: 20, letterSpacing: 10, marginBottom: 10 }}>— — — — — —</div>
            <div style={{ color: '#2563eb', fontSize: 13.5, fontWeight: 600, fontFamily: FONT.ui }}>Click to reveal</div>
          </div>
          <Btn onClick={() => setRevealed(true)} style={{ width: '100%', background: C.blue }}>Reveal definition</Btn>
        </>
      ) : (
        <>
          <div style={{ borderRadius: 14, overflow: 'hidden', marginBottom: 14, animation: 'studioFadeIn 0.3s ease', border: '1px solid rgba(0,0,0,0.07)' }}>
            <div style={{ padding: '14px 16px', background: `${C.gold}10` }}>
              <div style={{ color: C.gold, fontSize: 16, fontFamily: FONT.display, fontStyle: 'italic', lineHeight: 1.55 }}>{word.definition}</div>
            </div>
            <div style={{ background: 'rgba(0,0,0,0.03)', borderLeft: `3px solid ${C.gold}`, padding: '10px 14px' }}>
              <div style={{ color: C.muted, fontSize: 10.5, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 4 }}>{word.book}</div>
              <div style={{ color: C.text, fontSize: 14, lineHeight: 1.6, fontFamily: FONT.display, fontStyle: 'italic' }}>"{word.sentence}"</div>
            </div>
            {word.mnemonic && (
              <div style={{ padding: '10px 14px', background: `${C.violet}10`, borderTop: `1px solid ${C.violet}22` }}>
                <div style={{ color: C.violet, fontSize: 10.5, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 3 }}>Memory hook</div>
                <div style={{ color: C.text, fontSize: 13, lineHeight: 1.5 }}>{word.mnemonic}</div>
              </div>
            )}
          </div>

          <div style={{ color: C.mutedHi, fontSize: 11.5, textAlign: 'center', marginBottom: 10, fontFamily: FONT.ui, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
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
        </>
      )}
    </div>
  )
}

function ExerciseWriteSentence({ word, onComplete }: { word: PracticeWord; onComplete: (result: StepCompletePayload) => void }) {
  const [text, setText] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [check, setCheck] = useState<VocabCheck | null>(null)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { ref.current?.focus() }, [])
  const target = word.word.toLowerCase()
  const stem = target.slice(0, Math.max(3, Math.min(5, target.length)))
  const wordUsed = text.toLowerCase().includes(target) || text.toLowerCase().includes(stem)
  const longEnough = text.trim().split(/\s+/).filter(Boolean).length >= 4
  const valid = wordUsed && longEnough

  async function submit() {
    if (!valid || checking) return
    setSubmitted(true)
    setChecking(true)
    setError(null)
    try {
      const result = await aiCheckVocab({
        mode: 'sentence',
        word: word.word,
        definition: word.definition,
        userInput: text,
        bookSentence: word.sentence,
      })
      setCheck(result)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'AI check unavailable.')
    } finally {
      setChecking(false)
    }
  }

  function handleContinue() {
    if (!check) {
      onComplete({ correct: wordUsed, typedResponse: text })
      return
    }
    onComplete({
      correct: check.verdict === 'correct',
      rating: verdictToRating(check.verdict),
      typedResponse: text,
    })
  }

  return (
    <div>
      <ExerciseHeader title="Write Your Own Sentence" subtitle="Use the word in a context that's yours" word={word.word} />
      <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 14, padding: '14px 16px', marginTop: 14, marginBottom: 14 }}>
        <div style={{ fontFamily: FONT.display, fontSize: 22, fontWeight: 700, color: C.cream }}>{word.word}</div>
        <div style={{ color: C.gold, fontSize: 13, fontFamily: FONT.display, fontStyle: 'italic', marginTop: 2 }}>{word.definition}</div>
      </div>
      {!submitted ? (
        <>
          <textarea ref={ref} value={text} onChange={(e) => setText(e.target.value)} placeholder={`Write a sentence using "${word.word}"`} rows={3} style={{ width: '100%', boxSizing: 'border-box', background: C.cardHi, border: `1px solid ${C.borderHi}`, borderRadius: 12, padding: '12px 14px', color: C.text, fontSize: 14, fontFamily: FONT.display, outline: 'none', resize: 'none', marginBottom: 8, lineHeight: 1.5 }} />
          <div style={{ display: 'flex', gap: 10, marginBottom: 12, fontSize: 11, fontFamily: FONT.ui }}>
            <span style={{ color: wordUsed ? C.green : C.muted, display: 'inline-flex', alignItems: 'center', gap: 4 }}>{wordUsed ? <Check size={12} /> : <Circle size={12} />} uses the word</span>
            <span style={{ color: longEnough ? C.green : C.muted, display: 'inline-flex', alignItems: 'center', gap: 4 }}>{longEnough ? <Check size={12} /> : <Circle size={12} />} 4+ words</span>
          </div>
          <Btn onClick={() => void submit()} disabled={!valid} style={{ width: '100%' }}>Check with AI</Btn>
        </>
      ) : (
        <>
          <div style={{ padding: '12px 14px', background: 'rgba(0,0,0,0.04)', border: `1px solid rgba(0,0,0,0.07)`, borderRadius: 12, marginBottom: 12 }}>
            <div style={{ color: C.muted, fontSize: 10.5, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 4 }}>Your sentence</div>
            <div style={{ color: C.text, fontSize: 14.5, fontFamily: FONT.display, fontStyle: 'italic', lineHeight: 1.5 }}>"{text}"</div>
          </div>
          {checking && <AICheckingBadge />}
          {!checking && check && <AIVerdictCard check={check} />}
          {!checking && error && (
            <div style={{ padding: '10px 14px', background: `${C.amber}14`, border: `1px solid ${C.amber}40`, borderRadius: 12, marginBottom: 12, color: C.amber, fontSize: 12.5 }}>
              {error} You can still continue and self-rate.
            </div>
          )}
          {!checking && !check && error ? (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <Btn variant="warn" onClick={() => onComplete({ correct: false, typedResponse: text })}>Not quite</Btn>
              <Btn variant="success" onClick={() => onComplete({ correct: true, typedResponse: text })}>Yes, good</Btn>
            </div>
          ) : (
            <Btn onClick={handleContinue} disabled={checking} style={{ width: '100%' }}>Continue →</Btn>
          )}
        </>
      )}
    </div>
  )
}

function ExerciseWriteDefinition({ word, onComplete }: { word: PracticeWord; onComplete: (result: StepCompletePayload) => void }) {
  const [text, setText] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [check, setCheck] = useState<VocabCheck | null>(null)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { ref.current?.focus() }, [])

  async function submit() {
    if (!text.trim() || checking) return
    setSubmitted(true)
    setChecking(true)
    setError(null)
    try {
      const result = await aiCheckVocab({
        mode: 'definition',
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

  function handleContinue() {
    if (!check) {
      onComplete({ correct: true, typedResponse: text })
      return
    }
    onComplete({
      correct: check.verdict !== 'incorrect',
      rating: verdictToRating(check.verdict),
      typedResponse: text,
    })
  }

  return (
    <div>
      <ExerciseHeader title="Free Recall" subtitle="Write the definition from memory" word={word.word} />
      <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 16, padding: 20, marginTop: 14, marginBottom: 14, textAlign: 'center' }}>
        <div style={{ fontFamily: FONT.display, fontSize: 22, fontWeight: 700, color: C.cream }}>{word.word}</div>
        {word.phonetic && <div style={{ color: C.muted, fontSize: 13, fontFamily: FONT.mono, marginTop: 4 }}>{word.phonetic}</div>}
      </div>
      {!submitted ? (
        <>
          <textarea ref={ref} value={text} onChange={(e) => setText(e.target.value)} placeholder="What does this word mean?" rows={2} style={{ width: '100%', boxSizing: 'border-box', background: C.cardHi, border: `1px solid ${C.borderHi}`, borderRadius: 12, padding: '12px 14px', color: C.text, fontSize: 14, fontFamily: FONT.ui, outline: 'none', resize: 'none', marginBottom: 10, lineHeight: 1.5 }} />
          <Btn onClick={() => void submit()} disabled={!text.trim()} style={{ width: '100%' }}>Check with AI</Btn>
        </>
      ) : (
        <>
          <div style={{ marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
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
          {!checking && check && <AIVerdictCard check={check} />}
          {!checking && error && (
            <div style={{ padding: '10px 14px', background: `${C.amber}14`, border: `1px solid ${C.amber}40`, borderRadius: 12, marginBottom: 12, color: C.amber, fontSize: 12.5 }}>
              {error} You can still continue and self-rate.
            </div>
          )}
          {!checking && !check && error ? (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
              <Btn variant="danger" onClick={() => onComplete({ rating: 'again', correct: false, typedResponse: text })}>Off</Btn>
              <Btn variant="warn" onClick={() => onComplete({ rating: 'hard', correct: true, typedResponse: text })}>Partial</Btn>
              <Btn variant="success" onClick={() => onComplete({ rating: 'good', correct: true, typedResponse: text })}>Spot on</Btn>
            </div>
          ) : (
            <Btn onClick={handleContinue} disabled={checking} style={{ width: '100%' }}>Continue →</Btn>
          )}
        </>
      )}
    </div>
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

  return (
    <div>
      <ExerciseHeader title="Memory Hook" subtitle="Build a mnemonic you'll see next time" word={word.word} />
      <div style={{ background: `linear-gradient(135deg, ${C.violet}12, rgba(0,0,0,0.03))`, border: `1px solid ${C.violet}25`, borderRadius: 14, padding: 14, marginTop: 12, marginBottom: 12 }}>
        <div style={{ fontFamily: FONT.display, fontSize: 22, fontWeight: 700, color: C.cream }}>{word.word}</div>
        {word.phonetic && <div style={{ color: C.muted, fontSize: 12, fontFamily: FONT.mono, marginTop: 2, marginBottom: 6 }}>{word.phonetic}</div>}
        <div style={{ color: C.gold, fontSize: 13.5, fontFamily: FONT.display, fontStyle: 'italic' }}>{word.definition}</div>
      </div>
      {!saved ? (
        <>
          <textarea ref={ref} value={text} onChange={(e) => setText(e.target.value)} placeholder="An image, sound, or mini-story that makes it stick…" rows={2} style={{ width: '100%', boxSizing: 'border-box', background: C.cardHi, border: `1px solid ${C.violet}44`, borderRadius: 12, padding: '12px 14px', color: C.text, fontSize: 14, fontFamily: FONT.display, outline: 'none', resize: 'none', marginBottom: 10, lineHeight: 1.5 }} />
          <Btn onClick={() => void save()} disabled={text.trim().length < 10} style={{ width: '100%', background: C.violet, color: '#ffffff' }}>Save & check with AI</Btn>
        </>
      ) : (
        <>
          <div style={{ padding: '12px 14px', background: `${C.violet}18`, border: `1px solid ${C.violet}55`, borderRadius: 12, marginBottom: 12 }}>
            <div style={{ color: C.violet, fontSize: 10.5, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 6 }}>Your memory hook</div>
            <div style={{ color: C.text, fontSize: 14, fontFamily: FONT.display, fontStyle: 'italic', lineHeight: 1.5 }}>"{text}"</div>
          </div>
          {checking && <AICheckingBadge />}
          {!checking && check && <AIVerdictCard check={check} />}
          {!checking && error && (
            <div style={{ padding: '10px 14px', background: `${C.amber}14`, border: `1px solid ${C.amber}40`, borderRadius: 12, marginBottom: 12, color: C.amber, fontSize: 12.5 }}>
              {error} Saving your hook anyway.
            </div>
          )}
          {!checking && check?.suggestion && (
            <Btn variant="ghost" onClick={applySuggestion} style={{ width: '100%', marginBottom: 8, fontSize: 13, padding: '11px 14px' }}>
              Use AI's suggestion
            </Btn>
          )}
          <Btn onClick={() => onComplete({ correct: true, mnemonic: text })} disabled={checking} style={{ width: '100%' }}>Continue →</Btn>
        </>
      )}
    </div>
  )
}

function Dashboard({
  deck,
  words,
  analytics,
  onStart,
  startDisabled,
  starting,
  enrichProgress,
  error,
}: {
  deck: DeckSummary
  words: SavedWord[]
  analytics?: DeckDashboard['analytics']
  onStart: () => void
  startDisabled: boolean
  starting: boolean
  enrichProgress: { done: number; total: number } | null
  error: string | null
}) {
  const stageColor: Record<CardState, string> = { new: C.blue, learning: C.amber, review: C.green, relearning: C.violet }
  const dailyGoal = Math.max(20, deck.dueToday || deck.reviewsCompletedToday || 20)
  const progress = Math.min(1, deck.reviewsCompletedToday / dailyGoal)
  const stats = [
    { label: 'Due Today', value: deck.dueToday || deck.dueNow, color: C.gold },
    { label: 'Learned', value: `${analytics?.cardsLearned ?? deck.newIntroducedToday}`, color: C.orange },
    { label: 'Total', value: deck.cardCount, color: C.blue },
    { label: 'Mastered', value: deck.cardsByState.review ?? 0, color: C.green },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Hero heading */}
      <div style={{ marginBottom: 2 }}>
        <div style={{ fontSize: 26, fontWeight: 900, color: C.cream, lineHeight: 1.15, letterSpacing: '-0.02em' }}>
          {startDisabled ? 'All caught up!' : 'Ready to practice?'}
        </div>
        <div style={{ color: C.mutedHi, fontSize: 13, marginTop: 4 }}>
          {deck.dueNow + deck.newAvailable} cards ready · mixed exercises
        </div>
      </div>

      {/* Stats grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
        {stats.map((s) => (
          <div key={s.label} className="studio-card" style={{ padding: '10px 12px' }}>
            <div style={{ color: s.color, fontSize: 20, fontWeight: 900, letterSpacing: '-0.02em' }}>{s.value}</div>
            <div style={{ color: C.muted, fontSize: 10.5, marginTop: 1 }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Start session card */}
      <div className="studio-card" style={{ padding: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
          <span style={{ color: C.text, fontSize: 13.5, fontWeight: 600 }}>Daily Goal</span>
          <span style={{ color: C.gold, fontSize: 12.5, fontWeight: 700 }}>{deck.reviewsCompletedToday} / {dailyGoal} cards</span>
        </div>
        <ProgressBar progress={progress} color={C.gold} height={5} />
        <Btn onClick={onStart} disabled={startDisabled || starting} style={{ width: '100%', marginTop: 12, borderRadius: 12, fontSize: 14.5, padding: '13px 20px' }}>
          {enrichProgress
            ? `Preparing words…  ${enrichProgress.done}/${enrichProgress.total}`
            : starting
              ? 'Starting…'
              : startDisabled
                ? 'All caught up ✓'
                : 'Start Session →'}
        </Btn>
        {error && <div style={{ color: C.red, fontSize: 12, marginTop: 8 }}>{error}</div>}
      </div>

      {/* Saved words */}
      <div>
        <div style={{ color: C.mutedHi, fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 8 }}>
          Saved Words
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {words.slice(0, 18).map((w) => (
            <div key={w.id} className="studio-card" style={{ padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ color: C.cream, fontWeight: 700, fontSize: 15, fontFamily: FONT.display, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.word}</div>
                <div style={{ color: C.muted, fontSize: 11.5, marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.book}</div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: '0 0 auto' }}>
                <AudioBtn text={w.word} size={26} />
                <Pill color={stageColor[w.stage]}>{w.stage}</Pill>
              </div>
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
}: {
  step: PracticeStep
  stepIndex: number
  totalSteps: number
  distractors: string[]
  onComplete: (result: StepCompletePayload) => void
  busy: boolean
}) {
  const [xpAnim, setXpAnim] = useState<string | null>(null)

  function handleComplete(payload: StepCompletePayload) {
    if (payload.correct) {
      const xp = payload.rating === 'easy' ? '+20 xp' : payload.rating === 'hard' ? '+10 xp' : '+15 xp'
      setXpAnim(xp)
      setTimeout(() => setXpAnim(null), 1400)
    }
    onComplete(payload)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', opacity: busy ? 0.72 : 1, pointerEvents: busy ? 'none' : 'auto' }}>

      {/* Progress dots + counter */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 22 }}>
        <div style={{ display: 'flex', gap: 7, alignItems: 'center' }}>
          {Array.from({ length: totalSteps }).map((_, i) => (
            <div key={i} style={{
              height: 6, borderRadius: 99,
              width: i === stepIndex ? 22 : 6,
              background: i < stepIndex ? `${C.blue}88` : i === stepIndex ? C.blue : 'rgba(0,0,0,0.12)',
              transition: 'all 0.35s cubic-bezier(0.22,1,0.36,1)',
            }} />
          ))}
        </div>
        <span style={{ flex: 1 }} />
        {xpAnim && (
          <span style={{ fontSize: 13, fontWeight: 800, color: C.green, letterSpacing: '-0.01em', animation: 'xpPop 1.4s ease forwards' }}>
            {xpAnim}
          </span>
        )}
        <span style={{ color: C.muted, fontSize: 12, fontFamily: FONT.mono }}>{stepIndex + 1}/{totalSteps}</span>
      </div>

      {/* Word hero */}
      {step.exercise === 'cloze' ? (
        <div style={{ textAlign: 'center', paddingBottom: 22 }}>
          <div style={{
            width: 64, height: 64, borderRadius: '50%',
            background: 'rgba(0,0,0,0.07)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            margin: '0 auto 14px',
          }}>
            <svg width={28} height={28} viewBox="0 0 24 24" fill="none" stroke="rgba(0,0,0,0.28)" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="8" r="4" /><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
            </svg>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
            <span style={{ fontSize: 14, color: C.mutedHi, fontStyle: 'italic' }}>Listen and identify the word</span>
            <AudioBtn text={step.word.word} size={32} />
          </div>
        </div>
      ) : (
        <div style={{ textAlign: 'center', paddingBottom: 22 }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
            <h2 style={{ fontSize: 38, fontWeight: 700, fontFamily: FONT.display, color: C.text, letterSpacing: '-0.02em', lineHeight: 1, margin: 0 }}>
              {step.word.word}
            </h2>
            <AudioBtn text={step.word.word} size={38} />
          </div>
          {step.word.phonetic && (
            <div style={{ fontSize: 13, color: C.muted, fontFamily: FONT.mono, marginBottom: 2 }}>{step.word.phonetic}</div>
          )}
          <div style={{ fontSize: 12, color: C.muted, fontStyle: 'italic' }}>from <em>{step.word.book}</em></div>
        </div>
      )}

      {/* Exercise card */}
      <div key={step.id} className="studio-card" style={{ padding: '22px 22px 20px', animation: 'studioSlideIn 0.28s cubic-bezier(0.22,1,0.36,1)' }}>
        {step.exercise === 'mcq' && <ExerciseMCQ word={step.word} distractors={distractors} onComplete={handleComplete} />}
        {step.exercise === 'cloze' && <ExerciseCloze word={step.word} onComplete={handleComplete} />}
        {step.exercise === 'recall' && <ExerciseRecall word={step.word} onComplete={handleComplete} />}
        {step.exercise === 'write-sentence' && <ExerciseWriteSentence word={step.word} onComplete={handleComplete} />}
        {step.exercise === 'write-definition' && <ExerciseWriteDefinition word={step.word} onComplete={handleComplete} />}
        {step.exercise === 'mnemonic' && <ExerciseMnemonic word={step.word} onComplete={handleComplete} />}
      </div>

      {busy && <div style={{ color: C.muted, fontSize: 12, textAlign: 'center', marginTop: 10 }}>Saving progress…</div>}
    </div>
  )
}

function ResultsScreen({
  results,
  onDone,
  onPracticeAgain,
}: {
  results: PracticeResult[]
  onDone: () => void
  onPracticeAgain: () => void
}) {
  // Deduplicate: last result per word
  const wordResultMap = new Map<string, PracticeResult>()
  results.forEach((r) => wordResultMap.set(r.word, r))
  const uniqueResults = Array.from(wordResultMap.values())

  const correctCount = uniqueResults.filter((r) => r.correct).length
  const toRepeat = uniqueResults.filter((r) => !r.correct).length
  const accuracy = Math.round((correctCount / Math.max(1, uniqueResults.length)) * 100)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* Header */}
      <div style={{ textAlign: 'center', paddingTop: 12 }}>
        <div style={{ fontSize: 44, lineHeight: 1, marginBottom: 14 }}>🎉</div>
        <div style={{ fontSize: 24, fontWeight: 800, color: C.cream, letterSpacing: '-0.02em', marginBottom: 6 }}>
          Session complete
        </div>
        <div style={{ color: C.mutedHi, fontSize: 14 }}>
          You reviewed {uniqueResults.length} word{uniqueResults.length !== 1 ? 's' : ''}
        </div>
      </div>

      {/* Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
        {[
          { label: 'Accuracy', value: `${accuracy}%`, color: C.blue },
          { label: 'Correct', value: correctCount, color: C.green },
          { label: 'To repeat', value: toRepeat, color: toRepeat > 0 ? C.amber : C.muted },
        ].map((s) => (
          <div key={s.label} className="studio-card" style={{ padding: '14px 12px', textAlign: 'center' }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: s.color, letterSpacing: '-0.02em' }}>{s.value}</div>
            <div style={{ fontSize: 11, color: C.muted, marginTop: 3 }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Word list */}
      <div className="studio-card" style={{ padding: '4px 0' }}>
        {uniqueResults.map((r, i) => (
          <div
            key={r.word}
            style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '12px 18px',
              borderBottom: i < uniqueResults.length - 1 ? '1px solid rgba(0,0,0,0.05)' : 'none',
            }}
          >
            <span style={{ fontSize: 15, fontWeight: 600, color: C.cream, fontFamily: FONT.display }}>{r.word}</span>
            <span style={{
              fontSize: 11.5, fontWeight: 700,
              color: r.correct ? C.green : C.red,
              background: r.correct ? `${C.green}15` : `${C.red}15`,
              padding: '4px 10px', borderRadius: 99,
              border: `1px solid ${r.correct ? `${C.green}33` : `${C.red}33`}`,
            }}>
              {r.correct ? 'Correct' : 'Again'}
            </span>
          </div>
        ))}
      </div>

      {/* Buttons */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Btn
          onClick={onPracticeAgain}
          style={{ width: '100%', background: C.blue, borderRadius: 14, fontSize: 14.5, padding: '14px 20px' }}
        >
          Practice again
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
  const [screen, setScreen] = useState<Screen>('dashboard')
  const [deckSummary, setDeckSummary] = useState<DeckSummary | null>(null)
  const [sessionPlan, setSessionPlan] = useState<PracticeStep[]>([])
  const [practiceWords, setPracticeWords] = useState<PracticeWord[]>([])
  const [stepIndex, setStepIndex] = useState(0)
  const [results, setResults] = useState<PracticeResult[]>([])
  const [ratedCardIds, setRatedCardIds] = useState<Set<string>>(() => new Set())
  const [starting, setStarting] = useState(false)
  const [enrichProgress, setEnrichProgress] = useState<{ done: number; total: number } | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const stepStartedAt = useRef(Date.now())
  const didAutoStart = useRef(false)

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
  const allDefinitions = useMemo(() => {
    const fromSaved = savedWords.map((word) => word.definition)
    const fromSession = practiceWords.map((word) => word.definition)
    return Array.from(
      new Set(
        [...fromSaved, ...fromSession].filter((d) => d && !isPlaceholderDefinition(d)),
      ),
    )
  }, [practiceWords, savedWords])
  const currentStep = sessionPlan[stepIndex]
  const isLoading = decksLoading || (Boolean(deck?.id) && dashboardLoading)

  const startSession = useCallback(async () => {
    if (!deck || starting) return
    setStarting(true)
    setStartError(null)
    setEnrichProgress(null)
    try {
      const res = await api.post<PracticeSessionResponse>(`/api/vocabulary/decks/${deck.id}/practice-sessions`, {
        focus: 'mixed',
        limit: 8,
      })
      const allWords = res.items.map(cardToPracticeWord)
      let words = allWords.filter((w) => isVocabWord(w.word))

      if (words.length === 0) {
        setStartError(
          allWords.length > 0
            ? 'Your due cards are multi-word highlights — save some single vocabulary words from the reader to practice.'
            : 'No practice items are ready yet.',
        )
        return
      }

      // Enrich words whose definition is missing or a placeholder string.
      // Without this, MCQ shows "Saved from your reading" as the correct answer.
      const needsDef = words.filter((w) => isPlaceholderDefinition(w.definition))
      if (needsDef.length > 0) {
        setEnrichProgress({ done: 0, total: needsDef.length })
        const enrichedById = new Map<string, AIDefinition>()
        let done = 0
        await Promise.all(
          needsDef.map(async (w) => {
            try {
              const sentence = isPlaceholderDefinition(w.sentence) ? null : w.sentence
              const def = await aiDefineWord(w.word, sentence)
              if (def.definition && !isPlaceholderDefinition(def.definition)) {
                enrichedById.set(w.id, def)
              }
            } catch (err) {
              console.warn('AI define failed for', w.word, err)
            } finally {
              done += 1
              setEnrichProgress({ done, total: needsDef.length })
            }
          }),
        )
        if (enrichedById.size > 0) {
          words = words.map((w) => {
            const ai = enrichedById.get(w.id)
            if (!ai) return w
            const newDef = ai.definition
            const newSentence = (
              !w.sentence || isPlaceholderDefinition(w.sentence) || w.sentence === w.definition
            )
              ? (ai.example ?? `${w.word} — ${newDef}`)
              : w.sentence
            return {
              ...w,
              definition: newDef,
              sentence: newSentence,
              card: { ...w.card, productionTarget: w.word },
            }
          })
        }
        setEnrichProgress(null)
      }

      // Safety net: drop any word that still has a placeholder definition.
      // Better to skip it than show "Saved from reading" as the correct MCQ answer.
      const beforeFilter = words.length
      words = words.filter((w) => !isPlaceholderDefinition(w.definition))
      if (words.length < beforeFilter) {
        console.warn(`Skipped ${beforeFilter - words.length} card(s) without real definitions.`)
      }
      if (words.length === 0) {
        setStartError(
          "Couldn't generate definitions for your saved words. Check your connection and try again.",
        )
        return
      }

      const plan = buildSessionPlan(words)
      if (plan.length === 0) {
        setStartError('No practice items are ready yet.')
        return
      }

      setDeckSummary(res.deck)
      setPracticeWords(words)
      setSessionPlan(plan)
      setStepIndex(0)
      setResults([])
      setRatedCardIds(new Set())
      stepStartedAt.current = Date.now()
      setScreen('practice')
    } catch (error) {
      console.error('Failed to start studio session', error)
      setStartError('Could not start a practice session.')
    } finally {
      setStarting(false)
      setEnrichProgress(null)
    }
  }, [deck, starting])

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
      if (rating && !ratedCardIds.has(step.word.card.id)) {
        const responseMs = Math.max(0, Date.now() - stepStartedAt.current)
        const review = await api.post<ReviewResponse>(`/api/vocabulary/cards/${step.word.card.id}/reviews`, {
          rating,
          responseMs,
          answerMode: answerModeForExercise(step.exercise),
          typedResponse: payload.typedResponse ?? null,
        })
        setDeckSummary(review.summary)
        setRatedCardIds((prev) => new Set(prev).add(step.word.card.id))
      }

      setResults((prev) => [
        ...prev,
        {
          stepId: step.id,
          wordId: step.word.id,
          word: step.word.word,
          exercise: step.exercise,
          correct: payload.correct,
          rating: payload.rating,
        },
      ])

      const nextIndex = stepIndex + 1
      if (nextIndex >= sessionPlan.length) {
        setScreen('results')
        queryClient.invalidateQueries({ queryKey: ['decks'] })
        queryClient.invalidateQueries({ queryKey: ['deck-dashboard'] })
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
  }, [persistMnemonic, queryClient, ratedCardIds, sessionPlan, stepIndex, submitting])

  function backToDashboard() {
    queryClient.invalidateQueries({ queryKey: ['decks'] })
    queryClient.invalidateQueries({ queryKey: ['deck-dashboard'] })
    setScreen('dashboard')
    setDeckSummary(null)
    setSessionPlan([])
    setPracticeWords([])
    setStepIndex(0)
    setRatedCardIds(new Set())
  }

  function practiceAgain() {
    setResults([])
    setRatedCardIds(new Set())
    setDeckSummary(null)
    void startSession()
  }

  const startDisabled = !activeDeck || (activeDeck.dueNow + activeDeck.newAvailable + activeDeck.cardsByState.learning + activeDeck.cardsByState.relearning) === 0

  // Fire as soon as deck data is available from cache — don't wait for dashboard query.
  // startSession() only needs `deck` (from the decks query).
  useEffect(() => {
    if (!didAutoStart.current && !decksLoading && deck && !startDisabled && screen === 'dashboard') {
      didAutoStart.current = true
      void startSession()
    }
  }, [decksLoading, deck, startDisabled, screen, startSession])

  return (
    <div
      style={{
        background: GRAD,
        minHeight: '100svh',
        color: C.text,
        fontFamily: FONT.ui,
        display: 'flex',
        justifyContent: 'center',
        padding: '0 0 40px',
      }}
    >
      <style>{`
        @keyframes studioFadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes studioSlideIn { from { opacity: 0; transform: translateX(18px) scale(0.97); } to { opacity: 1; transform: translateX(0) scale(1); } }
        @keyframes xpPop { 0% { opacity:0; transform:translateY(4px) scale(0.9); } 15% { opacity:1; transform:translateY(0) scale(1.1); } 80% { opacity:1; transform:translateY(-2px) scale(1); } 100% { opacity:0; transform:translateY(-12px); } }
        .studio-scope input::placeholder, .studio-scope textarea::placeholder { color: ${C.muted}; opacity: 1; }
        .studio-scope input:focus, .studio-scope textarea:focus { border-color: ${C.gold} !important; outline: none; box-shadow: 0 0 0 3px ${C.gold}28; }
        .studio-card { background: #fff; border-radius: 20px; box-shadow: ${CARD_SHADOW}; }
      `}</style>
      <div className="studio-scope" style={{ width: '100%', maxWidth: 560, padding: '20px 16px 80px' }}>

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
            onStart={startSession}
            startDisabled={startDisabled}
            starting={starting}
            enrichProgress={enrichProgress}
            error={startError}
          />
        ) : screen === 'practice' && currentStep ? (
          <PracticeScreen
            step={currentStep}
            stepIndex={stepIndex}
            totalSteps={sessionPlan.length}
            distractors={allDefinitions.filter((definition) => definition !== currentStep.word.definition)}
            onComplete={completeStep}
            busy={submitting}
          />
        ) : (
          <ResultsScreen results={results} onDone={backToDashboard} onPracticeAgain={practiceAgain} />
        )}
      </div>
    </div>
  )
}
