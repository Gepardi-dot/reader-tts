import type { RefObject } from 'react'

type LibraryToolbarProps = {
  searchQuery: string
  searchInputRef: RefObject<HTMLInputElement | null>
  sortKey: 'recent' | 'title' | 'pages' | 'progress'
  readingState: 'all' | 'in-progress' | 'not-started' | 'finished'
  audioState: 'all' | 'ready' | 'not-ready'
  recentOnly: boolean
  filtersOpen: boolean
  hasActiveFilters: boolean
  activeFilterCount: number
  filteredCount: number
  totalCount: number
  onSearchChange: (value: string) => void
  onSortChange: (value: 'recent' | 'title' | 'pages' | 'progress') => void
  onToggleFilters: () => void
  onReadingStateChange: (value: 'all' | 'in-progress' | 'not-started' | 'finished') => void
  onAudioStateChange: (value: 'all' | 'ready' | 'not-ready') => void
  onRecentOnlyChange: (value: boolean) => void
  onClearFilters: () => void
}

export function LibraryToolbar({
  searchQuery,
  searchInputRef,
  sortKey,
  readingState,
  audioState,
  recentOnly,
  filtersOpen,
  hasActiveFilters,
  activeFilterCount,
  filteredCount,
  totalCount,
  onSearchChange,
  onSortChange,
  onToggleFilters,
  onReadingStateChange,
  onAudioStateChange,
  onRecentOnlyChange,
  onClearFilters,
}: LibraryToolbarProps) {
  const resultLabel =
    filteredCount === totalCount
      ? `${totalCount} ${totalCount === 1 ? 'book' : 'books'}`
      : `${filteredCount} of ${totalCount} books shown`

  return (
    <header className="library-toolbar">
      <div className="library-toolbar__brand">
        <div className="library-toolbar__mark" aria-hidden="true">
          <span />
          <span />
        </div>
        <div className="library-toolbar__brand-copy">
          <p className="eyebrow">Personal Reading Room</p>
          <h1>Storybook Reader</h1>
          <p className="library-toolbar__summary">{resultLabel}</p>
        </div>
      </div>

      <div className="library-toolbar__controls">
        <div className="library-toolbar__search is-open">
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <circle cx="11" cy="11" r="6.5" />
            <path d="M16 16l4.5 4.5" />
          </svg>
          <input
            aria-label="Search books"
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search books"
            ref={searchInputRef}
            type="search"
            value={searchQuery}
          />
        </div>

        <label className="library-toolbar__sort">
          <span>Sort</span>
          <select
            aria-label="Sort books"
            onChange={(event) => onSortChange(event.target.value as 'recent' | 'title' | 'pages' | 'progress')}
            value={sortKey}
          >
            <option value="recent">Recently added</option>
            <option value="title">Title</option>
            <option value="pages">Page count</option>
            <option value="progress">Reading progress</option>
          </select>
        </label>

        <button
          aria-expanded={filtersOpen}
          className={`library-toolbar__icon-button ${filtersOpen ? 'is-active' : ''}`}
          onClick={onToggleFilters}
          type="button"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="M4 6h16l-6.5 7.5V19l-3 1v-6.5z" />
          </svg>
          <span>Filters</span>
          {activeFilterCount ? <strong>{activeFilterCount}</strong> : null}
        </button>
      </div>

      {filtersOpen ? (
        <div className="library-toolbar__filters">
          <label>
            <span>Reading state</span>
            <select
              onChange={(event) =>
                onReadingStateChange(event.target.value as LibraryToolbarProps['readingState'])
              }
              value={readingState}
            >
              <option value="all">All books</option>
              <option value="in-progress">In progress</option>
              <option value="not-started">Not started</option>
              <option value="finished">Finished</option>
            </select>
          </label>

          <label>
            <span>Audio state</span>
            <select
              onChange={(event) =>
                onAudioStateChange(event.target.value as LibraryToolbarProps['audioState'])
              }
              value={audioState}
            >
              <option value="all">All books</option>
              <option value="ready">Audio ready</option>
              <option value="not-ready">No audio yet</option>
            </select>
          </label>

          <label className="library-toolbar__checkbox">
            <input
              checked={recentOnly}
              onChange={(event) => onRecentOnlyChange(event.target.checked)}
              type="checkbox"
            />
            <span>Only show recent uploads from the last 30 days</span>
          </label>

          {hasActiveFilters ? (
            <button className="secondary-button secondary-button--compact" onClick={onClearFilters} type="button">
              Clear filters
            </button>
          ) : null}
        </div>
      ) : null}
    </header>
  )
}
