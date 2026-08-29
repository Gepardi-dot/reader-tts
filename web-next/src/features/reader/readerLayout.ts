export type ReaderLayout = 'continuous' | 'paginated'

export type ReaderLineBox = {
  top: number
  bottom: number
  /** Source offset of the first character on this visual line. */
  startOffset: number
}

export type ReaderPageBreak = {
  top: number
  /** Exclusive end in document Y — the next page's first line top. */
  bottom: number
  /** Source offset of the first character that starts on this page. */
  startOffset: number
}

export function normalizeReaderLayout(value: unknown): ReaderLayout {
  return value === 'paginated' ? 'paginated' : 'continuous'
}

export type ReaderScrollerStyle = {
  overflowX: 'hidden'
  overflowY: 'hidden' | 'auto' | 'visible'
  touchAction: 'none' | 'pan-y'
}

/** Continuous reads on the document so iOS Safari/Chrome can collapse their chrome. */
export function readerUsesWindowScroll(layout: ReaderLayout) {
  return layout !== 'paginated'
}

/** Axis-specific overflow so a sheet lock cannot leave `overflow: hidden` stuck. */
export function readerScrollerStyle(layout: ReaderLayout): ReaderScrollerStyle {
  const paginated = layout === 'paginated'
  return {
    overflowX: 'hidden',
    overflowY: paginated ? 'hidden' : 'visible',
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

/** Floating progress pill: 18px offset + 44px bar + gap. Not inner `pb-36`. */
export const PAGINATED_BOTTOM_CLEARANCE = 96

/** Play bar overlays the scroller; keep the spoken line fully above it. */
export const CONTINUOUS_FOLLOW_BOTTOM_CLEARANCE = 64

/** Spoken line sits around the middle of the readable column (header → play bar). */
export const CONTINUOUS_FOLLOW_TARGET = 0.45
export const CONTINUOUS_FOLLOW_SAFE_TOP = 0.34
export const CONTINUOUS_FOLLOW_SAFE_BOTTOM = 0.56

export function paginatedTextViewHeight(
  scrollerHeight: number,
  paddingTop: number,
  bottomClearance = PAGINATED_BOTTOM_CLEARANCE,
): number {
  return Math.max(
    120,
    Math.floor(scrollerHeight) - Math.max(0, paddingTop) - Math.max(0, bottomClearance),
  )
}

/** One page of complete lines. Never clip through a line. */
export function snapPageToLines(
  lines: ReadonlyArray<{ top: number; bottom: number }>,
  y: number,
  viewportHeight: number,
): { top: number; bottom: number } {
  const height = Math.max(1, viewportHeight)
  const target = Math.max(0, y)
  if (lines.length === 0) return { top: target, bottom: target + height }

  let start = 0
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]!.top <= target + 0.5) start = i
    else break
  }
  const top = lines[start]!.top
  const limit = top + height
  let end = start
  for (let i = start; i < lines.length; i += 1) {
    if (lines[i]!.bottom <= limit + 0.5) end = i
    else break
  }
  const last = lines[end]!
  const following = lines[end + 1]
  const bottom = following ? following.top : last.bottom
  return { top, bottom: Math.max(top + 1, bottom) }
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

/**
 * Source offset of the first character on each visual line in one paragraph.
 * `charTop(localOffset)` is Y relative to the same origin as `lines[i].top`
 * and must be non-decreasing through the paragraph.
 */
export function assignLineStartOffsets(
  lines: ReadonlyArray<{ top: number }>,
  paragraphStart: number,
  textLength: number,
  charTop: (localOffset: number) => number | null,
): number[] {
  const paraStart = Math.max(0, Math.floor(paragraphStart))
  const length = Math.max(0, Math.floor(textLength))
  if (lines.length === 0) return []
  const offsets = lines.map(() => paraStart)
  if (lines.length === 1 || length <= 0) return offsets

  let lo = 0
  for (let i = 1; i < lines.length; i += 1) {
    const lineTop = lines[i]!.top
    let left = lo
    let right = length
    while (left < right) {
      const mid = (left + right) >> 1
      const y = charTop(mid)
      if (y == null || y >= lineTop - 1) right = mid
      else left = mid + 1
    }
    offsets[i] = paraStart + left
    lo = left
  }
  return offsets
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

/** Last page whose first character is at or before `offset`. Pages must use the first character on that page, not the enclosing paragraph start. */
export function pageIndexForOffset(pages: ReadonlyArray<{ startOffset: number }>, offset: number): number {
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

export type OverlayRect = {
  left: number
  top: number
  width: number
  height: number
}

/** Keep overlay boxes inside the visible page frame. */
export function clipRectsToBounds(
  rects: readonly OverlayRect[],
  bounds: OverlayRect,
): OverlayRect[] {
  const right = bounds.left + bounds.width
  const bottom = bounds.top + bounds.height
  const out: OverlayRect[] = []
  for (const rect of rects) {
    const left = Math.max(rect.left, bounds.left)
    const top = Math.max(rect.top, bounds.top)
    const r = Math.min(rect.left + rect.width, right)
    const b = Math.min(rect.top + rect.height, bottom)
    const width = r - left
    const height = b - top
    if (width >= 1 && height >= 1) out.push({ left, top, width, height })
  }
  return out
}

export function overlayRectsEqual(a: readonly OverlayRect[], b: readonly OverlayRect[]): boolean {
  if (a.length !== b.length) return false
  return a.every((rect, i) => {
    const other = b[i]!
    return rect.left === other.left
      && rect.top === other.top
      && rect.width === other.width
      && rect.height === other.height
  })
}

/** Collapse word boxes on the same visual line into one wash. */
export function mergeRectsIntoLineWashes(
  rects: readonly OverlayRect[],
  yTolerance = 8,
): OverlayRect[] {
  if (rects.length === 0) return []
  const sorted = [...rects].sort((a, b) => a.top - b.top || a.left - b.left)
  const lines: OverlayRect[] = []
  for (const rect of sorted) {
    const prev = lines[lines.length - 1]
    const sameLine = Boolean(
      prev
      && Math.abs(rect.top - prev.top) <= yTolerance
      && rect.top < prev.top + prev.height,
    )
    if (sameLine && prev) {
      const right = Math.max(prev.left + prev.width, rect.left + rect.width)
      const bottom = Math.max(prev.top + prev.height, rect.top + rect.height)
      prev.left = Math.min(prev.left, rect.left)
      prev.top = Math.min(prev.top, rect.top)
      prev.width = right - prev.left
      prev.height = bottom - prev.top
    } else {
      lines.push({
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      })
    }
  }
  return lines
}

/** Map viewport boxes onto a transformed page inner. */
export function clientRectsToLocal(
  rects: readonly OverlayRect[],
  origin: { left: number; top: number },
): OverlayRect[] {
  return rects.map((rect) => ({
    left: rect.left - origin.left,
    top: rect.top - origin.top,
    width: rect.width,
    height: rect.height,
  })).filter((rect) => rect.width >= 1 && rect.height >= 1)
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

export function clampReadOffset(offset: number, textLength: number): number {
  if (!Number.isFinite(offset) || textLength <= 0) return 0
  return Math.max(0, Math.min(textLength - 1, Math.floor(offset)))
}

export function scrollPctFromOffset(offset: number, textLength: number): number {
  if (textLength <= 0) return 0
  return Math.min(1, Math.max(0, offset / textLength))
}

/**
 * Paginated and continuous don't share a pixel coordinate system. Always move
 * by source offset: live spoken text while following playback, otherwise the
 * character currently at the reading position.
 */
export function resolveLayoutSwitchOffset(options: {
  spokenStart: number | null
  viewportOffset: number
  textLength: number
  followPlayback: boolean
}): number {
  const viewport = clampReadOffset(options.viewportOffset, options.textLength)
  if (
    options.followPlayback
    && options.spokenStart != null
    && Number.isFinite(options.spokenStart)
  ) {
    return clampReadOffset(options.spokenStart, options.textLength)
  }
  return viewport
}

export function scrollDeltaToPinRect(rectTop: number, pinY: number, minDelta = 4): number {
  if (!Number.isFinite(rectTop) || !Number.isFinite(pinY)) return 0
  const delta = rectTop - pinY
  return Math.abs(delta) < minDelta ? 0 : delta
}

/** Middle reading band inside the visible column, in viewport Y. */
export function continuousFollowBand(readableTop: number, readableBottom: number): {
  targetY: number
  safeTop: number
  safeBottom: number
} {
  const top = Number.isFinite(readableTop) ? readableTop : 0
  const bottom = Number.isFinite(readableBottom) ? Math.max(top + 1, readableBottom) : top + 1
  const height = Math.max(1, bottom - top)
  return {
    targetY: top + height * CONTINUOUS_FOLLOW_TARGET,
    safeTop: top + height * CONTINUOUS_FOLLOW_SAFE_TOP,
    safeBottom: top + height * CONTINUOUS_FOLLOW_SAFE_BOTTOM,
  }
}

/**
 * Keep the spoken line around the middle of the page. Stay put while it is in
 * the middle band; if it drifts too high or too low, pin its center back to
 * the reading target.
 */
export function continuousSpokenFollowDelta(options: {
  spokenTop: number
  spokenBottom: number
  targetY: number
  safeTop: number
  safeBottom: number
  minDelta?: number
}): number {
  const { spokenTop, spokenBottom, targetY, safeTop, safeBottom, minDelta = 8 } = options
  if (!Number.isFinite(spokenTop) || !Number.isFinite(spokenBottom)) return 0
  if (!Number.isFinite(targetY) || !Number.isFinite(safeTop) || !Number.isFinite(safeBottom)) return 0
  const spokenMid = (spokenTop + spokenBottom) / 2
  if (spokenMid >= safeTop && spokenMid <= safeBottom) return 0
  return scrollDeltaToPinRect(spokenMid, targetY, minDelta)
}

/** Inner scrollTop → source-Y of the first line below the column padding. */
export function pageTopFromInnerScroll(scrollTop: number, paddingTop: number): number {
  if (!Number.isFinite(scrollTop) || !Number.isFinite(paddingTop)) return 0
  return Math.max(0, scrollTop - Math.max(0, paddingTop))
}

export type PagedLayoutCacheKey = {
  viewH: number
  fontSize: number
  lineHeight: number
  width: string
  font: string
  bionic: boolean
  align: string
  textLength: number
}

export function pagedLayoutCacheKeyEqual(
  a: PagedLayoutCacheKey | null | undefined,
  b: PagedLayoutCacheKey | null | undefined,
): boolean {
  if (!a || !b) return false
  return Math.abs(a.viewH - b.viewH) <= 2
    && a.fontSize === b.fontSize
    && Math.abs(a.lineHeight - b.lineHeight) < 0.05
    && a.width === b.width
    && a.font === b.font
    && a.bionic === b.bionic
    && a.align === b.align
    && a.textLength === b.textLength
}

/** Current page plus neighbors so page-turn clones have real boxes without laying out the book. */
export function pagedParagraphWindow(options: {
  pages: ReadonlyArray<{ startOffset: number }>
  offset: number
  textLength: number
}): { start: number; end: number } {
  const textLength = Math.max(0, options.textLength)
  const offset = clampReadOffset(options.offset, textLength)
  if (options.pages.length === 0) {
    return {
      start: Math.max(0, offset - 200),
      end: textLength > 0 ? Math.min(textLength, offset + 4500) : offset + 4500,
    }
  }
  const i = pageIndexForOffset(options.pages, offset)
  const start = options.pages[Math.max(0, i - 1)]!.startOffset
  const endIndex = i + 2
  const end = endIndex < options.pages.length
    ? options.pages[endIndex]!.startOffset
    : Math.max(start + 1, textLength)
  return { start, end }
}
