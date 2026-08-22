export type ReaderLayout = 'continuous' | 'paginated'

export type ReaderLineBox = {
  top: number
  bottom: number
  startOffset: number
}

export type ReaderPageBreak = {
  top: number
  /** Exclusive end in document Y — the next page's first line top. */
  bottom: number
  startOffset: number
}

export function normalizeReaderLayout(value: unknown): ReaderLayout {
  return value === 'paginated' ? 'paginated' : 'continuous'
}

export function pageBreaksFromLineBoxes(
  lines: ReaderLineBox[],
  viewportHeight: number,
): ReaderPageBreak[] {
  if (lines.length === 0) return [{ top: 0, bottom: Math.max(1, viewportHeight), startOffset: 0 }]

  const height = Math.max(1, viewportHeight)
  const pages: ReaderPageBreak[] = []
  let index = 0

  while (index < lines.length) {
    const start = lines[index]!
    const limit = start.top + height
    let next = index
    while (next < lines.length && lines[next]!.bottom <= limit + 0.5) {
      next += 1
    }
    if (next === index) next = index + 1
    const last = lines[next - 1]!
    const following = lines[next]
    pages.push({
      top: start.top,
      bottom: following ? following.top : last.bottom,
      startOffset: start.startOffset,
    })
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

/** Visible Y-span of one page in the laid-out document. */
export function pageClipRange(
  pages: Array<{ top: number; bottom?: number }>,
  index: number,
  viewH: number,
): { top: number; bottom: number } {
  if (pages.length === 0) return { top: 0, bottom: Math.max(1, viewH) }
  const i = clampPageIndex(index, pages.length)
  const page = pages[i]!
  const top = Math.max(0, page.top)
  const listedBottom = page.bottom
  const nextTop = pages[i + 1]?.top
  const bottom = listedBottom > top
    ? listedBottom
    : (nextTop != null ? Math.max(top, nextTop) : top + Math.max(1, viewH))
  return { top, bottom }
}
