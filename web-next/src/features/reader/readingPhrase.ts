/** Spoken wash: about three sentences, held until that span is finished. */

export const READING_PHRASE_MAX_CHARS = 4000
export const READING_WINDOW_SENTENCES = 3
export const READING_WINDOW_MAX_CHARS = 1800

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
    if (isSentenceTerminator(text, start - 1)) break
    if (isParagraphBoundary(text, start)) break
    start -= 1
  }
  while (start < end && isInlineSpace(text[start]!)) start += 1

  while (end < text.length && end - start < READING_PHRASE_MAX_CHARS) {
    if (isParagraphBoundary(text, end) && end > start) break
    end += 1
    if (isSentenceTerminator(text, end - 1)) {
      while (end < text.length && /["')\]]/.test(text[end]!)) end += 1
      break
    }
  }
  while (end > start && isInlineSpace(text[end - 1]!)) end -= 1

  return { start, end }
}

/** About three sentences from the current one, then hold until that span is spoken. */
export function expandToReadingWindow(
  startOffset: number,
  endOffset: number,
  text: string,
): { start: number; end: number } {
  let window = expandToReadingPhrase(startOffset, endOffset, text)
  if (!text) return window
  let count = 1
  while (
    count < READING_WINDOW_SENTENCES
    && window.end < text.length
    && window.end - window.start < READING_WINDOW_MAX_CHARS
  ) {
    const gap = skipSentenceGap(text, window.end)
    if (gap.paragraph || gap.index >= text.length) break
    const next = expandToReadingPhrase(gap.index, gap.index + 1, text)
    if (next.end <= window.end) break
    window = { start: window.start, end: next.end }
    count += 1
  }
  return window
}

export function resolveReadingWindow(
  spoken: number,
  text: string,
  current: { start: number; end: number } | null,
): { start: number; end: number } {
  if (!text) {
    const start = Math.max(0, spoken)
    return { start, end: start }
  }
  const offset = clamp(spoken, 0, Math.max(0, text.length - 1))
  if (
    current
    && current.end > current.start
    && offset >= current.start
    && offset < current.end
  ) {
    return current
  }
  return expandToReadingWindow(offset, offset + 1, text)
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, Math.floor(value)))
}

function isInlineSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t'
}

function consumeNewline(text: string, index: number): number {
  if (text[index] === '\r' && text[index + 1] === '\n') return index + 2
  if (text[index] === '\n' || text[index] === '\r') return index + 1
  return index
}

function skipHorizontal(text: string, index: number): number {
  let i = index
  while (i < text.length && isInlineSpace(text[i]!)) i += 1
  return i
}

/** Blank line (`\\n\\n`), not a single wrapped line. */
export function isParagraphBoundary(text: string, index: number): boolean {
  if (index <= 0) return false
  if (index >= text.length) return false
  let i = skipHorizontal(text, index)
  if (i >= text.length) return false
  if (text[i] !== '\n' && text[i] !== '\r') {
    // Walking backward: `index` is the first character after a blank line.
    let j = index - 1
    while (j >= 0 && isInlineSpace(text[j]!)) j -= 1
    if (j < 0) return false
    if (text[j] !== '\n' && text[j] !== '\r') return false
    if (j > 0 && text[j] === '\n' && text[j - 1] === '\r') j -= 2
    else j -= 1
    while (j >= 0 && isInlineSpace(text[j]!)) j -= 1
    return j >= 0 && (text[j] === '\n' || text[j] === '\r')
  }
  i = consumeNewline(text, i)
  i = skipHorizontal(text, i)
  return text[i] === '\n' || text[i] === '\r'
}

function skipSentenceGap(text: string, index: number): { index: number; paragraph: boolean } {
  let i = skipHorizontal(text, index)
  if (isParagraphBoundary(text, i)) return { index: i, paragraph: true }
  if (text[i] === '\n' || text[i] === '\r') {
    i = consumeNewline(text, i)
    i = skipHorizontal(text, i)
    if (text[i] === '\n' || text[i] === '\r') return { index: i, paragraph: true }
  }
  return { index: i, paragraph: false }
}

function isSentenceTerminator(text: string, index: number): boolean {
  const ch = text[index]
  if (!ch || !/[.!?…]/.test(ch)) return false
  const next = text[index + 1]
  return next == null || /[\s"')\]]/.test(next)
}
