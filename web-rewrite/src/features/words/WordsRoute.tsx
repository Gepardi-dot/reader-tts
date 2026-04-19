import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getDeckDashboard, getDecks } from '@/shared/api/client'
import { formatDate, formatRelativeDate } from '@/shared/utils/format'
import styles from './WordsRoute.module.css'

export function WordsRoute() {
  const decksQuery = useQuery({ queryKey: ['decks'], queryFn: getDecks })
  const primaryDeckId = decksQuery.data?.[0]?.id ?? ''
  const deckDashboardQuery = useQuery({
    queryKey: ['deck-dashboard', primaryDeckId],
    queryFn: () => getDeckDashboard(primaryDeckId),
    enabled: Boolean(primaryDeckId),
  })

  const topNotes = useMemo(() => deckDashboardQuery.data?.notes.slice(0, 6) ?? [], [deckDashboardQuery.data?.notes])

  return (
    <section className={styles.layout}>
      <header className={`surface ${styles.hero}`}>
        <div>
          <p className="eyebrow">Words</p>
          <h2>Vocabulary and spaced repetition stay connected to the same reading workspace as books, notes, and studio.</h2>
        </div>
        <div className={styles.heroMeta}>
          <strong>{decksQuery.data?.[0]?.dueToday ?? 0} due today</strong>
          <strong>{decksQuery.data?.[0]?.newAvailable ?? 0} new</strong>
        </div>
      </header>

      <section className={styles.columns}>
        <article className={`surface ${styles.panel}`}>
          <p className="eyebrow">Deck</p>
          <h3>{decksQuery.data?.[0]?.title ?? 'Reader Vocabulary'}</h3>
          <div className={styles.metricGrid}>
            <div>
              <span>Due now</span>
              <strong>{decksQuery.data?.[0]?.dueNow ?? 0}</strong>
            </div>
            <div>
              <span>Due today</span>
              <strong>{decksQuery.data?.[0]?.dueToday ?? 0}</strong>
            </div>
            <div>
              <span>New</span>
              <strong>{decksQuery.data?.[0]?.newAvailable ?? 0}</strong>
            </div>
            <div>
              <span>Next due</span>
              <strong>{formatDate(decksQuery.data?.[0]?.nextDueAt)}</strong>
            </div>
          </div>
        </article>

        <article className={`surface ${styles.panel}`}>
          <p className="eyebrow">Recent reviews</p>
          <div className={styles.reviewList}>
            {(deckDashboardQuery.data?.recentReviews ?? []).slice(0, 6).map((review) => (
              <div className={styles.reviewCard} key={review.id}>
                <strong>{review.cue}</strong>
                <p>{review.topic ?? review.cardType}</p>
                <span>{formatRelativeDate(review.reviewedAt)}</span>
              </div>
            ))}
          </div>
        </article>
      </section>

      <article className={`surface ${styles.panel}`}>
        <p className="eyebrow">Imported words</p>
        <div className={styles.wordGrid}>
          {topNotes.length ? (
            topNotes.map((note) => (
              <div className={styles.wordCard} key={note.id}>
                <strong>{note.front}</strong>
                <p>{note.back ?? note.explanation ?? note.extra ?? 'Imported from the reader.'}</p>
                <span>{note.sourceBookTitle ?? 'Reader archive'}</span>
              </div>
            ))
          ) : (
            <p className={styles.emptyCopy}>No saved word cards yet. Save vocabulary from a book page and it will appear here.</p>
          )}
        </div>
      </article>
    </section>
  )
}
