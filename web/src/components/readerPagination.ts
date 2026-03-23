export type ReaderPage = {
  start: number
  end: number
  text: string
}

const PAGE_TARGET_CHARS = 1800

export function paginateReaderText(text: string) {
  const pages: ReaderPage[] = []
  const paragraphMatches = [...text.matchAll(/\S[\s\S]*?(?=\n{2,}\S|\s*$)/g)]

  let pageStart: number | null = null
  let pageEnd: number | null = null

  const flush = () => {
    if (pageStart === null || pageEnd === null || pageEnd <= pageStart) {
      return
    }

    pages.push({
      start: pageStart,
      end: pageEnd,
      text: text.slice(pageStart, pageEnd),
    })
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
    pages.push({
      start: 0,
      end: text.length,
      text,
    })
  }

  return pages
}
