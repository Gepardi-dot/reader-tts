/** iOS-like page-turn physics for the paginated reader. */

export const PAGE_TURN_AXIS_LOCK_PX = 8
export const PAGE_TURN_COMMIT_PX = 22
export const PAGE_TURN_COMMIT_RATIO = 0.055
export const PAGE_TURN_VELOCITY_PX_MS = 0.32
export const PAGE_TURN_MIN_FLICK_PX = 8
export const PAGE_TURN_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)'

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

/** Desktop click: left half of the screen → previous, right half → next. */
export function pageTurnClickDir(clientX: number, viewportWidth: number): -1 | 1 {
  const width = Math.max(1, viewportWidth)
  return clientX < width / 2 ? -1 : 1
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
