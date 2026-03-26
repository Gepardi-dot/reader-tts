import type { Highlight } from '../types'
import type { ReaderPage } from './readerPagination'

export type HighlightLocation = {
  startPageNumber: number
  endPageNumber: number
  lineNumber: number
  label: string
  title: string
}

function findPageNumberForOffset(offset: number, pages: ReaderPage[]) {
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index]
    if (offset >= page.start && offset < page.end) {
      return index + 1
    }
  }

  return pages.length
}

function findPageForNumber(pageNumber: number, pages: ReaderPage[]) {
  return pages[Math.max(0, Math.min(pages.length - 1, pageNumber - 1))] ?? null
}

function countLineNumber(text: string, page: ReaderPage, offset: number) {
  const safeOffset = Math.max(page.start, Math.min(offset, page.end))
  const before = text.slice(page.start, safeOffset)
  const lines = before.split(/\n+/).filter((line) => line.trim().length > 0)
  return Math.max(1, lines.length || 1)
}

function buildLocationLabel(startPageNumber: number, endPageNumber: number) {
  return startPageNumber === endPageNumber ? `Pg ${startPageNumber}` : `Pg ${startPageNumber}-${endPageNumber}`
}

export function buildHighlightLocations(text: string, pages: ReaderPage[], highlights: Highlight[]) {
  if (!text.trim() || !pages.length || !highlights.length) {
    return {}
  }

  return Object.fromEntries(
    highlights.map((highlight) => {
      const safeEndOffset = Math.max(highlight.start, highlight.end - 1)
      const startPageNumber = findPageNumberForOffset(highlight.start, pages)
      const endPageNumber = findPageNumberForOffset(safeEndOffset, pages)
      const startPage = findPageForNumber(startPageNumber, pages)
      const lineNumber = startPage ? countLineNumber(text, startPage, highlight.start) : 1
      const label = buildLocationLabel(startPageNumber, endPageNumber)
      const title =
        startPageNumber === endPageNumber
          ? `Jump to page ${startPageNumber}, line ${lineNumber}`
          : `Jump to page ${startPageNumber}, line ${lineNumber}`

      return [
        highlight.id,
        {
          startPageNumber,
          endPageNumber,
          lineNumber,
          label,
          title,
        } satisfies HighlightLocation,
      ]
    }),
  )
}
