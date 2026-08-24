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

export type ReaderScrollerStyle = {
  overflowX: 'hidden'
  overflowY: 'hidden' | 'auto'
  touchAction: 'none' | 'pan-y'
}

/** Axis-specific overflow so a sheet lock cannot leave `overflow: hidden` stuck. */
export function readerScrollerStyle(layout: ReaderLayout): ReaderScrollerStyle {
  const paginated = layout === 'paginated'
  return {
    overflowX: 'hidden',
    overflowY: paginated ? 'hidden' : 'auto',
    touchAction: paginated ? 'none' : 'pan-y',
  }
}

export function applyReaderScrollerStyle(
  el: {
    style: {
      overflow: string
      overflowX: string
      overflowY: string
      touchAction: string
    }
  },
  layout: ReaderLayout,
): void {
  const next = readerScrollerStyle(layout)
  // Clear the shorthand first: `overflow: hidden` would override overflowY.
  el.style.overflow = ''
  el.style.overflowX = next.overflowX
  el.style.overflowY = next.overflowY
  el.style.touchAction = next.touchAction
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

export function pageIndexForOffset(pages: Array<{ startOffset: number }>, offset: number): number {
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

/**
 * Keep a playback highlight inside one page. A `<mark>` that straddles the
 * paginated clip-path often paints nothing (clip + box-decoration-break).
 */
export function clipRangeToPage(
  start: number,
  end: number,
  pages: Array<{ startOffset: number }>,
  pageIndex: number,
  textLength: number,
): { start: number; end: number } | null {
  const lo = Math.min(start, end)
  const hi = Math.max(start, end)
  if (pages.length === 0) return hi > lo ? { start: lo, end: hi } : null
  const i = clampPageIndex(pageIndex, pages.length)
  const pageStart = Math.max(0, pages[i]!.startOffset)
  const pageEnd = pages[i + 1]?.startOffset ?? Math.max(pageStart, textLength)
  const clippedStart = Math.max(lo, pageStart)
  const clippedEnd = Math.min(hi, pageEnd)
  return clippedEnd > clippedStart ? { start: clippedStart, end: clippedEnd } : null
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
  const bottom =
    listedBottom != null && listedBottom > top
      ? listedBottom
      : nextTop != null
        ? Math.max(top, nextTop)
        : top + Math.max(1, viewH)
  return { top, bottom }
}
