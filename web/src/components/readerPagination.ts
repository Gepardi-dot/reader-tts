export type ReaderPage = {
  start: number
  end: number
  text: string
}

const PAGE_TARGET_CHARS = 1800
const PAGE_MIN_CHARS = 900
const PAGE_MAX_CHARS = 2400

const PAGE_BREAK_PATTERNS = [/\n{2,}/g, /[.!?]["')\]]*\s+/g, /\n+/g, /\s+/g]

function pushPage(pages: ReaderPage[], text: string, start: number, end: number) {
  if (end <= start) {
    return
  }

  pages.push({
    start,
    end,
    text: text.slice(start, end),
  })
}

function findForwardBreak(text: string, start: number, end: number) {
  const window = text.slice(start, end)

  for (const pattern of PAGE_BREAK_PATTERNS) {
    pattern.lastIndex = 0
    const match = pattern.exec(window)
    if (match) {
      return start + match.index + match[0].length
    }
  }

  return null
}

function findBackwardBreak(text: string, start: number, end: number) {
  const window = text.slice(start, end)

  for (const pattern of PAGE_BREAK_PATTERNS) {
    pattern.lastIndex = 0
    let lastMatch: RegExpExecArray | null = null
    let match = pattern.exec(window)

    while (match) {
      lastMatch = match
      match = pattern.exec(window)
    }

    if (lastMatch) {
      return start + lastMatch.index + lastMatch[0].length
    }
  }

  return null
}

function splitLongSpan(pages: ReaderPage[], text: string, start: number, end: number) {
  let cursor = start

  while (cursor < end) {
    const remaining = end - cursor
    if (remaining <= PAGE_TARGET_CHARS) {
      pushPage(pages, text, cursor, end)
      return
    }

    const minimumBreak = Math.min(end, cursor + PAGE_MIN_CHARS)
    const idealBreak = Math.min(end, cursor + PAGE_TARGET_CHARS)
    const maximumBreak = Math.min(end, cursor + PAGE_MAX_CHARS)
    const forwardBreak = findForwardBreak(text, idealBreak, maximumBreak)
    const backwardBreak = findBackwardBreak(text, minimumBreak, idealBreak)
    const nextBreak =
      forwardBreak ??
      backwardBreak ??
      (maximumBreak > cursor ? maximumBreak : Math.min(end, cursor + PAGE_TARGET_CHARS))

    pushPage(pages, text, cursor, nextBreak)
    cursor = nextBreak
  }
}

export function paginateReaderText(text: string) {
  const pages: ReaderPage[] = []
  const paragraphMatches = [...text.matchAll(/\S[\s\S]*?(?=\n{2,}\S|\s*$)/g)]

  let pageStart: number | null = null
  let pageEnd: number | null = null

  const flush = () => {
    if (pageStart === null || pageEnd === null || pageEnd <= pageStart) {
      return
    }

    if (pageEnd - pageStart > PAGE_MAX_CHARS) {
      splitLongSpan(pages, text, pageStart, pageEnd)
    } else {
      pushPage(pages, text, pageStart, pageEnd)
    }
    pageStart = null
    pageEnd = null
  }

  for (const match of paragraphMatches) {
    const start = match.index ?? 0
    const end = start + match[0].length

    if (pageStart === null || pageEnd === null) {
      pageStart = start
      pageEnd = end
      continue
    }

    if (end - pageStart <= PAGE_TARGET_CHARS) {
      pageEnd = end
      continue
    }

    flush()
    pageStart = start
    pageEnd = end
  }

  flush()

  if (!pages.length && text.trim()) {
    splitLongSpan(pages, text, 0, text.length)
  }

  return pages
}
