/** Expand a live TTS cue (often a word or chunk) to the spoken sentence/phrase. */

export const READING_PHRASE_MAX_CHARS = 320

export function expandToReadingPhrase(
  startOffset: number,
  endOffset: number,
  text: string,
): { start: number; end: number } {
  if (!text) {
    const start = Math.max(0, startOffset)
    const end = Math.max(start, endOffset)
    return { start, end }
  }

  let start = clamp(startOffset, 0, text.length)
  let end = clamp(endOffset, 0, text.length)
  if (end < start) [start, end] = [end, start]
  if (start === end && end < text.length) end += 1

  while (start > 0 && end - start < READING_PHRASE_MAX_CHARS) {
    const prev = text[start - 1]!
    if (prev === '\n' || prev === '\r') break
    if (isSentenceTerminator(text, start - 1)) break
    start -= 1
  }
  while (start < end && /\s/.test(text[start]!)) start += 1

  while (end < text.length && end - start < READING_PHRASE_MAX_CHARS) {
    const ch = text[end]!
    if (ch === '\n' || ch === '\r') break
    end += 1
    if (isSentenceTerminator(text, end - 1)) {
      while (end < text.length && /["')\]]/.test(text[end]!)) end += 1
      break
    }
  }
  while (end > start && /\s/.test(text[end - 1]!)) end -= 1

  return { start, end }
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, Math.floor(value)))
}

function isSentenceTerminator(text: string, index: number): boolean {
  const ch = text[index]
  if (!ch || !/[.!?…]/.test(ch)) return false
  const next = text[index + 1]
  return next == null || /[\s"')\]]/.test(next)
}
