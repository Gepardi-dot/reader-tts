import { useEffect, useRef, useState } from 'react'
import { LibraryCover } from './LibraryCover'
import type { Book, ReadingProgress } from '../types'

type BookCardProps = {
  book: Book
  progress: ReadingProgress | null
  deleting: boolean
  onOpen: () => void
  onDelete: () => void | Promise<void>
}

function formatShortDate(iso: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(iso))
}

function trimExcerpt(excerpt: string, limit: number) {
  const normalized = excerpt.replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return ''
  }

  if (normalized.length <= limit) {
    return normalized
  }

  return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`
}

function progressPercent(progress: ReadingProgress | null) {
  if (!progress || progress.totalPages <= 0) {
    return 0
  }

  return Math.max(0, Math.min(100, Math.round((progress.pageNumber / progress.totalPages) * 100)))
}

export function BookCard({ book, progress, deleting, onOpen, onDelete }: BookCardProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!menuOpen) {
      return
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false)
      }
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false)
      }
    }

    window.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [menuOpen])

  const completion = progressPercent(progress)
  const canContinue = Boolean(progress && progress.pageNumber > 1 && progress.pageNumber < progress.totalPages)
  const readingLabel = progress
    ? progress.pageNumber >= progress.totalPages
      ? 'Finished'
      : `Page ${progress.pageNumber} of ${progress.totalPages}`
    : 'Not started'

  const supportingText =
    trimExcerpt(book.excerpt, 132) || book.fileName.replace(/\.pdf$/i, '')

  async function handleDeleteClick() {
    setMenuOpen(false)
    await onDelete()
  }

  return (
    <article className="library-book-card">
      <div className="library-book-card__media">
        <button
          aria-label={`Open ${book.title}`}
          className="library-book-card__cover"
          disabled={deleting}
          onClick={onOpen}
          type="button"
        >
          <LibraryCover sourceUrl={book.sourceUrl} title={book.title} />
        </button>

        <div className="library-book-card__menu" ref={menuRef}>
          <button
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            aria-label={`More actions for ${book.title}`}
            className="library-book-card__menu-toggle"
            disabled={deleting}
            onClick={() => setMenuOpen((current) => !current)}
            type="button"
          >
            <span />
            <span />
            <span />
          </button>

          {menuOpen ? (
            <div className="library-book-card__menu-popover" role="menu">
              <button onClick={onOpen} role="menuitem" type="button">
                Open book
              </button>
              {canContinue ? (
                <button onClick={onOpen} role="menuitem" type="button">
                  Continue reading
                </button>
              ) : null}
              <button
                className="library-book-card__menu-danger"
                disabled={deleting}
                onClick={() => void handleDeleteClick()}
                role="menuitem"
                type="button"
              >
                {deleting ? 'Removing...' : 'Remove from library'}
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <div className="library-book-card__meta">
        <p className="library-book-card__date">Added {formatShortDate(book.uploadedAt)}</p>
        <h3>{book.title}</h3>
        <p className="library-book-card__excerpt">{supportingText}</p>

        <div className="library-book-card__chips">
          <span className="library-book-card__chip">{book.pageCount} pages</span>
          <span className="library-book-card__chip">{readingLabel}</span>
          {book.latestAudio ? <span className="library-book-card__chip ok">Audio ready</span> : null}
        </div>

        <div className="library-book-card__footer">
          <button
            className="secondary-button secondary-button--compact"
            disabled={deleting}
            onClick={onOpen}
            type="button"
          >
            {canContinue ? 'Continue reading' : progress ? 'Open again' : 'Start reading'}
          </button>
          <span className="library-book-card__progress">
            {progress ? `${completion}% read` : 'New arrival'}
          </span>
        </div>
      </div>
    </article>
  )
}
