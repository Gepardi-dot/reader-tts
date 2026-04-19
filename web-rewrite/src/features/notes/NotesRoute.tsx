import { useMemo } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { getBookReader, getBooks } from '@/shared/api/client'
import { formatDate } from '@/shared/utils/format'
import styles from './NotesRoute.module.css'

export function NotesRoute() {
  const booksQuery = useQuery({ queryKey: ['books'], queryFn: getBooks })
  const readerQueries = useQueries({
    queries: (booksQuery.data ?? []).map((book) => ({
      queryKey: ['reader', book.id, 'notes-route'],
      queryFn: () => getBookReader(book.id),
      staleTime: 30_000,
    })),
  })

  const groupedEntries = useMemo(() => {
    return readerQueries
      .map((query, index) => {
        const book = booksQuery.data?.[index]
        if (!book || !query.data) {
          return null
        }
        return {
          book,
          entries: query.data.highlights.filter((entry) => entry.kind === 'note' || entry.kind === 'highlight'),
        }
      })
      .filter((group): group is NonNullable<typeof group> => Boolean(group))
      .filter((group) => group.entries.length > 0)
  }, [booksQuery.data, readerQueries])

  return (
    <section className={styles.layout}>
      <header className={`surface ${styles.hero}`}>
        <div>
          <p className="eyebrow">Notes</p>
          <h2>Annotations stay in the same reading workspace and move alongside books, words, and studio.</h2>
        </div>
        <strong>{groupedEntries.reduce((count, group) => count + group.entries.length, 0)} entries</strong>
      </header>

      <div className={styles.groups}>
        {groupedEntries.length ? (
          groupedEntries.map((group) => (
            <article className={`surface ${styles.groupCard}`} key={group.book.id}>
              <div className={styles.groupHead}>
                <div>
                  <p className="eyebrow">From book</p>
                  <h3>{group.book.title}</h3>
                </div>
                <Link className="button button--secondary" to={`/book/${group.book.id}`}>
                  Open book
                </Link>
              </div>

              <div className={styles.entryList}>
                {group.entries.map((entry) => (
                  <div className={styles.entryCard} key={entry.id}>
                    <strong>{entry.text}</strong>
                    {entry.note ? <p>{entry.note}</p> : null}
                    <span>{formatDate(entry.createdAt)}</span>
                  </div>
                ))}
              </div>
            </article>
          ))
        ) : (
          <article className={`surface ${styles.empty}`}>
            <p className="eyebrow">Notes</p>
            <h3>No archived notes yet.</h3>
            <p>Open a book, select a passage, and save a highlight or note. This page will update as its own destination.</p>
          </article>
        )}
      </div>
    </section>
  )
}
