import { useEffect, useState } from 'react'
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

  const lastVisiblePage = compact ? pageCount : Math.max(1, pageCount - 1)
  const nextPage = Math.min(pageNumber + 1, pageCount)

  return (
    <div className="book-stage">
      <div className="book-stage__desk" />
      <div className="book-stage__meta">
        <div>
          <strong>{title}</strong>
          <p>
            Page {pageNumber}
            {!compact ? `-${nextPage}` : ''} of {pageCount}
          </p>
        </div>

        <div className="book-stage__actions">
          <button
            disabled={pageNumber <= 1}
            onClick={() => setPageNumber((current) => Math.max(1, current - (compact ? 1 : 2)))}
            type="button"
          >
            Previous
          </button>
          <button
            disabled={pageNumber >= lastVisiblePage}
            onClick={() =>
              setPageNumber((current) => Math.min(lastVisiblePage, current + (compact ? 1 : 2)))
            }
            type="button"
          >
            Next
          </button>
        </div>
      </div>

      <Document file={sourceUrl} onLoadError={(error) => setDocumentError(error.message)}>
        <div className={`page-spread ${compact ? 'compact' : ''}`}>
          <div className="paper-sheet">
            <Page pageNumber={pageNumber} renderTextLayer width={compact ? 310 : 360} />
          </div>
          {!compact ? (
            <div className="paper-sheet right">
              <Page pageNumber={nextPage} renderTextLayer width={360} />
            </div>
          ) : null}
        </div>
      </Document>

      {documentError ? <p className="error-line">{documentError}</p> : null}
    </div>
  )
}
