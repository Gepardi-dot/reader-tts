/**
 * Printed page furniture that PDF/EPUB extraction leaves in the book text.
 * A line that is only a page number is hidden in the reader and omitted from
 * speech. Prose, years (1000–2099), and sentences that merely contain a
 * number stay. Offsets in the stored book are unchanged: hidden lines remain
 * in the DOM so taps and highlights still line up.
 *
 * Keep in sync with cloudflare/worker/src/pageNumbers.ts and
 * server/page_numbers.py.
 */

const PAGE_LABEL = /^(?:page|pg|p)\.?\s*\d{1,4}(?:\s*(?:of|\/)\s*\d{1,4})?$/i
const PAGE_FRACTION = /^\d{1,4}\s*(?:\/|of)\s*\d{1,4}$/i
const DECORATED = /^[-–—~*•.]+\s*\d{1,4}\s*[-–—~*•.]+$/
const BRACKETED = /^(?:\[|\()\s*\d{1,4}\s*(?:\]|\))$/
const BARE = /^(\d{1,4})[.)]?$/
const TRAILING_PAGE = /^(.*[.!?])(["'”’)]*)\s+(\d{1,4})\s*$/
const TRAILING_ABBREV = /\b(?:Mr|Mrs|Ms|Dr|St|Prof|Jr|Sr|vs|etc|fig|vol|no|pp|p|ch|sec|ed|rev|gen|cf)\.$/i

/** Prose with a glued-on page number removed (`door. 42` → `door.`), or null. */
export function proseWithoutTrailingPageNumber(line: string): string | null {
  const match = TRAILING_PAGE.exec(line)
  if (!match) return null
  const value = Number(match[3])
  if (value >= 1000 && value <= 2099) return null
  const prose = `${match[1] ?? ''}${match[2] ?? ''}`
  if (!prose.trim() || TRAILING_ABBREV.test(prose)) return null
  return prose
}

export function isPageNumberLine(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed) return false
  if (PAGE_LABEL.test(trimmed) || PAGE_FRACTION.test(trimmed) || DECORATED.test(trimmed)) return true
  if (BRACKETED.test(trimmed)) return true
  const bare = BARE.exec(trimmed)
  if (!bare) return false
  const value = Number(bare[1])
  if (value >= 1000 && value <= 2099) return false
  return true
}

/** True when every non-blank line is a printed page number. */
export function isPageNumberBlock(text: string): boolean {
  let sawNumber = false
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    if (!isPageNumberLine(line)) return false
    sawNumber = true
  }
  return sawNumber
}

export interface PageNumberRun {
  text: string
  pageNumber: boolean
}

/** Split text into visible prose and page-number runs. Character count is preserved. */
export function splitPageNumberLines(text: string): PageNumberRun[] {
  if (!text) return []
  const parts: PageNumberRun[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    const newline = i < lines.length - 1 ? '\n' : ''
    const chunk = `${line}${newline}`
    if (!chunk) continue
    if (isPageNumberLine(line)) {
      pushRun(parts, chunk, true)
      continue
    }
    const prose = proseWithoutTrailingPageNumber(line)
    if (prose != null && prose.length < line.length) {
      pushRun(parts, prose, false)
      pushRun(parts, `${line.slice(prose.length)}${newline}`, true)
      continue
    }
    pushRun(parts, chunk, false)
  }
  return parts
}

function pushRun(parts: PageNumberRun[], text: string, pageNumber: boolean) {
  if (!text) return
  const prev = parts[parts.length - 1]
  if (prev && prev.pageNumber === pageNumber) prev.text += text
  else parts.push({ text, pageNumber })
}

/**
 * Text actually spoken. Returns the original string when nothing was removed
 * so audio cache keys for ordinary prose stay stable.
 */
export function speechTextWithoutPageNumbers(text: string): string {
  if (!text) return text
  const lines = text.split('\n')
  let removed = false
  const kept: string[] = []
  for (const line of lines) {
    if (isPageNumberLine(line)) {
      removed = true
      continue
    }
    const prose = proseWithoutTrailingPageNumber(line)
    if (prose != null) {
      removed = true
      if (prose) kept.push(prose)
      continue
    }
    kept.push(line)
  }
  if (!removed) return text
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** Short silence so a page-number-only slice still advances playback. */
export function silentSpeechWav(durationSec = 0.12, sampleRate = 24000): {
  pcm: Float32Array
  wav: ArrayBuffer
  sampleRate: number
  durationSec: number
} {
  const frames = Math.max(1, Math.floor(durationSec * sampleRate))
  const pcm = new Float32Array(frames)
  const dataBytes = frames * 2
  const wav = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(wav)
  const write = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i))
  }
  write(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  write(8, 'WAVE')
  write(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  write(36, 'data')
  view.setUint32(40, dataBytes, true)
  return { pcm, wav, sampleRate, durationSec: frames / sampleRate }
}
