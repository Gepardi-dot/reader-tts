import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { BookOpen, Check, Circle, Sparkles, Volume2, X } from 'lucide-react'
import { api } from '@/shared/api/client'

const C = {
  bg: '#0F0D08',
  surface: '#17140E',
  card: '#1E1A12',
  cardHi: '#26211A',
  border: '#2D2820',
  borderHi: '#453E32',
  gold: '#E8A633',
  goldDim: '#A87820',
  cream: '#F5EFDC',
  text: '#EDE6D0',
  muted: '#8A7C5E',
  mutedHi: '#B5A684',
  green: '#7BC47F',
  amber: '#E8A633',
  red: '#E46A6A',
  violet: '#A78BFA',
  blue: '#6FA8DC',
  orange: '#FF6B35',
}

const FONT = {
  display: 'Lora, "Iowan Old Style", Palatino, Georgia, serif',
  ui: '"Inter Variable", Inter, -apple-system, "Helvetica Neue", sans-serif',
  mono: '"SF Mono", "JetBrains Mono", Consolas, monospace',
}

type Rating = 'again' | 'hard' | 'good' | 'easy'
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
    <div style={{ background: C.border, borderRadius: 99, height, overflow: 'hidden' }}>
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
    primary: { background: C.gold, color: C.bg },
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
  return (
    <button
      onClick={() => speak(text)}
      aria-label={`Pronounce ${text}`}
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: C.cardHi,
        border: `1px solid ${C.border}`,
        color: C.gold,
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        transition: 'all 0.15s',
        flex: '0 0 auto',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = C.gold
        e.currentTarget.style.color = C.bg
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = C.cardHi
        e.currentTarget.style.color = C.gold
      }}
    >
      <Volume2 size={Math.max(14, size * 0.46)} strokeWidth={2} />
    </button>
  )
}

function MethodFooter({ method, why }: { method: string; why: string }) {
  return (
    <div
      style={{
        marginTop: 14,
        padding: '10px 14px',
        background: C.surface,
        borderRadius: 10,
        border: `1px dashed ${C.border}`,
      }}
    >
      <div style={{ color: C.goldDim, fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', display: 'flex', gap: 6, alignItems: 'center' }}>
        <Sparkles size={12} /> Learning science · {method}
      </div>
      <div style={{ color: C.muted, fontSize: 11.5, marginTop: 3, lineHeight: 1.45, fontFamily: FONT.ui }}>
        {why}
      </div>
    </div>
  )
}

function ExerciseHeader({ title, subtitle, word }: { title: string; subtitle?: string; word?: string }) {
  return (
    <div style={{ marginBottom: 4 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 6 }}>
        <Pill color={C.gold}>{title}</Pill>
        {word && <AudioBtn text={word} size={28} />}
      </div>
      {subtitle && <div style={{ color: C.muted, fontSize: 12.5, fontFamily: FONT.ui }}>{subtitle}</div>}
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
      <div style={{ fontFamily: FONT.display, fontSize: 34, fontWeight: 600, color: C.cream, marginTop: 14, marginBottom: 4 }}>
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

      <MethodFooter
        method="Retrieval practice · Interleaving"
        why="Distractors from your other saved words force discrimination, which strengthens memory more than recognition in isolation."
      />
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
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderLeft: `3px solid ${C.gold}`, borderRadius: '0 12px 12px 0', padding: '14px 16px', marginTop: 14, marginBottom: 16 }}>
        <div style={{ color: C.muted, fontSize: 10.5, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 6, fontFamily: FONT.ui }}>
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

      <MethodFooter
        method="Contextual retrieval"
        why="Producing the word inside its original sentence anchors it to a memory you already have of the story."
      />
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
      <ExerciseHeader title="Active Recall" subtitle="Recall before revealing" word={word.word} />
      <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 16, padding: 20, marginTop: 14, marginBottom: 14 }}>
        <div style={{ fontFamily: FONT.display, fontSize: 38, fontWeight: 600, color: C.cream, lineHeight: 1.1 }}>{word.word}</div>
        {word.phonetic && <div style={{ color: C.muted, fontSize: 13, fontFamily: FONT.mono, marginTop: 4 }}>{word.phonetic}</div>}
        {!revealed && <div style={{ color: C.mutedHi, fontSize: 13, marginTop: 16, fontFamily: FONT.ui, fontStyle: 'italic' }}>Recall the definition silently, then reveal.</div>}
        {revealed && (
          <div style={{ marginTop: 14, animation: 'studioFadeIn 0.3s ease' }}>
            <div style={{ color: C.gold, fontSize: 16, fontFamily: FONT.display, fontStyle: 'italic', marginBottom: 12 }}>{word.definition}</div>
            <div style={{ background: C.surface, borderLeft: `3px solid ${C.gold}`, borderRadius: '0 10px 10px 0', padding: '10px 14px' }}>
              <div style={{ color: C.muted, fontSize: 10.5, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 4, fontFamily: FONT.ui }}>{word.book}</div>
              <div style={{ color: C.text, fontSize: 14, lineHeight: 1.6, fontFamily: FONT.display, fontStyle: 'italic' }}>"{word.sentence}"</div>
            </div>
            {word.mnemonic && (
              <div style={{ marginTop: 10, padding: '10px 12px', background: `${C.violet}12`, borderRadius: 10, border: `1px solid ${C.violet}33` }}>
                <div style={{ color: C.violet, fontSize: 10.5, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 3, fontFamily: FONT.ui }}>Memory hook</div>
                <div style={{ color: C.text, fontSize: 13, fontFamily: FONT.ui, lineHeight: 1.5 }}>{word.mnemonic}</div>
              </div>
            )}
          </div>
        )}
      </div>

      {!revealed ? (
        <Btn onClick={() => setRevealed(true)} style={{ width: '100%' }}>Reveal Answer</Btn>
      ) : (
        <>
          <div style={{ color: C.mutedHi, fontSize: 12, textAlign: 'center', marginBottom: 10, fontFamily: FONT.ui, letterSpacing: '0.04em' }}>HOW WELL DID YOU RECALL IT?</div>
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

      <MethodFooter
        method="Active recall + Spaced repetition"
        why="The effort of retrieving from memory builds retention. Your rating schedules the next review."
      />
    </div>
  )
}

function ExerciseWriteSentence({ word, onComplete }: { word: PracticeWord; onComplete: (result: StepCompletePayload) => void }) {
  const [text, setText] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { ref.current?.focus() }, [])
  const target = word.word.toLowerCase()
  const stem = target.slice(0, Math.max(3, Math.min(5, target.length)))
  const wordUsed = text.toLowerCase().includes(target) || text.toLowerCase().includes(stem)
  const longEnough = text.trim().split(/\s+/).filter(Boolean).length >= 4
  const valid = wordUsed && longEnough

  return (
    <div>
      <ExerciseHeader title="Write Your Own Sentence" subtitle="Use the word in a context that's yours" word={word.word} />
      <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 14, padding: '14px 16px', marginTop: 14, marginBottom: 14 }}>
        <div style={{ fontFamily: FONT.display, fontSize: 26, fontWeight: 600, color: C.cream }}>{word.word}</div>
        <div style={{ color: C.gold, fontSize: 14, fontFamily: FONT.display, fontStyle: 'italic', marginTop: 3 }}>{word.definition}</div>
      </div>
      {!submitted ? (
        <>
          <textarea ref={ref} value={text} onChange={(e) => setText(e.target.value)} placeholder={`Write a sentence using "${word.word}"`} rows={4} style={{ width: '100%', boxSizing: 'border-box', background: C.cardHi, border: `1px solid ${C.borderHi}`, borderRadius: 12, padding: '14px 16px', color: C.text, fontSize: 15, fontFamily: FONT.display, outline: 'none', resize: 'none', marginBottom: 8, lineHeight: 1.5 }} />
          <div style={{ display: 'flex', gap: 10, marginBottom: 12, fontSize: 11, fontFamily: FONT.ui }}>
            <span style={{ color: wordUsed ? C.green : C.muted, display: 'inline-flex', alignItems: 'center', gap: 4 }}>{wordUsed ? <Check size={12} /> : <Circle size={12} />} uses the word</span>
            <span style={{ color: longEnough ? C.green : C.muted, display: 'inline-flex', alignItems: 'center', gap: 4 }}>{longEnough ? <Check size={12} /> : <Circle size={12} />} 4+ words</span>
          </div>
          <Btn onClick={() => setSubmitted(true)} disabled={!valid} style={{ width: '100%' }}>Submit</Btn>
        </>
      ) : (
        <>
          <div style={{ padding: '14px 16px', background: `${C.violet}12`, border: `1px solid ${C.violet}33`, borderRadius: 12, marginBottom: 12 }}>
            <div style={{ color: C.violet, fontSize: 10.5, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 6, fontFamily: FONT.ui }}>Your sentence</div>
            <div style={{ color: C.text, fontSize: 15, fontFamily: FONT.display, fontStyle: 'italic', lineHeight: 1.5 }}>"{text}"</div>
          </div>
          <div style={{ color: C.mutedHi, fontSize: 12, textAlign: 'center', marginBottom: 10, fontFamily: FONT.ui, letterSpacing: '0.04em' }}>DOES IT FEEL RIGHT?</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <Btn variant="warn" onClick={() => onComplete({ correct: false, typedResponse: text })}>Not quite</Btn>
            <Btn variant="success" onClick={() => onComplete({ correct: true, typedResponse: text })}>Yes, good</Btn>
          </div>
        </>
      )}
      <MethodFooter method="Elaborative encoding" why="Generating your own sentence connects the word to personal knowledge and makes retrieval cues richer." />
    </div>
  )
}

function ExerciseWriteDefinition({ word, onComplete }: { word: PracticeWord; onComplete: (result: StepCompletePayload) => void }) {
  const [text, setText] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { ref.current?.focus() }, [])

  return (
    <div>
      <ExerciseHeader title="Free Recall" subtitle="Write the definition from memory" word={word.word} />
      <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 16, padding: 20, marginTop: 14, marginBottom: 14, textAlign: 'center' }}>
        <div style={{ fontFamily: FONT.display, fontSize: 34, fontWeight: 600, color: C.cream }}>{word.word}</div>
        {word.phonetic && <div style={{ color: C.muted, fontSize: 13, fontFamily: FONT.mono, marginTop: 4 }}>{word.phonetic}</div>}
      </div>
      {!submitted ? (
        <>
          <textarea ref={ref} value={text} onChange={(e) => setText(e.target.value)} placeholder="What does this word mean?" rows={3} style={{ width: '100%', boxSizing: 'border-box', background: C.cardHi, border: `1px solid ${C.borderHi}`, borderRadius: 12, padding: '14px 16px', color: C.text, fontSize: 15, fontFamily: FONT.ui, outline: 'none', resize: 'none', marginBottom: 12, lineHeight: 1.5 }} />
          <Btn onClick={() => setSubmitted(true)} disabled={!text.trim()} style={{ width: '100%' }}>Check</Btn>
        </>
      ) : (
        <>
          <div style={{ marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ padding: '12px 14px', background: C.cardHi, borderRadius: 10, border: `1px solid ${C.border}` }}>
              <div style={{ color: C.muted, fontSize: 10.5, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 4, fontFamily: FONT.ui }}>You wrote</div>
              <div style={{ color: C.text, fontSize: 14, fontFamily: FONT.ui, lineHeight: 1.5 }}>{text}</div>
            </div>
            <div style={{ padding: '12px 14px', background: `${C.gold}12`, borderRadius: 10, border: `1px solid ${C.gold}33` }}>
              <div style={{ color: C.gold, fontSize: 10.5, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 4, fontFamily: FONT.ui }}>Actual definition</div>
              <div style={{ color: C.text, fontSize: 14, fontFamily: FONT.display, fontStyle: 'italic', lineHeight: 1.5 }}>{word.definition}</div>
            </div>
          </div>
          <div style={{ color: C.mutedHi, fontSize: 12, textAlign: 'center', marginBottom: 10, fontFamily: FONT.ui, letterSpacing: '0.04em' }}>HOW CLOSE WERE YOU?</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
            <Btn variant="danger" onClick={() => onComplete({ rating: 'again', correct: false, typedResponse: text })}>Off</Btn>
            <Btn variant="warn" onClick={() => onComplete({ rating: 'hard', correct: true, typedResponse: text })}>Partial</Btn>
            <Btn variant="success" onClick={() => onComplete({ rating: 'good', correct: true, typedResponse: text })}>Spot on</Btn>
          </div>
        </>
      )}
      <MethodFooter method="Free recall" why="Producing the definition without cues is harder than recognition, and the extra effort deepens encoding." />
    </div>
  )
}

function ExerciseMnemonic({ word, onComplete }: { word: PracticeWord; onComplete: (result: StepCompletePayload) => void }) {
  const [text, setText] = useState(word.mnemonic ?? '')
  const [saved, setSaved] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { ref.current?.focus() }, [])

  return (
    <div>
      <ExerciseHeader title="Memory Hook" subtitle="Build a mnemonic you'll see next time" word={word.word} />
      <div style={{ background: `linear-gradient(135deg, ${C.violet}14, ${C.card})`, border: `1px solid ${C.violet}33`, borderRadius: 16, padding: 20, marginTop: 14, marginBottom: 14 }}>
        <div style={{ fontFamily: FONT.display, fontSize: 32, fontWeight: 600, color: C.cream }}>{word.word}</div>
        {word.phonetic && <div style={{ color: C.muted, fontSize: 13, fontFamily: FONT.mono, marginTop: 2, marginBottom: 10 }}>{word.phonetic}</div>}
        <div style={{ color: C.gold, fontSize: 15, fontFamily: FONT.display, fontStyle: 'italic' }}>{word.definition}</div>
      </div>
      {!saved ? (
        <>
          <div style={{ marginBottom: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {['What image comes to mind?', 'What does this word sound like?', 'A mini-story that makes it stick?'].map((prompt) => (
              <div key={prompt} style={{ color: C.mutedHi, fontSize: 12.5, fontFamily: FONT.ui }}>· {prompt}</div>
            ))}
          </div>
          <textarea ref={ref} value={text} onChange={(e) => setText(e.target.value)} placeholder={`Example: "${word.word}" sounds like a vivid image or mini-story`} rows={4} style={{ width: '100%', boxSizing: 'border-box', background: C.cardHi, border: `1px solid ${C.violet}44`, borderRadius: 12, padding: '14px 16px', color: C.text, fontSize: 14.5, fontFamily: FONT.display, outline: 'none', resize: 'none', marginBottom: 12, lineHeight: 1.5 }} />
          <Btn onClick={() => setSaved(true)} disabled={text.trim().length < 10} style={{ width: '100%', background: C.violet, color: C.bg }}>Save memory hook</Btn>
        </>
      ) : (
        <>
          <div style={{ padding: '14px 16px', background: `${C.violet}18`, border: `1px solid ${C.violet}55`, borderRadius: 12, marginBottom: 12 }}>
            <div style={{ color: C.violet, fontSize: 10.5, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 6, fontFamily: FONT.ui }}>Saved for future reviews</div>
            <div style={{ color: C.text, fontSize: 14, fontFamily: FONT.display, fontStyle: 'italic', lineHeight: 1.5 }}>"{text}"</div>
          </div>
          <Btn onClick={() => onComplete({ correct: true, mnemonic: text })} style={{ width: '100%' }}>Continue</Btn>
        </>
      )}
      <MethodFooter method="Keyword method" why="Linking the word's sound to a vivid image creates a verbal and visual memory trace." />
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
  error,
}: {
  deck: DeckSummary
  words: SavedWord[]
  analytics?: DeckDashboard['analytics']
  onStart: () => void
  startDisabled: boolean
  starting: boolean
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      <div>
        <div style={{ color: C.muted, fontSize: 11, letterSpacing: '0.14em', textTransform: 'uppercase', fontFamily: FONT.ui }}>Good morning</div>
        <div style={{ color: C.cream, fontSize: 30, fontFamily: FONT.display, fontWeight: 600, marginTop: 2 }}>Your Studio</div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        {stats.map((s) => (
          <div key={s.label} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 14, padding: '12px 14px' }}>
            <div style={{ color: s.color, fontSize: 22, fontWeight: 800, fontFamily: FONT.ui }}>{s.value}</div>
            <div style={{ color: C.muted, fontSize: 11.5, marginTop: 1, fontFamily: FONT.ui }}>{s.label}</div>
          </div>
        ))}
      </div>
      <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 14, padding: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10, fontFamily: FONT.ui }}>
          <span style={{ color: C.text, fontSize: 13.5, fontWeight: 600 }}>Daily Goal</span>
          <span style={{ color: C.gold, fontSize: 12.5, fontWeight: 700 }}>{deck.reviewsCompletedToday} / {dailyGoal} cards</span>
        </div>
        <ProgressBar progress={progress} />
      </div>
      <div style={{ background: `linear-gradient(135deg, ${C.gold}18, ${C.blue}0D)`, border: `1px solid ${C.gold}33`, borderRadius: 18, padding: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 14, marginBottom: 14 }}>
          <div>
            <div style={{ color: C.cream, fontWeight: 700, fontSize: 16, fontFamily: FONT.ui }}>
              {startDisabled ? 'All caught up' : 'Ready to practice?'}
            </div>
            <div style={{ color: C.mutedHi, fontSize: 12.5, marginTop: 3, fontFamily: FONT.ui }}>
              {deck.dueNow + deck.newAvailable} ready · mixed modes · synced reviews
            </div>
          </div>
          <BookOpen size={26} color={C.gold} />
        </div>
        <Btn onClick={onStart} disabled={startDisabled || starting} style={{ width: '100%' }}>
          {starting ? 'Starting...' : 'Start Session'}
        </Btn>
        {error && <div style={{ color: C.red, fontSize: 12, marginTop: 10, fontFamily: FONT.ui }}>{error}</div>}
      </div>
      <div>
        <div style={{ color: C.muted, fontSize: 10.5, letterSpacing: '0.14em', textTransform: 'uppercase', marginBottom: 10, fontFamily: FONT.ui, fontWeight: 700 }}>Saved Words</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {words.slice(0, 18).map((w) => (
            <div key={w.id} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ color: C.cream, fontWeight: 600, fontSize: 15, fontFamily: FONT.display, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.word}</div>
                <div style={{ color: C.muted, fontSize: 11.5, marginTop: 1, fontFamily: FONT.ui, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.book}</div>
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
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, opacity: busy ? 0.72 : 1, pointerEvents: busy ? 'none' : 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1 }}><ProgressBar progress={stepIndex / Math.max(1, totalSteps)} /></div>
        <span style={{ color: C.muted, fontSize: 12, fontFamily: FONT.mono, minWidth: 44, textAlign: 'right' }}>{stepIndex + 1}/{totalSteps}</span>
      </div>
      <div key={step.id} style={{ animation: 'studioSlideIn 0.35s ease' }}>
        {step.exercise === 'mcq' && <ExerciseMCQ word={step.word} distractors={distractors} onComplete={onComplete} />}
        {step.exercise === 'cloze' && <ExerciseCloze word={step.word} onComplete={onComplete} />}
        {step.exercise === 'recall' && <ExerciseRecall word={step.word} onComplete={onComplete} />}
        {step.exercise === 'write-sentence' && <ExerciseWriteSentence word={step.word} onComplete={onComplete} />}
        {step.exercise === 'write-definition' && <ExerciseWriteDefinition word={step.word} onComplete={onComplete} />}
        {step.exercise === 'mnemonic' && <ExerciseMnemonic word={step.word} onComplete={onComplete} />}
      </div>
      {busy && <div style={{ color: C.muted, fontSize: 12, textAlign: 'center', fontFamily: FONT.ui }}>Saving progress...</div>}
    </div>
  )
}

function ResultsScreen({ results, words, deck, onDone }: { results: PracticeResult[]; words: PracticeWord[]; deck: DeckSummary | null; onDone: () => void }) {
  const correct = results.filter((r) => r.correct).length
  const pct = Math.round((correct / Math.max(1, results.length)) * 100)
  const byExercise = results.reduce<Record<ExerciseType, number>>((acc, r) => {
    acc[r.exercise] = (acc[r.exercise] || 0) + 1
    return acc
  }, {} as Record<ExerciseType, number>)
  const labels: Record<ExerciseType, string> = {
    mcq: 'Multiple Choice',
    cloze: 'Context Cloze',
    recall: 'Active Recall',
    'write-sentence': 'Write Sentence',
    'write-definition': 'Free Recall',
    mnemonic: 'Memory Hook',
  }
  const uniqueWords = Array.from(new Map(words.map((word) => [word.id, word])).values())

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22, alignItems: 'center', textAlign: 'center' }}>
      <div>
        <div style={{ color: C.cream, fontFamily: FONT.display, fontSize: 28, fontWeight: 600 }}>Session complete</div>
        <div style={{ color: C.muted, fontSize: 13.5, marginTop: 4, fontFamily: FONT.ui }}>{results.length} exercises · {correct} correct</div>
      </div>
      <div style={{ width: 110, height: 110, borderRadius: '50%', background: `conic-gradient(${C.gold} ${pct}%, ${C.border} 0%)`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ width: 90, height: 90, borderRadius: '50%', background: C.card, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column' }}>
          <span style={{ color: C.gold, fontWeight: 800, fontSize: 22, fontFamily: FONT.ui }}>{pct}%</span>
          <span style={{ color: C.muted, fontSize: 10, fontFamily: FONT.ui, letterSpacing: '0.08em' }}>CORRECT</span>
        </div>
      </div>
      <div style={{ width: '100%', background: C.card, border: `1px solid ${C.border}`, borderRadius: 14, padding: 16, textAlign: 'left' }}>
        <div style={{ color: C.cream, fontSize: 13.5, fontWeight: 600, marginBottom: 10, fontFamily: FONT.ui }}>Exercises completed</div>
        {Object.entries(byExercise).map(([key, value]) => (
          <div key={key} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: `1px solid ${C.border}` }}>
            <span style={{ color: C.text, fontSize: 13, fontFamily: FONT.ui }}>{labels[key as ExerciseType]}</span>
            <span style={{ color: C.muted, fontSize: 12.5, fontFamily: FONT.mono }}>x {value}</span>
          </div>
        ))}
      </div>
      <div style={{ width: '100%', background: C.card, border: `1px solid ${C.border}`, borderRadius: 14, padding: 16, textAlign: 'left' }}>
        <div style={{ color: C.cream, fontSize: 13.5, fontWeight: 600, marginBottom: 10, fontFamily: FONT.ui }}>Next reviews scheduled</div>
        {uniqueWords.map((w) => {
          const intervals = computeIntervals(w)
          return (
            <div key={w.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '6px 0', borderBottom: `1px solid ${C.border}` }}>
              <span style={{ color: C.text, fontSize: 13, fontFamily: FONT.display, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.word}</span>
              <span style={{ color: C.gold, fontSize: 12, fontFamily: FONT.mono, flex: '0 0 auto' }}>in {intervals.good}</span>
            </div>
          )
        })}
      </div>
      {deck && <div style={{ color: C.muted, fontSize: 12, fontFamily: FONT.ui }}>{deck.reviewsCompletedToday} reviews completed today</div>}
      <Btn onClick={onDone} style={{ width: '100%' }}>Back to Studio</Btn>
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
  const [submitting, setSubmitting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const stepStartedAt = useRef(Date.now())

  const { data: decks = [], isLoading: decksLoading } = useQuery({
    queryKey: ['decks'],
    queryFn: async () => {
      const res = await api.get<{ items: DeckSummary[] }>('/api/vocabulary/decks')
      return res.items ?? []
    },
  })
  const deck = decks[0]

  const { data: dashboard, isLoading: dashboardLoading } = useQuery({
    queryKey: ['deck-dashboard', deck?.id],
    queryFn: () => api.get<DeckDashboard>(`/api/vocabulary/decks/${deck!.id}`),
    enabled: Boolean(deck?.id),
  })

  const activeDeck = deckSummary ?? dashboard?.deck ?? deck ?? null
  const savedWords = useMemo(() => (dashboard?.notes ?? []).map(noteToSavedWord), [dashboard?.notes])
  const allDefinitions = useMemo(() => {
    const fromSaved = savedWords.map((word) => word.definition)
    const fromSession = practiceWords.map((word) => word.definition)
    return Array.from(new Set([...fromSaved, ...fromSession].filter(Boolean)))
  }, [practiceWords, savedWords])
  const currentStep = sessionPlan[stepIndex]
  const isLoading = decksLoading || (Boolean(deck?.id) && dashboardLoading)

  const startSession = useCallback(async () => {
    if (!deck || starting) return
    setStarting(true)
    setStartError(null)
    try {
      const res = await api.post<PracticeSessionResponse>(`/api/vocabulary/decks/${deck.id}/practice-sessions`, {
        focus: 'mixed',
        limit: 8,
      })
      const words = res.items.map(cardToPracticeWord)
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

  const startDisabled = !activeDeck || (activeDeck.dueNow + activeDeck.newAvailable + activeDeck.cardsByState.learning + activeDeck.cardsByState.relearning) === 0

  return (
    <div
      style={{
        background: C.bg,
        minHeight: '100svh',
        color: C.text,
        fontFamily: FONT.ui,
        display: 'flex',
        justifyContent: 'center',
        padding: '0 0 40px',
        backgroundImage: `radial-gradient(circle at 20% 0%, ${C.goldDim}08 0%, transparent 40%), radial-gradient(circle at 100% 22%, ${C.blue}10 0%, transparent 32%)`,
      }}
    >
      <style>{`
        @keyframes studioFadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes studioSlideIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        .studio-scope input::placeholder, .studio-scope textarea::placeholder { color: ${C.muted}; }
        .studio-scope input:focus, .studio-scope textarea:focus { border-color: ${C.gold} !important; }
      `}</style>
      <div className="studio-scope" style={{ width: '100%', maxWidth: 430, padding: '44px 20px 92px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 26 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <BookOpen size={18} color={C.gold} />
            <span style={{ color: C.gold, fontWeight: 800, fontSize: 16, fontFamily: FONT.display }}>Studio</span>
          </div>
          <div style={{ display: 'flex', gap: 14 }}>
            {(['dashboard', 'practice'] as const).map((item) => (
              <button
                key={item}
                onClick={() => {
                  if (item === 'dashboard') backToDashboard()
                  else if (sessionPlan.length > 0) setScreen('practice')
                }}
                style={{
                  background: 'none',
                  border: 'none',
                  color: screen === item ? C.gold : C.muted,
                  fontWeight: screen === item ? 700 : 500,
                  fontSize: 12.5,
                  cursor: item === 'practice' && sessionPlan.length === 0 ? 'default' : 'pointer',
                  fontFamily: FONT.ui,
                  textTransform: 'capitalize',
                }}
              >
                {item}
              </button>
            ))}
          </div>
        </div>

        {isLoading ? (
          <div style={{ display: 'grid', gap: 10 }}>
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} style={{ height: i === 0 ? 110 : 72, borderRadius: 14, background: C.card, border: `1px solid ${C.border}`, opacity: 0.7 }} />
            ))}
          </div>
        ) : !activeDeck ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '92px 18px', textAlign: 'center' }}>
            <div style={{ width: 64, height: 64, borderRadius: 20, background: C.card, border: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
              <BookOpen size={28} color={C.muted} />
            </div>
            <div style={{ color: C.cream, fontWeight: 700, marginBottom: 4 }}>No vocabulary deck yet</div>
            <div style={{ color: C.muted, fontSize: 13, lineHeight: 1.5 }}>Save words from the reader and they will appear here for practice.</div>
          </div>
        ) : screen === 'dashboard' ? (
          <Dashboard
            deck={activeDeck}
            words={savedWords}
            analytics={dashboard?.analytics}
            onStart={startSession}
            startDisabled={startDisabled}
            starting={starting}
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
          <ResultsScreen results={results} words={practiceWords} deck={activeDeck} onDone={backToDashboard} />
        )}
      </div>
    </div>
  )
}
