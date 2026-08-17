export type ReaderLayout = 'continuous' | 'paginated'

export type ReaderLineBox = {
  top: number
  bottom: number
  startOffset: number
}

export type ReaderPageBreak = {
  top: number
  startOffset: number
}

export function normalizeReaderLayout(value: unknown): ReaderLayout {
  return value === 'paginated' ? 'paginated' : 'continuous'
}

export function pageBreaksFromLineBoxes(
  lines: ReaderLineBox[],
  viewportHeight: number,
): ReaderPageBreak[] {
  if (lines.length === 0) return [{ top: 0, startOffset: 0 }]

  const height = Math.max(1, viewportHeight)
  const pages: ReaderPageBreak[] = []
  let index = 0

  while (index < lines.length) {
    const start = lines[index]!
    pages.push({ top: start.top, startOffset: start.startOffset })
    const limit = start.top + height
    let next = index
    while (next < lines.length && lines[next]!.bottom <= limit + 0.5) {
      next += 1
    }
    if (next === index) next = index + 1
    index = next
  }

  return pages
}

export function pageIndexForY(pages: Array<{ top: number }>, y: number): number {
  if (pages.length === 0) return 0
  let index = 0
  for (let i = 0; i < pages.length; i += 1) {
    if (pages[i]!.top <= y) index = i
    else break
  }
  return index
}

export function pageIndexForOffset(
  pages: Array<{ startOffset: number }>,
  offset: number,
): number {
  if (pages.length === 0) return 0
  let index = 0
  for (let i = 0; i < pages.length; i += 1) {
    if (pages[i]!.startOffset <= offset) index = i
    else break
  }
  return index
}

export function clampPageIndex(index: number, pageCount: number): number {
  if (pageCount <= 0) return 0
  return Math.max(0, Math.min(pageCount - 1, index))
}
