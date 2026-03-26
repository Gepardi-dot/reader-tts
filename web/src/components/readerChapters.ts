import type { ReaderPage } from './readerPagination'

export type ReaderChapter = {
  id: string
  title: string
  pageNumber: number
  start: number
}

const EXPLICIT_HEADING_PATTERNS = [
  /^(chapter|part|section|book)\b[\s\S]*$/i,
  /^(prologue|epilogue|preface|foreword|afterword|introduction|conclusion)\b[\s\S]*$/i,
  /^(appendix|appendices)\b[\s\S]*$/i,
  /^(chapter|part|section)\s+[ivxlcdm0-9]+(?:\b|[:.-].*)$/i,
  /^\d{1,2}[.)]\s+[A-Z][\s\S]*$/,
]

function findPageNumberForOffset(offset: number, pages: ReaderPage[]) {
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index]
    if (offset >= page.start && offset < page.end) {
      return index + 1
    }
  }

  return pages.length
}

function cleanHeading(value: string) {
  return value.replace(/\s+/g, ' ').split('\u0000').join('').trim()
}

function isMostlyTitleCase(value: string) {
  const words = value.split(/\s+/).filter(Boolean)
  if (!words.length) {
    return false
  }

  let titleCaseWords = 0
  for (const word of words) {
    const trimmed = word.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '')
    if (!trimmed) {
      continue
    }
    if (/^[IVXLCDM0-9]+$/i.test(trimmed) || /^[A-Z][A-Za-z0-9'’-]*$/.test(trimmed)) {
      titleCaseWords += 1
    }
  }

  return titleCaseWords / words.length >= 0.7
}

function isPotentialHeading(line: string, previousBlank: boolean, nextBlank: boolean) {
  const cleaned = cleanHeading(line)
  if (!cleaned || cleaned.length < 3 || cleaned.length > 90) {
    return false
  }

  if (EXPLICIT_HEADING_PATTERNS.some((pattern) => pattern.test(cleaned))) {
    return true
  }

  if (!previousBlank || !nextBlank) {
    return false
  }

  if (/[.!?]$/.test(cleaned) || cleaned.split(/\s+/).length > 10) {
    return false
  }

  return isMostlyTitleCase(cleaned)
}

function buildFallbackChapters(pages: ReaderPage[]) {
  if (!pages.length) {
    return []
  }

  const step = Math.max(6, Math.round(pages.length / 8))
  const items: ReaderChapter[] = []

  for (let index = 0; index < pages.length; index += step) {
    const page = pages[index]
    const snippet = cleanHeading(page.text.split(/\n+/).find((line) => cleanHeading(line)) ?? '')
    const title = snippet ? snippet.slice(0, 64) : `Page ${index + 1}`

    items.push({
      id: `page-${index + 1}`,
      title,
      pageNumber: index + 1,
      start: page.start,
    })
  }

  if (!items.some((item) => item.pageNumber === 1)) {
    items.unshift({
      id: 'page-1',
      title: 'Start',
      pageNumber: 1,
      start: pages[0]?.start ?? 0,
    })
  }

  return items
}

export function extractReaderChapters(text: string, pages: ReaderPage[]) {
  if (!text.trim() || !pages.length) {
    return []
  }

  const rawLines = text.split('\n')
  const items: ReaderChapter[] = []
  let cursor = 0

  for (let index = 0; index < rawLines.length; index += 1) {
    const rawLine = rawLines[index] ?? ''
    const cleaned = cleanHeading(rawLine)
    const previousBlank = index === 0 || !cleanHeading(rawLines[index - 1] ?? '')
    const nextBlank = index === rawLines.length - 1 || !cleanHeading(rawLines[index + 1] ?? '')

    if (isPotentialHeading(cleaned, previousBlank, nextBlank)) {
      const pageNumber = findPageNumberForOffset(cursor, pages)
      const previous = items[items.length - 1]
      if (!previous || previous.pageNumber !== pageNumber || previous.title.toLowerCase() !== cleaned.toLowerCase()) {
        items.push({
          id: `${pageNumber}-${cursor}`,
          title: cleaned,
          pageNumber,
          start: cursor,
        })
      }
    }

    cursor += rawLine.length + 1
  }

  return items.length >= 2 ? items : buildFallbackChapters(pages)
}
