/**
 * Stable prosodic segments for Kokoro.
 *
 * Segment boundaries depend only on book text (not tap offset or ephemeral
 * chunk budgets). That makes cache keys durable: the same sentence always
 * maps to the same segment id across taps, prep, and replay.
 */

export interface StableSegment {
  /** Stable id: `s:{start}:{end}` */
  id: string
  index: number
  start: number
  end: number
  text: string
}

// Shorter segments = faster first cold synth + denser preheat hits.
export const STABLE_SEGMENT_TARGET_CHARS = 100
export const STABLE_SEGMENT_MAX_CHARS = 160
export const STABLE_SEGMENT_MIN_CHARS = 20

const SENTENCE_END = /[.!?]["')\]]*\s+/g

/**
 * Split full book text into stable segments once (or from a window).
 * Prefer sentence boundaries; fall back to clause/space when overlong.
 */
export function buildStableSegments(
  bookText: string,
  options?: { from?: number; to?: number },
): StableSegment[] {
  const from = Math.max(0, options?.from ?? 0)
  const to = Math.min(bookText.length, options?.to ?? bookText.length)
  if (from >= to) return []

  const slice = bookText.slice(from, to)
  const raw: Array<{ start: number; end: number }> = []

  let cursor = 0
  while (cursor < slice.length) {
    // Skip pure whitespace runs (they don't get audio segments).
    while (cursor < slice.length && /\s/.test(slice[cursor]!)) cursor += 1
    if (cursor >= slice.length) break

    const remaining = slice.length - cursor
    if (remaining <= STABLE_SEGMENT_TARGET_CHARS) {
      raw.push({ start: from + cursor, end: from + slice.length })
      break
    }

    const windowEnd = Math.min(slice.length, cursor + STABLE_SEGMENT_MAX_CHARS)
    const window = slice.slice(cursor, windowEnd)

    let cut = findSentenceCut(window, STABLE_SEGMENT_TARGET_CHARS)
    if (cut < STABLE_SEGMENT_MIN_CHARS) {
      cut = findSpaceCut(window, STABLE_SEGMENT_TARGET_CHARS)
    }
    if (cut < STABLE_SEGMENT_MIN_CHARS) {
      cut = Math.min(STABLE_SEGMENT_TARGET_CHARS, window.length)
    }

    const absStart = from + cursor
    const absEnd = from + cursor + cut
    // Trim trailing whitespace from segment end for cleaner cache keys.
    let end = absEnd
    while (end > absStart && /\s/.test(bookText[end - 1]!)) end -= 1
    if (end > absStart) raw.push({ start: absStart, end })
    cursor += cut
  }

  return raw
    .filter((r) => bookText.slice(r.start, r.end).trim().length > 0)
    .map((r, index) => ({
      id: segmentId(r.start, r.end),
      index,
      start: r.start,
      end: r.end,
      text: bookText.slice(r.start, r.end),
    }))
}

export function segmentId(start: number, end: number) {
  return `s:${start}:${end}`
}

/** First segment whose range contains offset, or the next segment at/after offset. */
export function findSegmentIndexAt(segments: readonly StableSegment[], offset: number): number {
  if (segments.length === 0) return -1
  const o = Math.max(0, offset)
  for (let i = 0; i < segments.length; i += 1) {
    const s = segments[i]!
    if (o < s.end) return i
  }
  return segments.length - 1
}

/** Segments from startIndex through a char budget (for idle prep windows). */
export function sliceSegments(
  segments: readonly StableSegment[],
  startIndex: number,
  maxSegments: number,
): StableSegment[] {
  const start = Math.max(0, startIndex)
  return segments.slice(start, start + Math.max(0, maxSegments))
}

function findSentenceCut(window: string, target: number): number {
  SENTENCE_END.lastIndex = 0
  let best = -1
  let match: RegExpExecArray | null
  while ((match = SENTENCE_END.exec(window)) !== null) {
    const end = match.index + match[0].length
    if (end >= STABLE_SEGMENT_MIN_CHARS) best = end
    if (end >= target) return end
  }
  // Trailing sentence with no following whitespace
  const soft = window.search(/[.!?]["')\]]*$/)
  if (soft >= STABLE_SEGMENT_MIN_CHARS) {
    return window.length
  }
  return best
}

function findSpaceCut(window: string, target: number): number {
  const searchFrom = Math.min(window.length - 1, Math.max(STABLE_SEGMENT_MIN_CHARS, target))
  for (let i = searchFrom; i >= STABLE_SEGMENT_MIN_CHARS; i -= 1) {
    if (/\s/.test(window[i]!)) return i + 1
  }
  for (let i = searchFrom; i < window.length; i += 1) {
    if (/\s/.test(window[i]!)) return i + 1
  }
  return -1
}
