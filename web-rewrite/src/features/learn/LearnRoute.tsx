import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import {
  coachCard,
  createPracticeSession,
  generateVocabularyLesson,
  getDecks,
  getLearningHome,
  getProviders,
  getStoredAudioPreference,
  postLearningEvent,
  submitProduction,
  submitReview,
  testProvider,
} from '@/shared/api/client'
import { useAudioStore } from '@/shared/state/audioStore'
import type { VocabularyCoachResponse, VocabularyPracticeSessionPayload, VocabularySessionCard } from '@/shared/types/api'
import { formatDate, formatNumber, formatRelativeDate } from '@/shared/utils/format'
import { resolveAudioSelection } from '@/shared/utils/audioPreference'
import styles from './LearnRoute.module.css'

type SessionMode = 'review' | 'lesson' | null

function resetCardState() {
  return {
    answer: '',
    coach: null as VocabularyCoachResponse | null,
    productionDrafts: ['', '', ''],
    productionFeedback: null as { accepted: boolean; feedback: string; sentenceNotes: string[] } | null,
  }
}

export function LearnRoute() {
  const queryClient = useQueryClient()
  const audioPreference = getStoredAudioPreference()
  const setTrack = useAudioStore((state) => state.setTrack)
  const learningHomeQuery = useQuery({ queryKey: ['learning-home'], queryFn: getLearningHome })
  const decksQuery = useQuery({ queryKey: ['decks'], queryFn: getDecks })
  const providersQuery = useQuery({ queryKey: ['providers'], queryFn: getProviders })
  const [mode, setMode] = useState<SessionMode>(null)
  const [session, setSession] = useState<VocabularyPracticeSessionPayload | null>(null)
  const [currentCard, setCurrentCard] = useState<VocabularySessionCard | null>(null)
  const [completedCount, setCompletedCount] = useState(0)
  const [cardState, setCardState] = useState(resetCardState())

  const defaultDeck = learningHomeQuery.data?.defaultDeck ?? decksQuery.data?.[0] ?? null
  const selection = useMemo(() => {
    return providersQuery.data
      ? resolveAudioSelection(providersQuery.data.providers, audioPreference)
      : { provider: null, voiceId: null, modelId: null }
  }, [audioPreference, providersQuery.data])

  const lessonPlanQuery = useQuery({
    queryKey: ['lesson-plan', currentCard?.id],
    queryFn: () => generateVocabularyLesson(currentCard!.id),
    enabled: mode === 'lesson' && Boolean(currentCard?.id),
  })

  const startSessionMutation = useMutation({
    mutationFn: ({ deckId, focus, nextMode }: { deckId: string; focus: 'mixed' | 'new'; nextMode: SessionMode }) =>
      createPracticeSession(deckId, {
        focus,
        limit: 5,
      }).then((payload) => ({ payload, nextMode })),
    onSuccess: ({ payload, nextMode }) => {
      setMode(nextMode)
      setSession(payload)
      setCurrentCard(payload.items[0] ?? null)
      setCompletedCount(0)
      setCardState(resetCardState())
    },
  })

  const reviewMutation = useMutation({
    mutationFn: (rating: 'again' | 'hard' | 'good' | 'easy') =>
      submitReview(currentCard!.id, {
        rating,
        answerMode: cardState.answer.trim() ? 'typed' : 'reveal',
        typedResponse: cardState.answer.trim() || undefined,
      }),
    onSuccess: async (payload, rating) => {
      await postLearningEvent({
        type: 'review_completed',
        xpDelta: rating === 'easy' ? 16 : rating === 'good' ? 12 : rating === 'hard' ? 9 : 5,
        deckId: payload.summary.id,
        cardId: payload.reviewedCard.id,
        bookId: payload.reviewedCard.sourceBookId ?? null,
        label: `Review rated ${rating}`,
        detail: payload.reviewedCard.cue,
      })
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['learning-home'] }),
        queryClient.invalidateQueries({ queryKey: ['decks'] }),
      ])
      setCompletedCount((value) => value + 1)
      setCurrentCard(payload.nextCard)
      setCardState(resetCardState())
      if (!payload.nextCard) {
        setMode(null)
      }
    },
  })

  const productionMutation = useMutation({
    mutationFn: () =>
      submitProduction(currentCard!.id, {
        sentences: cardState.productionDrafts,
      }),
    onSuccess: (payload) => {
      setCardState((current) => ({ ...current, productionFeedback: payload }))
    },
  })

  async function handleCheck(modeValue: 'review' | 'lesson') {
    if (!currentCard) {
      return
    }

    const payload = await coachCard(currentCard.id, {
      mode: modeValue,
      step: 'answer',
      turnIndex: 1,
      learnerResponse: cardState.answer.trim() || null,
    })
    setCardState((current) => ({ ...current, coach: payload }))
  }

  async function handlePlay(text: string, title: string) {
    if (!selection.provider) {
      return
    }
    const preview = await testProvider({
      provider: selection.provider.id,
      voice: selection.voiceId,
      model: selection.modelId,
      sampleText: text,
      outputFormat: audioPreference.outputFormat,
      narrationStyle: audioPreference.narrationStyle,
      lengthScale: audioPreference.lengthScale,
      sentenceSilence: audioPreference.sentenceSilence,
    })

    setTrack(
      {
        id: `${title}:${Date.now()}`,
        url: preview.audioUrl,
        title,
        subtitle: selection.provider.name,
      },
      true,
    )
  }

  async function handleNextLesson() {
    if (!currentCard || !session) {
      return
    }

    await postLearningEvent({
      type: 'lesson_completed',
      xpDelta: 20,
      deckId: currentCard.deckId,
      cardId: currentCard.id,
      bookId: currentCard.sourceBookId ?? null,
      label: 'Lesson completed',
      detail: currentCard.cue,
    })

    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['learning-home'] }),
      queryClient.invalidateQueries({ queryKey: ['decks'] }),
    ])

    const currentIndex = session.items.findIndex((item) => item.id === currentCard.id)
    const nextCard = session.items[currentIndex + 1] ?? null
    setCompletedCount((value) => value + 1)
    setCurrentCard(nextCard)
    setCardState(resetCardState())
    if (!nextCard) {
      setMode(null)
    }
  }

  return (
    <section className={styles.layout}>
      <div className={styles.primaryColumn}>
        <section className={`surface ${styles.hero}`}>
          <div className={styles.heroCopy}>
            <p className="eyebrow">Learn</p>
            <h2>Keep the book open, but make the progress loop visible.</h2>
            <p>
              Today you have {formatNumber(learningHomeQuery.data?.hero.reviewsToday ?? 0)} reviews,{' '}
              {formatNumber(learningHomeQuery.data?.hero.lessonsToday ?? 0)} lessons, and{' '}
              {formatNumber(Math.max(0, (learningHomeQuery.data?.hero.xpGoal ?? 0) - (learningHomeQuery.data?.hero.xpToday ?? 0)))} XP left to hit the daily mark.
            </p>
          </div>

          <div className={styles.heroStats}>
            <div>
              <span>Streak</span>
              <strong>{learningHomeQuery.data?.hero.streakDays ?? 0}d</strong>
            </div>
            <div>
              <span>XP today</span>
              <strong>{learningHomeQuery.data?.hero.xpToday ?? 0}</strong>
            </div>
            <div>
              <span>Continue</span>
              <strong>{learningHomeQuery.data?.continueBook?.book.title ?? 'No book yet'}</strong>
            </div>
          </div>
        </section>

        <section className={styles.actionsGrid}>
          <article className={`surface ${styles.actionCard}`}>
            <p className="eyebrow">Continue book</p>
            <h3>{learningHomeQuery.data?.continueBook?.book.title ?? 'Upload a book to begin'}</h3>
            <p>
              {learningHomeQuery.data?.continueBook
                ? `Resume on page ${learningHomeQuery.data.continueBook.progress?.reading?.pageNumber ?? 1} with listening continuity intact.`
                : 'Bring in a PDF and the rewrite will turn it into a reading and listening workspace.'}
            </p>
            {learningHomeQuery.data?.continueBook ? (
              <a className="button button--primary" href={`/book/${learningHomeQuery.data.continueBook.book.id}`}>
                {learningHomeQuery.data.continueBook.ctaLabel}
              </a>
            ) : (
              <a className="button button--primary" href="/upload">
                Upload first book
              </a>
            )}
          </article>

          <article className={`surface ${styles.actionCard}`}>
            <p className="eyebrow">Review queue</p>
            <h3>{defaultDeck ? `${defaultDeck.dueNow} due right now` : 'No deck yet'}</h3>
            <p>Start a compact spaced-repetition run with the current default deck and keep the session in the same shell.</p>
            <button
              className="button button--secondary"
              disabled={!defaultDeck || startSessionMutation.isPending}
              onClick={() => defaultDeck && startSessionMutation.mutate({ deckId: defaultDeck.id, focus: 'mixed', nextMode: 'review' })}
              type="button"
            >
              Start review
            </button>
          </article>

          <article className={`surface ${styles.actionCard}`}>
            <p className="eyebrow">Lesson sprint</p>
            <h3>{learningHomeQuery.data?.lessonQueue?.queued ?? 0} queued</h3>
            <p>Generate context, speak the term, and push into production before the next card shows up.</p>
            <button
              className="button button--secondary"
              disabled={!defaultDeck || startSessionMutation.isPending}
              onClick={() => defaultDeck && startSessionMutation.mutate({ deckId: defaultDeck.id, focus: 'new', nextMode: 'lesson' })}
              type="button"
            >
              Start lesson
            </button>
          </article>
        </section>

        <section className={styles.sessionSurface}>
          {mode && currentCard ? (
            <motion.article
              animate={{ opacity: 1, y: 0 }}
              className={`surface ${styles.sessionCard}`}
              initial={{ opacity: 0, y: 18 }}
              key={`${mode}-${currentCard.id}`}
            >
              <div className={styles.sessionHeader}>
                <div>
                  <p className="eyebrow">{mode === 'review' ? 'Review session' : 'Lesson session'}</p>
                  <h3>{currentCard.cue}</h3>
                  <p>
                    {currentCard.sourceBookTitle ? `${currentCard.sourceBookTitle} - ` : ''}
                    {currentCard.exampleSentence ?? currentCard.explanation ?? currentCard.answer}
                  </p>
                </div>
                <div className={styles.sessionMeter}>
                  <span>Completed</span>
                  <strong>
                    {completedCount}
                    <small> / {session?.items.length ?? 0}</small>
                  </strong>
                </div>
              </div>

              <div className={styles.sessionActions}>
                <button className="button button--secondary" onClick={() => void handlePlay(currentCard.cue, currentCard.cue)} type="button">
                  Hear term
                </button>
                <button
                  className="button button--secondary"
                  disabled={!currentCard.exampleSentence && !lessonPlanQuery.data?.contextParagraph}
                  onClick={() => void handlePlay(currentCard.exampleSentence ?? lessonPlanQuery.data?.contextParagraph ?? '', 'Context line')}
                  type="button"
                >
                  Hear sentence
                </button>
              </div>

              {mode === 'lesson' && lessonPlanQuery.data ? (
                <div className={styles.lessonContext}>
                  <span>Scene</span>
                  <strong>{lessonPlanQuery.data.contextTitle}</strong>
                  <p>{lessonPlanQuery.data.contextParagraph}</p>
                </div>
              ) : null}

              <label className="field">
                <span>{mode === 'review' ? 'Your recall' : 'Your explanation'}</span>
                <textarea
                  className="textarea"
                  onChange={(event) => setCardState((current) => ({ ...current, answer: event.target.value }))}
                  placeholder={mode === 'review' ? 'Type the meaning from memory.' : 'Explain the word in plain English.'}
                  value={cardState.answer}
                />
              </label>

              <div className={styles.sessionActions}>
                <button className="button button--primary" onClick={() => void handleCheck(mode)} type="button">
                  Check with AI coach
                </button>
                {mode === 'review' ? <span className={styles.answerKey}>Answer: {currentCard.answer}</span> : null}
              </div>

              {cardState.coach ? (
                <div className={styles.feedbackBlock}>
                  <p className="eyebrow">{cardState.coach.provider === 'fallback' ? 'Coach' : `${cardState.coach.provider} coach`}</p>
                  <strong>{cardState.coach.feedbackTitle}</strong>
                  <p>{cardState.coach.feedbackBody}</p>
                  <p className={styles.answerKey}>Correction: {cardState.coach.correction}</p>
                </div>
              ) : null}

              {mode === 'review' ? (
                <div className={styles.ratingRow}>
                  {(['again', 'hard', 'good', 'easy'] as const).map((rating) => (
                    <button
                      className="button button--secondary"
                      disabled={!cardState.coach || reviewMutation.isPending}
                      key={rating}
                      onClick={() => reviewMutation.mutate(rating)}
                      type="button"
                    >
                      {rating}
                    </button>
                  ))}
                </div>
              ) : (
                <div className={styles.productionArea}>
                  <p className="eyebrow">Production</p>
                  {cardState.productionDrafts.map((draft, index) => (
                    <input
                      className="input"
                      key={index}
                      onChange={(event) =>
                        setCardState((current) => {
                          const nextDrafts = [...current.productionDrafts]
                          nextDrafts[index] = event.target.value
                          return { ...current, productionDrafts: nextDrafts }
                        })
                      }
                      placeholder={`Sentence ${index + 1}`}
                      value={draft}
                    />
                  ))}
                  <div className={styles.sessionActions}>
                    <button
                      className="button button--secondary"
                      disabled={productionMutation.isPending || cardState.productionDrafts.some((draft) => !draft.trim())}
                      onClick={() => productionMutation.mutate()}
                      type="button"
                    >
                      Submit production
                    </button>
                    <button
                      className="button button--primary"
                      disabled={!cardState.productionFeedback?.accepted}
                      onClick={() => void handleNextLesson()}
                      type="button"
                    >
                      Next word
                    </button>
                  </div>
                  {cardState.productionFeedback ? (
                    <div className={styles.feedbackBlock}>
                      <strong>{cardState.productionFeedback.feedback}</strong>
                      {cardState.productionFeedback.sentenceNotes.map((note) => (
                        <p key={note}>{note}</p>
                      ))}
                    </div>
                  ) : null}
                </div>
              )}
            </motion.article>
          ) : (
            <article className={`surface ${styles.sessionEmpty}`}>
              <p className="eyebrow">Session workspace</p>
              <h3>Launch a review or lesson without leaving the Learn surface.</h3>
              <p>The rewrite keeps the activity loop in one calm workspace: continue the book, review a saved term, or run a lesson sprint.</p>
            </article>
          )}
        </section>
      </div>

      <aside className={styles.sideColumn}>
        <section className={`surface ${styles.activityPanel}`}>
          <p className="eyebrow">Recent activity</p>
          <div className={styles.activityList}>
            {learningHomeQuery.data?.recentActivity.map((item) => (
              <div className={styles.activityItem} key={item.id}>
                <div>
                  <strong>{item.label}</strong>
                  {item.detail ? <p>{item.detail}</p> : null}
                </div>
                <span>{formatRelativeDate(item.createdAt)}</span>
              </div>
            ))}
          </div>
        </section>

        <section className={`surface ${styles.activityPanel}`}>
          <p className="eyebrow">Deck pulse</p>
          <div className={styles.deckPulse}>
            <div>
              <span>Due today</span>
              <strong>{defaultDeck?.dueToday ?? 0}</strong>
            </div>
            <div>
              <span>New available</span>
              <strong>{defaultDeck?.newAvailable ?? 0}</strong>
            </div>
            <div>
              <span>Next due</span>
              <strong>{formatDate(defaultDeck?.nextDueAt)}</strong>
            </div>
          </div>
        </section>
      </aside>
    </section>
  )
}
