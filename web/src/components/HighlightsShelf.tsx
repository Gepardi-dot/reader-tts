import type { Highlight } from '../types'
import type { HighlightLocation } from './highlightLocations'

type HighlightsShelfProps = {
  highlights: Highlight[]
  highlightLocations?: Record<string, HighlightLocation>
  onDelete: (highlightId: string) => Promise<void>
  onJumpToHighlight?: (highlight: Highlight) => void
  removingId: string | null
}

function formatDate(iso: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(iso))
}

function colorLabel(color: Highlight['color']) {
  if (color === 'rose') {
    return 'Rose'
  }
  if (color === 'sky') {
    return 'Sky'
  }
  return 'Amber'
}

function colorClass(color: Highlight['color']) {
  if (color === 'rose') {
    return 'highlight-chip rose'
  }
  if (color === 'sky') {
    return 'highlight-chip sky'
  }
  return 'highlight-chip amber'
}

function contentClass(item: Highlight) {
  const noteLength = item.note?.trim().length ?? 0
  const weight = item.text.trim().length + Math.round(noteLength * 0.8)

  if (weight <= 90 && noteLength === 0) {
    return 'highlight-card--micro'
  }
  if (weight <= 220 && noteLength <= 80) {
    return 'highlight-card--compact'
  }
  return 'highlight-card--expanded'
}

function characterLabel(item: Highlight) {
  const count = Math.max(0, item.end - item.start)
  return `${count} chars / ${item.start}-${item.end}`
}

export function HighlightsShelf({
  highlights,
  highlightLocations = {},
  onDelete,
  onJumpToHighlight,
  removingId,
}: HighlightsShelfProps) {
  if (!highlights.length) {
    return (
      <div className="empty-stage">
        <strong>No highlights yet.</strong>
        <p>Open Reader mode, select a passage, and save it with one of the three colors.</p>
      </div>
    )
  }

  return (
    <div className="highlights-shelf">
      {highlights.map((item) => {
        const location = highlightLocations[item.id]

        return (
          <article className={`highlight-card ${contentClass(item)}`} key={item.id}>
          <div className="highlight-card__header">
            <span className={colorClass(item.color)}>{colorLabel(item.color)}</span>
            <small className="highlight-card__time">{formatDate(item.createdAt)}</small>
          </div>
          <blockquote title={item.text}>{item.text}</blockquote>
          {item.note ? (
            <p className="highlight-card__note" title={item.note}>
              {item.note}
            </p>
          ) : null}
          <div className="highlight-card__footer">
            <div className="highlight-card__meta-row">
              {location && onJumpToHighlight ? (
                <button
                  className="highlight-card__location"
                  onClick={() => onJumpToHighlight(item)}
                  title={location.title}
                  type="button"
                >
                  {location.label}
                </button>
              ) : null}
              <small className="highlight-card__meta">{characterLabel(item)}</small>
            </div>
            <button
              className="secondary-button secondary-button--compact highlight-card__remove"
              disabled={removingId === item.id}
              onClick={() => void onDelete(item.id)}
              type="button"
            >
              {removingId === item.id ? 'Removing...' : 'Remove'}
            </button>
          </div>
          </article>
        )
      })}
    </div>
  )
}
