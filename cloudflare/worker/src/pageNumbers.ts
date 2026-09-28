/**
 * Printed page furniture left in extracted book text.
 * Keep in sync with web-next/src/shared/books/pageNumbers.ts and
 * server/page_numbers.py.
 */

const PAGE_LABEL = /^(?:page|pg|p)\.?\s*\d{1,4}(?:\s*(?:of|\/)\s*\d{1,4})?$/i
const PAGE_FRACTION = /^\d{1,4}\s*(?:\/|of)\s*\d{1,4}$/i
const DECORATED = /^[-–—~*•.]+\s*\d{1,4}\s*[-–—~*•.]+$/
const BRACKETED = /^(?:\[|\()\s*\d{1,4}\s*(?:\]|\))$/
const BARE = /^(\d{1,4})[.)]?$/
const TRAILING_PAGE = /^(.*[.!?])(["'”’)]*)\s+(\d{1,4})\s*$/
const TRAILING_ABBREV = /\b(?:Mr|Mrs|Ms|Dr|St|Prof|Jr|Sr|vs|etc|fig|vol|no|pp|p|ch|sec|ed|rev|gen|cf)\.$/i

function proseWithoutTrailingPageNumber(line: string): string | null {
  const match = TRAILING_PAGE.exec(line)
  if (!match) return null
  const value = Number(match[3])
  if (value >= 1000 && value <= 2099) return null
  const prose = `${match[1] ?? ''}${match[2] ?? ''}`
  if (!prose.trim() || TRAILING_ABBREV.test(prose)) return null
  return prose
}

export function isPageNumberLine(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed) return false
  if (PAGE_LABEL.test(trimmed) || PAGE_FRACTION.test(trimmed) || DECORATED.test(trimmed)) return true
  if (BRACKETED.test(trimmed)) return true
  const bare = BARE.exec(trimmed)
  if (!bare) return false
  const value = Number(bare[1])
  if (value >= 1000 && value <= 2099) return false
  return true
}

/** Returns the original string when nothing was removed, so cache keys stay stable. */
export function speechTextWithoutPageNumbers(text: string): string {
  if (!text) return text
  const lines = text.split('\n')
  let removed = false
  const kept: string[] = []
  for (const line of lines) {
    if (isPageNumberLine(line)) {
      removed = true
      continue
    }
    const prose = proseWithoutTrailingPageNumber(line)
    if (prose != null) {
      removed = true
      if (prose) kept.push(prose)
      continue
    }
    kept.push(line)
  }
  if (!removed) return text
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}
