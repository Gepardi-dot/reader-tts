/**
 * ISBN and bibliographic hints extracted from filenames, OPF, PDF text, and metadata.
 */

const ISBN13_LOOSE_RE = /97[89](?:[-\s]?\d){10}/g
const ISBN10_LABELED_RE = /ISBN(?:-1[03])?:?\s*([\dXx](?:[-\s]?[\dXx]){9})/gi

export function compactIsbn(raw: string): string {
  return raw.replace(/[^0-9Xx]/g, '').toUpperCase()
}

export function isValidIsbn10(raw: string): boolean {
  const isbn = compactIsbn(raw)
  if (!/^\d{9}[\dX]$/.test(isbn)) return false
  let sum = 0
  for (let i = 0; i < 9; i += 1) sum += (10 - i) * Number(isbn[i])
  sum += isbn[9] === 'X' ? 10 : Number(isbn[9])
  return sum % 11 === 0
}

export function isValidIsbn13(raw: string): boolean {
  const isbn = compactIsbn(raw)
  if (!/^97[89]\d{10}$/.test(isbn)) return false
  let sum = 0
  for (let i = 0; i < 12; i += 1) sum += Number(isbn[i]) * (i % 2 === 0 ? 1 : 3)
  const check = (10 - (sum % 10)) % 10
  return check === Number(isbn[12])
}

export function isbn10To13(raw: string): string | null {
  const isbn10 = compactIsbn(raw)
  if (!isValidIsbn10(isbn10)) return null
  const body = `978${isbn10.slice(0, 9)}`
  let sum = 0
  for (let i = 0; i < 12; i += 1) sum += Number(body[i]) * (i % 2 === 0 ? 1 : 3)
  const check = (10 - (sum % 10)) % 10
  return `${body}${check}`
}

export function canonicalIsbn(raw: string): string | null {
  const compact = compactIsbn(raw)
  if (isValidIsbn13(compact)) return compact
  return isbn10To13(compact)
}

export function extractIsbnsFromText(text: string): string[] {
  if (!text) return []
  const found: string[] = []
  const seen = new Set<string>()

  const push = (raw: string) => {
    const isbn = canonicalIsbn(raw)
    if (!isbn || seen.has(isbn)) return
    seen.add(isbn)
    found.push(isbn)
  }

  for (const match of text.match(ISBN13_LOOSE_RE) ?? []) push(match)

  ISBN10_LABELED_RE.lastIndex = 0
  let labeled: RegExpExecArray | null
  while ((labeled = ISBN10_LABELED_RE.exec(text))) {
    push(labeled[1])
  }

  return found
}

export function looksLikeBookTitle(raw: string): boolean {
  const title = raw.replace(/\s+/g, ' ').trim()
  if (title.length < 3 || title.length > 180) return false
  if (/^(untitled|unknown|document|microsoft word|scan|image)\b/i.test(title)) return false
  if (/\.(pdf|epub|docx?|fb2|txt|html?|rtf|odt)$/i.test(title)) return false
  return /[A-Za-z\u00C0-\u024F]/.test(title)
}

export function looksLikeAuthorName(raw: string): boolean {
  const author = raw.replace(/\s+/g, ' ').trim()
  if (author.length < 2 || author.length > 80) return false
  if (/^(unknown|anonymous|n\/?a)$/i.test(author)) return false
  return /[A-Za-z\u00C0-\u024F]/.test(author)
}

export function decodeXmlText(raw: string): string {
  return raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, ' ')
    .trim()
}
