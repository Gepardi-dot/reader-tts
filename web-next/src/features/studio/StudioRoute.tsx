import { useState, useRef, useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { BookOpen, Flame, Clock, RotateCcw, Trophy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { api } from '@/shared/api/client'
import { cn } from '@/lib/utils'

// ── Types ─────────────────────────────────────────────
type Rating = 'again' | 'hard' | 'good' | 'easy'
type CardState = 'new' | 'learning' | 'review' | 'relearning'

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

interface SessionCard {
  id: string
  cue: string
  answer: string
  extra: string | null
  hint: string | null
  explanation: string | null
  exampleSentence: string | null
  state: CardState
  topic: string | null
  sourceBookTitle: string | null
  cardType: 'basic' | 'reverse' | 'cloze'
  ratingPreview: Record<Rating, { dueAt: string; label: string; state: CardState }>
}

// ── Helpers ───────────────────────────────────────────
function formatDue(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  const now = new Date()
  if (d <= now) return 'Now'
  const diff = d.getTime() - now.getTime()
  const mins = Math.floor(diff / 60_000)
  const hours = Math.floor(diff / 3_600_000)
  const days = Math.floor(diff / 86_400_000)
  if (mins < 60) return `${mins}m`
  if (hours < 24) return `${hours}h`
  return `${days}d`
}

function stateBadgeColor(state: CardState) {
  return {
    new:        'bg-sky-100 text-sky-700',
    learning:   'bg-amber-100 text-amber-700',
    review:     'bg-green-100 text-green-700',
    relearning: 'bg-rose-100 text-rose-700',
  }[state]
}

// ── Rating button ─────────────────────────────────────
const RATING_CONFIG: Record<Rating, { label: string; color: string; activeColor: string }> = {
  again: { label: 'Again', color: 'border-rose-200 text-rose-600',   activeColor: 'bg-rose-500 text-white border-rose-500' },
  hard:  { label: 'Hard',  color: 'border-amber-200 text-amber-600', activeColor: 'bg-amber-500 text-white border-amber-500' },
  good:  { label: 'Good',  color: 'border-green-200 text-green-600', activeColor: 'bg-green-500 text-white border-green-500' },
  easy:  { label: 'Easy',  color: 'border-blue-200 text-blue-600',   activeColor: 'bg-blue-500 text-white border-blue-500' },
}

// ── Phase: Idle (dashboard) ───────────────────────────
function IdlePhase({ deck, onStart }: { deck: DeckSummary; onStart: () => void }) {
  const reviewedPct = deck.dueToday > 0
    ? Math.min(100, Math.round((deck.reviewsCompletedToday / deck.dueToday) * 100))
    : 0

  return (
    <div className="px-4 space-y-5 pb-6">
      {/* Start CTA */}
      <div className="rounded-2xl bg-primary/5 border border-primary/20 p-5 flex items-center justify-between gap-4">
        <div>
          <p className="font-semibold text-foreground">
            {deck.dueNow > 0 ? `${deck.dueNow} cards ready` : 'All caught up!'}
          </p>
          <p className="text-sm text-muted-foreground mt-0.5">
            {deck.dueNow > 0 ? 'Start your practice session' : 'Check back later for more reviews'}
          </p>
        </div>
        <Button
          onClick={onStart}
          disabled={deck.dueNow === 0}
          className="shrink-0"
        >
          {deck.dueNow > 0 ? 'Start' : 'Done'}
        </Button>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Due now',   value: deck.dueNow,       accent: deck.dueNow > 0 },
          { label: 'Due today', value: deck.dueToday,     accent: false },
          { label: 'New',       value: deck.newAvailable,  accent: false },
        ].map(({ label, value, accent }) => (
          <div key={label} className={cn('rounded-xl p-4', accent ? 'bg-primary/10' : 'bg-muted/50')}>
            <span className={cn('text-2xl font-bold tabular-nums', accent ? 'text-primary' : 'text-foreground')}>
              {value}
            </span>
            <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
          </div>
        ))}
      </div>

      {/* Daily progress */}
      {deck.dueToday > 0 && (
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Flame size={15} className={reviewedPct >= 100 ? 'text-orange-500' : 'text-muted-foreground'} />
              <span className="text-sm font-medium text-foreground">Today's progress</span>
            </div>
            <span className="text-sm text-muted-foreground tabular-nums">
              {deck.reviewsCompletedToday} / {deck.dueToday}
            </span>
          </div>
          <Progress value={reviewedPct} className="h-2" />
          {deck.nextDueAt && (
            <p className="text-xs text-muted-foreground mt-2 flex items-center gap-1">
              <Clock size={11} />
              Next due: {formatDue(deck.nextDueAt)}
            </p>
          )}
        </div>
      )}

      {/* Card state breakdown */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <span className="text-sm font-medium text-foreground">
            {deck.cardCount} cards · {deck.noteCount} words
          </span>
        </div>
        <div className="divide-y divide-border">
          {(
            [
              { key: 'new' as const,        label: 'New',        dot: 'bg-sky-400' },
              { key: 'learning' as const,   label: 'Learning',   dot: 'bg-amber-400' },
              { key: 'review' as const,     label: 'Review',     dot: 'bg-green-400' },
              { key: 'relearning' as const, label: 'Relearning', dot: 'bg-rose-400' },
            ]
          ).map(({ key, label, dot }) => (
            <div key={key} className="flex items-center justify-between px-4 py-3">
              <div className="flex items-center gap-3">
                <div className={cn('w-2 h-2 rounded-full', dot)} />
                <span className="text-sm text-foreground">{label}</span>
              </div>
              <span className="text-sm font-medium tabular-nums text-foreground">
                {deck.cardsByState[key]}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Phase: Session (flashcard) ────────────────────────
function SessionPhase({
  card,
  sessionDone,
  totalReviewed,
  onRate,
  onFinish,
}: {
  card: SessionCard
  sessionDone: boolean
  totalReviewed: number
  onRate: (rating: Rating) => Promise<void>
  onFinish: () => void
}) {
  const [revealed, setRevealed] = useState(false)
  const [submitting, setSubmitting] = useState<Rating | null>(null)
  const startTime = useRef(Date.now())

  // Reset reveal when card changes
  const cardId = card.id
  const prevCardId = useRef(cardId)
  if (prevCardId.current !== cardId) {
    prevCardId.current = cardId
    // Note: can't call setRevealed here in render — handled via key prop below
  }

  async function handleRate(rating: Rating) {
    if (submitting) return
    setSubmitting(rating)
    await onRate(rating)
    setSubmitting(null)
    setRevealed(false)
    startTime.current = Date.now()
  }

  return (
    <div className="flex flex-col min-h-[calc(100svh-112px)] px-4">
      {/* Progress strip */}
      <div className="flex items-center gap-3 py-3">
        <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
          <div
            className="h-full rounded-full bg-primary transition-all duration-500"
            style={{ width: `${totalReviewed > 0 ? Math.min(100, (totalReviewed / (totalReviewed + 1)) * 100) : 0}%` }}
          />
        </div>
        <span className="text-xs text-muted-foreground tabular-nums shrink-0">{totalReviewed} done</span>
      </div>

      {/* Card */}
      <div className="flex-1 flex flex-col justify-center gap-4 py-4">
        {/* State + source */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className={cn('text-xs px-2 py-0.5 rounded-full font-medium', stateBadgeColor(card.state))}>
            {card.state}
          </span>
          {card.sourceBookTitle && (
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <BookOpen size={11} />
              {card.sourceBookTitle}
            </span>
          )}
        </div>

        {/* Cue (word to recall) */}
        <div className="rounded-2xl border border-border bg-card p-6 shadow-sm">
          <p className="text-xs text-muted-foreground mb-3 uppercase tracking-wide">
            {card.cardType === 'reverse' ? 'Definition → Word' : 'What does this mean?'}
          </p>
          <p
            className="text-2xl font-semibold text-foreground leading-snug"
            style={{ fontFamily: 'Lora, Georgia, serif' }}
          >
            {card.cue}
          </p>
          {card.hint && !revealed && (
            <p className="text-sm text-muted-foreground mt-3 italic">Hint: {card.hint}</p>
          )}
        </div>

        {/* Answer reveal */}
        {revealed ? (
          <div className="rounded-2xl border border-primary/30 bg-primary/5 p-5 space-y-3">
            <p className="text-sm font-medium text-foreground">
              {card.answer}
            </p>
            {card.explanation && card.explanation !== card.answer && (
              <p className="text-sm text-muted-foreground">{card.explanation}</p>
            )}
            {card.exampleSentence && (
              <p
                className="text-sm text-muted-foreground italic border-t border-border pt-3"
                style={{ fontFamily: 'Lora, Georgia, serif' }}
              >
                "{card.exampleSentence}"
              </p>
            )}
          </div>
        ) : (
          <Button
            variant="outline"
            className="w-full h-12 text-base"
            onClick={() => setRevealed(true)}
          >
            Show answer
          </Button>
        )}
      </div>

      {/* Rating buttons (only after reveal) */}
      {revealed && (
        <div className="pb-4 space-y-3">
          <p className="text-xs text-center text-muted-foreground">How well did you remember?</p>
          <div className="grid grid-cols-4 gap-2">
            {(['again', 'hard', 'good', 'easy'] as Rating[]).map((r) => {
              const cfg = RATING_CONFIG[r]
              const preview = card.ratingPreview[r]
              const isSubmitting = submitting === r
              return (
                <button
                  key={r}
                  onClick={() => handleRate(r)}
                  disabled={Boolean(submitting)}
                  className={cn(
                    'flex flex-col items-center gap-1 py-3 rounded-xl border text-sm font-medium transition-all active:scale-95',
                    submitting
                      ? isSubmitting
                        ? cfg.activeColor
                        : 'border-border text-muted-foreground opacity-50'
                      : cn('hover:scale-[1.03]', cfg.color, 'bg-card'),
                  )}
                >
                  <span>{cfg.label}</span>
                  <span className="text-[10px] opacity-70">
                    {preview ? formatDue(preview.dueAt) : '—'}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      )}

      {sessionDone && (
        <div className="pb-4">
          <Button className="w-full h-12" onClick={onFinish}>
            <Trophy size={16} className="mr-2" />
            See results
          </Button>
        </div>
      )}
    </div>
  )
}

// ── Phase: Results ────────────────────────────────────
function ResultsPhase({ reviewed: count, deck, onRestart }: {
  reviewed: number
  deck: DeckSummary
  onRestart: () => void
}) {
  const pct = deck.dueToday > 0
    ? Math.min(100, Math.round((deck.reviewsCompletedToday / deck.dueToday) * 100))
    : 100

  return (
    <div className="flex flex-col items-center justify-center min-h-[calc(100svh-160px)] px-6 text-center">
      <div className="text-6xl mb-4">
        {pct >= 100 ? '🎉' : pct >= 60 ? '📖' : '💪'}
      </div>
      <h2 className="text-2xl font-semibold text-foreground mb-1">
        {count} card{count !== 1 ? 's' : ''} reviewed
      </h2>
      <p className="text-muted-foreground mb-6">
        {pct >= 100 ? 'All done for today!' : `${deck.dueNow} still due`}
      </p>

      <div className="w-full max-w-xs mb-8">
        <Progress value={pct} className="h-3" />
        <p className="text-xs text-muted-foreground mt-2">
          {deck.reviewsCompletedToday} / {deck.dueToday} today
        </p>
      </div>

      <div className="flex gap-3 w-full max-w-xs">
        {deck.dueNow > 0 && (
          <Button className="flex-1" onClick={onRestart}>
            Keep going
          </Button>
        )}
        <Button variant="outline" className="flex-1" onClick={onRestart}>
          <RotateCcw size={14} className="mr-1.5" />
          Done
        </Button>
      </div>
    </div>
  )
}

// ── Main StudioRoute ──────────────────────────────────
export function StudioRoute() {
  const [phase, setPhase] = useState<'idle' | 'session' | 'results'>('idle')
  const [currentCard, setCurrentCard] = useState<SessionCard | null>(null)
  const [sessionDone, setSessionDone] = useState(false)
  const [reviewedCount, setReviewedCount] = useState(0)
  const [deckSummary, setDeckSummary] = useState<DeckSummary | null>(null)
  const [sessionCardKey, setSessionCardKey] = useState(0)
  const queryClient = useQueryClient()

  // Fetch deck list
  const { data: decks = [], isLoading: decksLoading } = useQuery({
    queryKey: ['decks'],
    queryFn: async () => {
      try {
        const res = await api.get<{ items: DeckSummary[] }>('/api/vocabulary/decks')
        return res.items ?? []
      } catch { return [] }
    },
  })

  const deck = decks[0]

  // Fetch deck dashboard for idle stats
  const { data: dashboard, isLoading: dashLoading } = useQuery({
    queryKey: ['deck-dashboard', deck?.id],
    queryFn: () => api.get<{ deck: DeckSummary }>(`/api/vocabulary/decks/${deck!.id}`),
    enabled: Boolean(deck?.id) && phase === 'idle',
  })

  const activeDeck = deckSummary ?? dashboard?.deck ?? deck ?? null
  const isLoading = decksLoading || (Boolean(deck) && dashLoading && phase === 'idle')

  // Start a session: GET /api/vocabulary/decks/:id/session
  const startSession = useCallback(async () => {
    if (!deck) return
    try {
      const res = await api.get<{ deck: DeckSummary; summary: DeckSummary; currentCard: SessionCard | null }>(
        `/api/vocabulary/decks/${deck.id}/session`,
      )
      setDeckSummary(res.summary)
      setCurrentCard(res.currentCard)
      setSessionDone(!res.currentCard)
      setReviewedCount(0)
      setSessionCardKey((k) => k + 1)
      setPhase('session')
    } catch (e) {
      console.error('Failed to start session', e)
    }
  }, [deck])

  // Submit a rating: POST /api/vocabulary/cards/:id/reviews
  const submitRating = useCallback(async (rating: Rating) => {
    if (!currentCard) return
    try {
      const res = await api.post<{ reviewedCard: SessionCard; summary: DeckSummary; nextCard: SessionCard | null }>(
        `/api/vocabulary/cards/${currentCard.id}/reviews`,
        {
          rating,
          responseMs: null,
          answerMode: 'self_report',
        },
      )
      setReviewedCount((n) => n + 1)
      setDeckSummary(res.summary)
      if (res.nextCard) {
        setCurrentCard(res.nextCard)
        setSessionCardKey((k) => k + 1)
        setSessionDone(false)
      } else {
        setSessionDone(true)
        setCurrentCard(null)
      }
    } catch (e) {
      console.error('Failed to submit rating', e)
    }
  }, [currentCard])

  function finishSession() {
    queryClient.invalidateQueries({ queryKey: ['deck-dashboard'] })
    queryClient.invalidateQueries({ queryKey: ['decks'] })
    setPhase('idle')
    setCurrentCard(null)
    setSessionDone(false)
    setDeckSummary(null)
  }

  // ── Render ──
  return (
    <div className="min-h-svh bg-background">
      {/* Header */}
      <div className="px-4 pt-6 pb-2">
        <h1 className="text-xl font-semibold text-foreground">Studio</h1>
        {activeDeck && (
          <p className="text-sm text-muted-foreground mt-0.5">{activeDeck.title}</p>
        )}
      </div>

      {isLoading ? (
        <div className="px-4 space-y-3 pt-4">
          <div className="grid grid-cols-3 gap-3">
            {[1, 2, 3].map((i) => <div key={i} className="h-20 rounded-xl bg-muted animate-pulse" />)}
          </div>
          {[1, 2].map((i) => <div key={i} className="h-24 rounded-xl bg-muted animate-pulse" />)}
        </div>
      ) : !activeDeck ? (
        <div className="flex flex-col items-center justify-center px-6 py-24 text-center">
          <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center mb-4">
            <BookOpen size={28} className="text-muted-foreground/50" />
          </div>
          <p className="font-medium text-foreground mb-1">No vocabulary deck yet</p>
          <p className="text-sm text-muted-foreground max-w-xs">
            Save words from the reader to start practicing here.
          </p>
        </div>
      ) : phase === 'idle' ? (
        <IdlePhase deck={activeDeck} onStart={startSession} />
      ) : phase === 'session' ? (
        currentCard ? (
          <SessionPhase
            key={sessionCardKey}
            card={currentCard}
            sessionDone={sessionDone}
            totalReviewed={reviewedCount}
            onRate={submitRating}
            onFinish={() => setPhase('results')}
          />
        ) : (
          // No card (all done mid-session)
          <div className="flex flex-col items-center justify-center min-h-[calc(100svh-160px)] px-6 text-center">
            <div className="text-5xl mb-4">✅</div>
            <p className="text-lg font-semibold text-foreground mb-2">Session complete!</p>
            <p className="text-muted-foreground mb-6">{reviewedCount} cards reviewed</p>
            <Button onClick={() => setPhase('results')}>
              <Trophy size={16} className="mr-2" /> See results
            </Button>
          </div>
        )
      ) : (
        <ResultsPhase
          reviewed={reviewedCount}
          deck={activeDeck}
          onRestart={finishSession}
        />
      )}

      {/* Bottom padding for mobile nav */}
      <div className="h-6 md:hidden" />
    </div>
  )
}
