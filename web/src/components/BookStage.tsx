import { useEffect, useRef, useState } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

type BookStageProps = {
  sourceUrl: string
  pageCount: number
  title: string
}

type PdfViewMode = 'spread' | 'single'

const ZOOM_OPTIONS = [90, 100, 115, 130, 145]

function clampPage(nextPage: number, lastPage: number) {
  return Math.min(Math.max(1, nextPage), Math.max(1, lastPage))
}

function useCompactLayout() {
  const [compact, setCompact] = useState(window.innerWidth < 920)

  useEffect(() => {
    const media = window.matchMedia('(max-width: 920px)')
    const listener = (event: MediaQueryListEvent) => setCompact(event.matches)
    media.addEventListener('change', listener)
    return () => media.removeEventListener('change', listener)
  }, [])

  return compact
}

export function BookStage({ sourceUrl, pageCount, title }: BookStageProps) {
  const compact = useCompactLayout()
  const [pageNumber, setPageNumber] = useState(1)
  const [documentError, setDocumentError] = useState<string>('')
  const [documentPages, setDocumentPages] = useState(pageCount)
  const [viewMode, setViewMode] = useState<PdfViewMode>('spread')
  const [zoom, setZoom] = useState(115)
  const [workspaceWidth, setWorkspaceWidth] = useState(0)
  const workspaceRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!workspaceRef.current) {
      return
    }

    const node = workspaceRef.current
    setWorkspaceWidth(node.clientWidth)

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) {
        setWorkspaceWidth(entry.contentRect.width)
      }
    })

    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const totalPages = Math.max(1, documentPages || pageCount)
  const activeViewMode = compact ? 'single' : viewMode
  const canRenderSpread = activeViewMode === 'spread' && totalPages > 1
  const visiblePages = canRenderSpread ? 2 : 1
  const lastVisiblePage = canRenderSpread ? Math.max(1, totalPages - 1) : Math.max(1, totalPages)
  const safePageNumber = clampPage(pageNumber, lastVisiblePage)
  const nextPage = canRenderSpread ? Math.min(safePageNumber + 1, totalPages) : safePageNumber
  const pageLabel =
    canRenderSpread && nextPage !== safePageNumber
      ? `Page ${safePageNumber}-${nextPage} of ${totalPages}`
      : `Page ${safePageNumber} of ${totalPages}`

  const fittedWidth = (() => {
    const currentWidth = workspaceWidth || (compact ? 360 : 1040)
    const outerPadding = canRenderSpread ? 116 : 96
    const gutter = canRenderSpread ? 28 : 0
    const perPage = (currentWidth - outerPadding - gutter) / visiblePages
    const minWidth = canRenderSpread ? 250 : 300
    const maxWidth = canRenderSpread ? 520 : 940
    return Math.max(minWidth, Math.min(maxWidth, perPage))
  })()

  const renderedPageWidth = Math.round(fittedWidth * (zoom / 100))
  const step = canRenderSpread ? 2 : 1

  return (
    <div className="book-stage">
      <div className="book-stage__surface">
        <div className="book-stage__toolbar">
          <div className="book-stage__identity">
            <span className="book-stage__eyebrow">Original PDF</span>
            <strong>{title}</strong>
            <p>Use this tab for the real page layout, cover art, and quick page-faithful checks.</p>
          </div>

          <div className="book-stage__summary">
            <span className="book-stage__summary-label">View</span>
            <strong>{pageLabel}</strong>
            <p>{canRenderSpread ? 'Two-page spread' : 'Single-page focus'}</p>
          </div>
        </div>

        <div className="book-stage__controls">
          <div className="book-stage__nav">
            <button
              className="book-stage__button"
              disabled={safePageNumber <= 1}
              onClick={() => setPageNumber((current) => clampPage(current - step, lastVisiblePage))}
              type="button"
            >
              Previous
            </button>

            <label className="book-stage__page-field">
              <span>Page</span>
              <input
                aria-label="Current page"
                max={lastVisiblePage}
                min={1}
                onChange={(event) => {
                  const requestedPage = Number.parseInt(event.target.value, 10)
                  if (Number.isNaN(requestedPage)) {
                    return
                  }
                  setPageNumber(clampPage(requestedPage, lastVisiblePage))
                }}
                type="number"
                value={safePageNumber}
              />
              <span className="book-stage__page-total">of {totalPages}</span>
            </label>

            <button
              className="book-stage__button"
              disabled={safePageNumber >= lastVisiblePage}
              onClick={() => setPageNumber((current) => clampPage(current + step, lastVisiblePage))}
              type="button"
            >
              Next
            </button>
          </div>

          <div className="book-stage__tools">
            {!compact ? (
              <div className="book-stage__segmented" role="tablist" aria-label="PDF layout">
                <button
                  aria-pressed={activeViewMode === 'spread'}
                  className={activeViewMode === 'spread' ? 'active' : ''}
                  onClick={() => setViewMode('spread')}
                  type="button"
                >
                  Spread
                </button>
                <button
                  aria-pressed={activeViewMode === 'single'}
                  className={activeViewMode === 'single' ? 'active' : ''}
                  onClick={() => setViewMode('single')}
                  type="button"
                >
                  Single
                </button>
              </div>
            ) : null}

            <label className="book-stage__select-field">
              <span>Zoom</span>
              <select
                aria-label="Zoom level"
                onChange={(event) => setZoom(Number.parseInt(event.target.value, 10))}
                value={zoom}
              >
                {ZOOM_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}%
                  </option>
                ))}
              </select>
            </label>

            <a className="book-stage__open-link" href={sourceUrl} rel="noreferrer" target="_blank">
              Open original PDF
            </a>
          </div>
        </div>

        <div className="book-stage__workspace" ref={workspaceRef}>
          <Document
            error={<p className="error-line">This PDF could not be loaded.</p>}
            file={sourceUrl}
            loading={<div className="book-stage__loading">Loading pages…</div>}
            onLoadError={(error) => setDocumentError(error.message)}
            onLoadSuccess={({ numPages }) => {
              setDocumentError('')
              setDocumentPages(numPages)
            }}
          >
            <div
              className={`page-spread ${compact ? 'compact' : ''} ${
                activeViewMode === 'single' ? 'page-spread--single' : ''
              }`}
            >
              <div className="paper-sheet">
                <Page pageNumber={pageNumber} renderTextLayer width={renderedPageWidth} />
              </div>

              {canRenderSpread ? (
                <div className="paper-sheet right">
                  <Page pageNumber={nextPage} renderTextLayer width={renderedPageWidth} />
                </div>
              ) : null}
            </div>
          </Document>
        </div>
      </div>

      {documentError ? <p className="error-line">{documentError}</p> : null}
    </div>
  )
}
