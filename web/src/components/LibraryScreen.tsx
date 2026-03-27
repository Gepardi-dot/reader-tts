import { useDeferredValue, useMemo, useRef, useState } from 'react'
import type { Book, ReadingProgress } from '../types'
import { BookCard } from './BookCard'
import { LibrarySection } from './LibrarySection'
import { LibraryToolbar } from './LibraryToolbar'
import './library.css'

type LibraryScreenProps = {
  books: Book[]
  readingProgress: Record<string, ReadingProgress>
  loading: boolean
  uploading: boolean
  deletingBookId: string | null
  statusMessage: string
  errorMessage: string
  onUploadFile: (file: File, title?: string | null) => Promise<Book | null>
  onOpenBook: (bookId: string) => void
  onDeleteBook: (book: Book) => Promise<void>
}

type LibrarySortKey = 'recent' | 'title' | 'pages' | 'progress'
type ReadingStateFilter = 'all' | 'in-progress' | 'not-started' | 'finished'
type AudioStateFilter = 'all' | 'ready' | 'not-ready'
type BookReadingState = Exclude<ReadingStateFilter, 'all'>

type LibraryEntry = {
  book: Book
  progress: ReadingProgress | null
  progressPercent: number
  readingState: BookReadingState
}

const RECENT_WINDOW_MS = 1000 * 60 * 60 * 24 * 30

function getBookReadingState(progress: ReadingProgress | null): BookReadingState {
  if (!progress) {
    return 'not-started'
  }

  if (progress.pageNumber >= progress.totalPages) {
    return 'finished'
  }

  return 'in-progress'
}

function getProgressPercent(progress: ReadingProgress | null) {
  if (!progress || progress.totalPages <= 0) {
    return 0
  }

  return Math.max(0, Math.min(100, Math.round((progress.pageNumber / progress.totalPages) * 100)))
}

function isRecentUpload(uploadedAt: string) {
  const parsed = Date.parse(uploadedAt)
  if (!Number.isFinite(parsed)) {
    return false
  }

  return Date.now() - parsed <= RECENT_WINDOW_MS
}

function trimExcerpt(excerpt: string, fallback: string, limit: number) {
  const normalized = (excerpt || fallback).replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return ''
  }

  if (normalized.length <= limit) {
    return normalized
  }

  return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`
}

function matchesSearch(book: Book, query: string) {
  if (!query) {
    return true
  }

  const haystack = [
    book.title,
    book.fileName,
    book.excerpt,
  ]
    .join(' ')
    .toLocaleLowerCase()

  return haystack.includes(query)
}

function compareProgress(left: LibraryEntry, right: LibraryEntry) {
  const leftUpdated = left.progress?.updatedAt ?? ''
  const rightUpdated = right.progress?.updatedAt ?? ''
  const updatedComparison = rightUpdated.localeCompare(leftUpdated)
  if (updatedComparison !== 0) {
    return updatedComparison
  }

  return right.progressPercent - left.progressPercent
}

function sortEntries(entries: LibraryEntry[], sortKey: LibrarySortKey) {
  const next = [...entries]

  if (sortKey === 'title') {
    next.sort((left, right) => left.book.title.localeCompare(right.book.title, undefined, { sensitivity: 'base' }))
    return next
  }

  if (sortKey === 'pages') {
    next.sort((left, right) => right.book.pageCount - left.book.pageCount || left.book.title.localeCompare(right.book.title))
    return next
  }

  if (sortKey === 'progress') {
    next.sort((left, right) => compareProgress(left, right) || right.book.uploadedAt.localeCompare(left.book.uploadedAt))
    return next
  }

  next.sort((left, right) => right.book.uploadedAt.localeCompare(left.book.uploadedAt))
  return next
}

function isPdfFile(file: File) {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
}

function suggestedTitleFromFileName(fileName: string) {
  const normalized = fileName.replace(/\.pdf$/i, '').trim()
  return normalized || fileName.trim()
}

export function LibraryScreen({
  books,
  readingProgress,
  loading,
  uploading,
  deletingBookId,
  statusMessage,
  errorMessage,
  onUploadFile,
  onOpenBook,
  onDeleteBook,
}: LibraryScreenProps) {
  const [searchQuery, setSearchQuery] = useState('')
  const [sortKey, setSortKey] = useState<LibrarySortKey>('recent')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [readingState, setReadingState] = useState<ReadingStateFilter>('all')
  const [audioState, setAudioState] = useState<AudioStateFilter>('all')
  const [recentOnly, setRecentOnly] = useState(false)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [uploadTitle, setUploadTitle] = useState('')
  const [fileError, setFileError] = useState('')

  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const deferredQuery = useDeferredValue(searchQuery.trim().toLocaleLowerCase())

  const libraryEntries = useMemo(
    () =>
      books.map((book) => {
        const progress = readingProgress[book.id] ?? null
        return {
          book,
          progress,
          progressPercent: getProgressPercent(progress),
          readingState: getBookReadingState(progress),
        } satisfies LibraryEntry
      }),
    [books, readingProgress],
  )

  const filteredEntries = useMemo(
    () =>
      libraryEntries.filter((entry) => {
        if (!matchesSearch(entry.book, deferredQuery)) {
          return false
        }

        if (readingState !== 'all' && entry.readingState !== readingState) {
          return false
        }

        if (audioState === 'ready' && !entry.book.latestAudio) {
          return false
        }

        if (audioState === 'not-ready' && entry.book.latestAudio) {
          return false
        }

        if (recentOnly && !isRecentUpload(entry.book.uploadedAt)) {
          return false
        }

        return true
      }),
    [audioState, deferredQuery, libraryEntries, readingState, recentOnly],
  )

  const sortedEntries = useMemo(
    () => sortEntries(filteredEntries, sortKey),
    [filteredEntries, sortKey],
  )

  const hasActiveFilters =
    deferredQuery.length > 0 ||
    readingState !== 'all' ||
    audioState !== 'all' ||
    recentOnly

  const activeFilterCount =
    Number(readingState !== 'all') +
    Number(audioState !== 'all') +
    Number(recentOnly)
  const activeStatusMessage = uploading ? statusMessage : ''
  const showColdStartState = loading && !books.length && !sortedEntries.length && !errorMessage

  function clearDiscovery() {
    setSearchQuery('')
    setFiltersOpen(false)
    setReadingState('all')
    setAudioState('all')
    setRecentOnly(false)
  }

  function openFilePicker() {
    fileInputRef.current?.click()
  }

  function handleFileSelected(file: File | null) {
    if (!file) {
      return
    }

    if (!isPdfFile(file)) {
      setFileError('Choose a PDF file before importing.')
      return
    }

    setFileError('')
    setSelectedFile(file)
    setUploadTitle(suggestedTitleFromFileName(file.name))
  }

  async function handleUpload() {
    if (!selectedFile) {
      setFileError('Choose a PDF file first.')
      return
    }

    const uploaded = await onUploadFile(selectedFile, uploadTitle)
    if (uploaded) {
      setSelectedFile(null)
      setUploadTitle('')
      setFileError('')
    }
  }

  return (
    <section className="editorial-library">
      <LibraryToolbar
        activeFilterCount={activeFilterCount}
        audioState={audioState}
        filteredCount={sortedEntries.length}
        filtersOpen={filtersOpen}
        hasActiveFilters={hasActiveFilters}
        onAudioStateChange={setAudioState}
        onClearFilters={clearDiscovery}
        onReadingStateChange={setReadingState}
        onRecentOnlyChange={setRecentOnly}
        onSearchChange={setSearchQuery}
        onSortChange={setSortKey}
        onToggleFilters={() => setFiltersOpen((current) => !current)}
        readingState={readingState}
        recentOnly={recentOnly}
        searchInputRef={searchInputRef}
        searchQuery={searchQuery}
        sortKey={sortKey}
        totalCount={books.length}
      />

      {activeStatusMessage ? <div className="library-notice library-notice--progress">{activeStatusMessage}</div> : null}
      {errorMessage ? <div className="library-notice library-notice--error">{errorMessage}</div> : null}

      <LibrarySection
        count={sortedEntries.length}
        delay={80}
        description="One shelf for your full collection."
        eyebrow="Books"
        title="Library"
      >
        <div className="library-section__actions">
          <input
            accept=".pdf,application/pdf"
            className="library-upload-input"
            onChange={(event) => {
              handleFileSelected(event.target.files?.item(0) ?? null)
              event.target.value = ''
            }}
            ref={fileInputRef}
            type="file"
          />
          {selectedFile ? (
            <div className="library-upload-inline">
              <span className="library-upload-inline__file">
                {trimExcerpt(selectedFile.name, selectedFile.name, 44)}
              </span>
              <label className="library-upload-inline__title">
                <span className="library-upload-inline__title-label">Title</span>
                <input
                  autoComplete="off"
                  className="library-upload-inline__title-input"
                  disabled={uploading}
                  maxLength={180}
                  onChange={(event) => setUploadTitle(event.target.value)}
                  placeholder={suggestedTitleFromFileName(selectedFile.name)}
                  type="text"
                  value={uploadTitle}
                />
              </label>
              <button
                className="primary-button"
                disabled={uploading}
                onClick={() => void handleUpload()}
                type="button"
              >
                {uploading ? 'Uploading...' : 'Upload book'}
              </button>
              <button
                className="secondary-button secondary-button--compact"
                disabled={uploading}
                onClick={() => {
                  setSelectedFile(null)
                  setUploadTitle('')
                  setFileError('')
                }}
                type="button"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button className="primary-button" onClick={openFilePicker} type="button">
              Upload book
            </button>
          )}
          {fileError ? <p className="library-upload-inline__error">{fileError}</p> : null}
        </div>

        {sortedEntries.length ? (
          <div className="library-book-grid">
            {sortedEntries.map((entry) => (
              <BookCard
                book={entry.book}
                deleting={deletingBookId === entry.book.id}
                key={entry.book.id}
                onDelete={() => onDeleteBook(entry.book)}
                onOpen={() => onOpenBook(entry.book.id)}
                progress={entry.progress}
              />
            ))}
          </div>
        ) : (
          <div className="library-section__empty">
            <strong>
              {showColdStartState
                ? 'Waking up your library…'
                : books.length
                  ? 'No books match the current view.'
                  : 'No books on the shelf yet.'}
            </strong>
            <p>
              {showColdStartState
                ? 'The hosted app can take a few seconds on a cold start. Your shelf will appear automatically as soon as the reader API responds.'
                : books.length
                  ? 'Clear the search or filters to see more books.'
                  : 'Upload a PDF to start building your library.'}
            </p>
            {books.length && hasActiveFilters && !showColdStartState ? (
              <button className="secondary-button secondary-button--compact" onClick={clearDiscovery} type="button">
                Clear search and filters
              </button>
            ) : null}
          </div>
        )}
      </LibrarySection>
    </section>
  )
}
