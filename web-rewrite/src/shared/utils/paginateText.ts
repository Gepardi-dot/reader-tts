export type ReaderPage = {
  pageNumber: number
  start: number
  end: number
  text: string
}

export function paginateText(text: string, targetCharacters = 2200): ReaderPage[] {
  const clean = text.trim()
  if (!clean) {
    return [{ pageNumber: 1, start: 0, end: 0, text: '' }]
  }

  const paragraphs = clean.split(/\n\s*\n/)
  const pages: ReaderPage[] = []
  let pageStart = 0
  let currentStart = 0
  let buffer = ''

  for (const paragraph of paragraphs) {
    const nextBlock = buffer ? `${buffer}\n\n${paragraph}` : paragraph
    if (nextBlock.length > targetCharacters && buffer) {
      pages.push({
        pageNumber: pages.length + 1,
        start: pageStart,
        end: currentStart + buffer.length,
        text: buffer,
      })
      pageStart = currentStart + buffer.length + 2
      buffer = paragraph
      currentStart = pageStart
      continue
    }
    buffer = nextBlock
  }

  if (buffer) {
    pages.push({
      pageNumber: pages.length + 1,
      start: pageStart,
      end: pageStart + buffer.length,
      text: buffer,
    })
  }

  return pages.length ? pages : [{ pageNumber: 1, start: 0, end: clean.length, text: clean }]
}
