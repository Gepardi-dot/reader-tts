/**
 * Split extracted prose into EPUB chapters for a cleaner reading structure.
 */

export interface BookChapter {
  id: string
  title: string
  text: string
}

const MAX_CHAPTER_CHARS = 48_000

/** Detect markdown / plain “Chapter …” headings and hard breaks. */
export function splitTextIntoChapters(fullText: string, bookTitle: string): BookChapter[] {
  const text = fullText.replace(/\r\n?/g, '\n').trim()
  if (!text) return [{ id: 'ch-1', title: bookTitle || 'Chapter 1', text: '' }]

  // Prefer markdown ATX headings
  const mdParts = splitByMarkdownHeadings(text)
  if (mdParts.length >= 2) return clampChapters(mdParts, bookTitle)

  // "Chapter 1", "CHAPTER XII", "Part 2", etc.
  const headingParts = splitByChapterHeadings(text)
  if (headingParts.length >= 2) return clampChapters(headingParts, bookTitle)

  // Form feed or very large gaps
  if (text.includes('\f')) {
    const parts = text.split(/\f+/).map((p) => p.trim()).filter(Boolean)
    if (parts.length >= 2) {
      return clampChapters(
        parts.map((body, i) => ({
          id: `ch-${i + 1}`,
          title: `Chapter ${i + 1}`,
          text: body,
        })),
        bookTitle,
      )
    }
  }

  // Single body — still split oversized blobs so EPUB clients stay smooth
  return clampChapters(
    [{ id: 'ch-1', title: bookTitle || 'Full text', text }],
    bookTitle,
  )
}

function splitByMarkdownHeadings(text: string): BookChapter[] {
  const lines = text.split('\n')
  const chapters: BookChapter[] = []
  let currentTitle = ''
  let buf: string[] = []
  let index = 0

  const flush = () => {
    const body = buf.join('\n').trim()
    if (!body && !currentTitle) return
    index += 1
    chapters.push({
      id: `ch-${index}`,
      title: currentTitle || `Chapter ${index}`,
      text: body,
    })
    buf = []
  }

  for (const line of lines) {
    const m = line.match(/^#{1,2}\s+(.+)$/)
    if (m) {
      flush()
      currentTitle = m[1].trim()
      continue
    }
    buf.push(line)
  }
  flush()
  return chapters.filter((c) => c.text.length > 0 || chapters.length === 1)
}

function splitByChapterHeadings(text: string): BookChapter[] {
  const re =
    /(?:^|\n)((?:Chapter|CHAPTER|Part|PART|Book|BOOK)\s+([0-9IVXLCDM]+|[A-Za-z][\w'’-]*)[^\n]*)\n/g
  const matches = [...text.matchAll(re)]
  if (matches.length < 2) return []

  const chapters: BookChapter[] = []
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]
    const start = (m.index ?? 0) + (m[0].startsWith('\n') ? 1 : 0)
    const titleLineEnd = start + m[1].length
    const bodyStart = titleLineEnd
    const next = matches[i + 1]
    const bodyEnd = next ? (next.index ?? text.length) + (next[0].startsWith('\n') ? 1 : 0) : text.length
    const body = text.slice(bodyStart, bodyEnd).replace(/^\n+/, '').trim()
    chapters.push({
      id: `ch-${i + 1}`,
      title: m[1].trim(),
      text: body,
    })
  }

  // Leading preface before first heading
  const firstIdx = matches[0].index ?? 0
  if (firstIdx > 80) {
    const preface = text.slice(0, firstIdx).trim()
    if (preface.length > 40) {
      chapters.unshift({ id: 'ch-0', title: 'Preface', text: preface })
    }
  }

  return chapters.filter((c) => c.text.length > 0)
}

function clampChapters(chapters: BookChapter[], bookTitle: string): BookChapter[] {
  const out: BookChapter[] = []
  let n = 0
  for (const ch of chapters) {
    if (ch.text.length <= MAX_CHAPTER_CHARS) {
      n += 1
      out.push({ ...ch, id: `ch-${n}` })
      continue
    }
    // Hard-split long chapters on paragraph boundaries
    const paras = ch.text.split(/\n{2,}/)
    let buf = ''
    let part = 1
    const pushPart = (body: string) => {
      n += 1
      out.push({
        id: `ch-${n}`,
        title: part === 1 ? ch.title : `${ch.title} (${part})`,
        text: body.trim(),
      })
      part += 1
    }
    for (const p of paras) {
      if ((buf + '\n\n' + p).length > MAX_CHAPTER_CHARS && buf) {
        pushPart(buf)
        buf = p
      } else {
        buf = buf ? `${buf}\n\n${p}` : p
      }
    }
    if (buf.trim()) pushPart(buf)
  }
  if (out.length === 0) {
    return [{ id: 'ch-1', title: bookTitle || 'Chapter 1', text: '' }]
  }
  return out
}
