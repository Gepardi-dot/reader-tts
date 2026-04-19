import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { deleteBook, getBooks, getDecks } from '@/shared/api/client'
import type { Book, ReadingProgress } from '@/shared/types/api'
import { formatDate, formatNumber } from '@/shared/utils/format'
import styles from './LibraryRoute.module.css'

const READING_PROGRESS_KEY = 'storybook-reader-progress'

function loadLocalProgress(): Record<string, ReadingProgress> {
  try {
    const raw = localStorage.getItem(READING_PROGRESS_KEY)
    return raw ? (JSON.parse(raw) as Record<string, ReadingProgress>) : {}
  } catch {
    return {}
  }
}

function progressPercent(p: ReadingProgress | null | undefined): number {
  if (!p || p.totalPages <= 0) return 0
  return Math.round((p.pageNumber / p.totalPages) * 100)
}

function matchesSearch(book: Book, query: string): boolean {
  if (!query) return true
  const q = query.toLowerCase()
  return book.title.toLowerCase().includes(q) || book.excerpt.toLowerCase().includes(q)
}

export function LibraryRoute() {
  const queryClient = useQueryClient()
  const booksQuery = useQuery({ queryKey: ['books'], queryFn: getBooks })
  const decksQuery = useQuery({ queryKey: ['decks'], queryFn: getDecks })
  const localProgress = loadLocalProgress()

  const [search, setSearch] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  const deleteMutation = useMutation({
    mutationFn: (bookId: string) => deleteBook(bookId),
    onSuccess: async () => {
      setConfirmDeleteId(null)
      await queryClient.invalidateQueries({ queryKey: ['books'] })
    },
  })

  const books = booksQuery.data ?? []
  const filtered = books.filter((b) => matchesSearch(b, search))
  const deck = decksQuery.data?.[0]

  return (
    <section className={styles.layout}>
      <header className={`surface ${styles.hero}`}>
        <div>
          <p className="eyebrow">Books</p>
          <h2>Your reading shelf sits in the same workspace as notes, words, and studio.</h2>
        </div>
        <strong>{books.length} book{books.length !== 1 ? 's' : ''}</strong>
      </header>

      {/* Toolbar */}
      <div className={styles.toolbar}>
        <div className={styles.searchWrap}>
          <span className={styles.searchIcon} aria-hidden>⌕</span>
          <input
            className={styles.searchInput}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search books…"
            type="search"
            value={search}
          />
        </div>
        <Link className="button button--primary" to="/upload">
          + Upload
        </Link>
      </div>

      {/* Stats row */}
      <div className={styles.stats}>
        <div className={`surface ${styles.statCard}`}>
          <strong>{books.length}</strong>
          <span>Books</span>
        </div>
        <div className={`surface ${styles.statCard}`}>
          <strong>{deck?.dueToday ?? 0}</strong>
          <span>Due today</span>
        </div>
        <div className={`surface ${styles.statCard}`}>
          <strong>{deck?.newAvailable ?? 0}</strong>
          <span>New cards</span>
        </div>
        {deck ? (
          <Link className={`surface ${styles.statCard} ${styles.statLink}`} to="/studio">
            <strong>Study</strong>
            <span>{deck.title}</span>
          </Link>
        ) : null}
      </div>

      {/* Book grid */}
      {booksQuery.isLoading ? (
        <div className={styles.empty}>
          <p>Loading your library…</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className={styles.empty}>
          {search ? (
            <p>No books match "{search}". <button className={styles.clearBtn} onClick={() => setSearch('')} type="button">Clear</button></p>
          ) : (
            <>
              <p>No books yet.</p>
              <Link className="button button--primary" to="/upload">Upload your first PDF</Link>
            </>
          )}
        </div>
      ) : (
        <div className={styles.grid}>
          {filtered.map((book) => {
            const progress = localProgress[book.id] ?? null
            const pct = progressPercent(progress)
            const isDeleting = deleteMutation.isPending && confirmDeleteId === book.id

            return (
              <article className={`surface ${styles.card}`} key={book.id}>
                {/* Progress bar */}
                {pct > 0 && (
                  <div className={styles.cardProgress} aria-label={`${pct}% read`}>
                    <div className={styles.cardProgressFill} style={{ width: `${pct}%` }} />
                  </div>
                )}

                <div className={styles.cardBody}>
                  <div className={styles.cardMeta}>
                    <span className="eyebrow">{formatDate(book.uploadedAt)}</span>
                    {pct > 0 && <span className={styles.pctBadge}>{pct}%</span>}
                  </div>
                  <h3 className={styles.cardTitle}>{book.title}</h3>
                  {book.excerpt ? <p className={styles.cardExcerpt}>{book.excerpt}</p> : null}
                  <div className={styles.cardStats}>
                    <span>{formatNumber(book.pageCount)} pages</span>
                    {book.highlightCount > 0 && <span>{book.highlightCount} highlights</span>}
                    {book.latestAudio && <span>Audio ready</span>}
                  </div>
                </div>

                <div className={styles.cardActions}>
                  {confirmDeleteId === book.id ? (
                    <div className={styles.confirmRow}>
                      <span>Remove this book?</span>
                      <button
                        className="button button--secondary"
                        disabled={isDeleting}
                        onClick={() => void deleteMutation.mutateAsync(book.id)}
                        type="button"
                      >
                        {isDeleting ? 'Removing…' : 'Yes, remove'}
                      </button>
                      <button className="button button--secondary" onClick={() => setConfirmDeleteId(null)} type="button">
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <>
                      <Link className="button button--primary" to={`/book/${book.id}`}>
                        {pct > 0 ? 'Continue reading' : 'Open book'}
                      </Link>
                      <button
                        className={`button button--secondary ${styles.deleteBtn}`}
                        onClick={() => setConfirmDeleteId(book.id)}
                        type="button"
                      >
                        ✕
                      </button>
                    </>
                  )}
                </div>
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}
