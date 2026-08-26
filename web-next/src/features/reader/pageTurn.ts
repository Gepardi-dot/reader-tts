/** iOS-like page-turn physics for the paginated reader. */

export const PAGE_TURN_AXIS_LOCK_PX = 8
export const PAGE_TURN_COMMIT_PX = 22
export const PAGE_TURN_COMMIT_RATIO = 0.055
export const PAGE_TURN_VELOCITY_PX_MS = 0.32
export const PAGE_TURN_MIN_FLICK_PX = 8
export const PAGE_TURN_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)'
/** Slow LTR on a word past this time is a highlight, not a page flick. */
export const PAGE_SELECT_MIN_MS = 140
/** Slow LTR on a word past this travel is a highlight, not a page flick. */
export const PAGE_SELECT_MIN_PX = 18
/** A page flick usually commits inside this window from finger-down. */
export const PAGE_FLICK_MAX_MS = 220

export type PaginatedSwipeIntent = 'undecided' | 'select' | 'page'

/**
 * Paginated touch: quick left/right flicks turn the page; an intentional LTR
 * drag on English text grows a highlight. RTL is never a highlight.
 */
export function classifyPaginatedSwipe(input: {
  startedOnText: boolean
  dx: number
  dy: number
  dtMs: number
  vx: number
  phase?: 'move' | 'end'
}): PaginatedSwipeIntent {
  const { startedOnText, dx, dy, dtMs, vx, phase = 'move' } = input
  const axis = lockPageTurnAxis(dx, dy)
  if (!axis) return 'undecided'
  if (axis === 'y') return 'page'
  // Finger left = next page. English selection is LTR, so RTL is always a turn.
  if (dx < 0) return 'page'
  // Finger right off the words — previous page, even when the swipe is slow.
  if (!startedOnText) return 'page'

  const travel = Math.abs(dx)
  const instant = dtMs > 0 ? travel / dtMs : 0
  const speed = Math.max(Math.abs(vx), instant)
  // A page-back flick is a short, fast right swipe. A longer LTR drag on
  // words is a highlight even if the finger is moving fairly quickly.
  const isFlick = speed >= PAGE_TURN_VELOCITY_PX_MS && dtMs <= PAGE_FLICK_MAX_MS
  if (isFlick) return 'page'

  const intentional = dtMs >= PAGE_SELECT_MIN_MS || travel >= PAGE_SELECT_MIN_PX
  if (intentional) return 'select'
  if (phase === 'end') return travel >= PAGE_SELECT_MIN_PX ? 'select' : 'undecided'
  return 'undecided'
}

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function'
    && matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** iOS rubber-band: overscroll grows slower the further you pull. */
export function rubberBandOffset(offset: number, dimension: number, constant = 0.55): number {
  if (dimension <= 0 || offset === 0) return 0
  const sign = Math.sign(offset)
  const mag = Math.abs(offset)
  return sign * (1 - 1 / (mag * constant / dimension + 1)) * dimension
}

export function resistPageTurnOffset(
  offset: number,
  size: number,
  canPrev: boolean,
  canNext: boolean,
): number {
  if (offset > 0 && !canPrev) return rubberBandOffset(offset, size)
  if (offset < 0 && !canNext) return rubberBandOffset(offset, size)
  return offset
}

export function lockPageTurnAxis(
  dx: number,
  dy: number,
  lockPx = PAGE_TURN_AXIS_LOCK_PX,
): 'x' | 'y' | null {
  const ax = Math.abs(dx)
  const ay = Math.abs(dy)
  if (ax < lockPx && ay < lockPx) return null
  return ax >= ay ? 'x' : 'y'
}

/**
 * Finger displacement: positive = right / down → previous page (−1).
 * Negative = left / up → next page (+1).
 */
export function shouldCommitPageTurn(options: {
  offset: number
  velocity: number
  size: number
  canPrev: boolean
  canNext: boolean
}): -1 | 0 | 1 {
  const { offset, velocity, size, canPrev, canNext } = options
  const threshold = Math.max(PAGE_TURN_COMMIT_PX, size * PAGE_TURN_COMMIT_RATIO)
  const abs = Math.abs(offset)
  const flick = Math.abs(velocity) >= PAGE_TURN_VELOCITY_PX_MS
    && abs >= PAGE_TURN_MIN_FLICK_PX

  let dir: -1 | 0 | 1 = 0
  if (offset <= -threshold) dir = 1
  else if (offset >= threshold) dir = -1
  else if (flick) dir = velocity < 0 ? 1 : -1

  if (dir === 1 && !canNext) return 0
  if (dir === -1 && !canPrev) return 0
  return dir
}

export function pageTurnDurationMs(distance: number, velocityPxMs: number): number {
  const remaining = Math.abs(distance)
  const speed = Math.abs(velocityPxMs)
  if (speed > 0.2) {
    return Math.round(clampNumber(remaining / speed, 260, 480))
  }
  return Math.round(clampNumber(300 + remaining * 0.14, 300, 520))
}

export function pageRestY(pageTop: number): number {
  const y = Math.max(0, pageTop)
  return y === 0 ? 0 : -y
}

/**
 * Desktop paginated: only the empty gutters beside the written column turn
 * the page. Clicks on the text itself never do.
 * Left of the column → previous, right of the column → next.
 */
export function pageTurnGutterDir(
  clientX: number,
  contentLeft: number,
  contentRight: number,
): -1 | 0 | 1 {
  if (!(contentRight > contentLeft)) return 0
  if (clientX < contentLeft) return -1
  if (clientX > contentRight) return 1
  return 0
}

export function isFinePointerClick(event?: Event | { pointerType?: string } | null): boolean {
  const pointerType = event && 'pointerType' in event
    ? event.pointerType
    : undefined
  if (pointerType === 'touch') return false
  if (pointerType === 'mouse' || pointerType === 'pen') return true
  return typeof matchMedia === 'function'
    && matchMedia('(hover: hover) and (pointer: fine)').matches
}

/** Swipe-to-turn is for touch. Mouse/pen use gutter clicks instead. */
export function shouldTrackPageTurnPointer(
  event?: Event | { pointerType?: string } | null,
): boolean {
  return !isFinePointerClick(event)
}

export async function animateTransform(
  element: HTMLElement,
  to: string,
  duration: number,
): Promise<void> {
  if (prefersReducedMotion() || duration < 16) {
    element.style.transition = 'none'
    element.style.transform = to
    return
  }

  element.style.transition = 'none'
  const from = getComputedStyle(element).transform || 'none'
  const animation = element.animate(
    [{ transform: from }, { transform: to }],
    { duration, easing: PAGE_TURN_EASING, fill: 'forwards' },
  )
  try {
    await animation.finished
  } catch {
    // Aborted by a newer gesture.
  }
  animation.cancel()
  element.style.transform = to
}
