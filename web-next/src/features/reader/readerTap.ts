/** Finger travel still counted as a tap, not a scroll or highlight. */
export const READER_TAP_SLOP_PX = 14
/** Ignore synthetic clicks after a scroll/flick. */
export const READER_TAP_SUPPRESS_MS = 450

export function readerGestureDistance(dx: number, dy: number) {
  return Math.hypot(dx, dy)
}

export function isReaderTap(dx: number, dy: number, slop = READER_TAP_SLOP_PX) {
  return readerGestureDistance(dx, dy) <= slop
}

/**
 * After the finger has moved, a mostly-vertical gesture is a page scroll.
 * Do not require a 1.4× vertical bias — quick mobile flicks are rarely straight.
 */
export function isReaderScrollGesture(dx: number, dy: number, slop = READER_TAP_SLOP_PX) {
  if (readerGestureDistance(dx, dy) < slop) return false
  return Math.abs(dy) >= Math.abs(dx)
}
