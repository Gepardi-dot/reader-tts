import type { Highlight } from '../types'

type HighlightsShelfProps = {
  highlights: Highlight[]
  onDelete: (highlightId: string) => Promise<void>
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

export function HighlightsShelf({ highlights, onDelete, removingId }: HighlightsShelfProps) {
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
      {highlights.map((item) => (
        <article className="highlight-card" key={item.id}>
          <div className="highlight-card__header">
            <span className={colorClass(item.color)}>{colorLabel(item.color)}</span>
            <small>{formatDate(item.createdAt)}</small>
          </div>
          <blockquote>{item.text}</blockquote>
          {item.note ? <p className="highlight-card__note">{item.note}</p> : null}
          <div className="highlight-card__footer">
            <small>
              Characters {item.start}-{item.end}
            </small>
            <button
              className="secondary-button secondary-button--compact"
              disabled={removingId === item.id}
              onClick={() => void onDelete(item.id)}
              type="button"
            >
              {removingId === item.id ? 'Removing...' : 'Remove'}
            </button>
          </div>
        </article>
      ))}
    </div>
  )
}
