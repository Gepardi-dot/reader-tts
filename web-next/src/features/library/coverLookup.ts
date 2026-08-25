import { canonicalIsbn, extractIsbnsFromText } from '@/shared/books/bookIdentifiers'

export interface CoverSearchTerms {
  title: string
  author?: string
}

export interface CoverQuery {
  title: string
  fileName?: string
  author?: string
  isbn?: string
}

const MAX_COVER_SEARCH_TERMS = 5
const COVER_LOOKUP_TIMEOUT_MS = 6000
const COVER_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const EMPTY_COVER_CACHE_TTL_MS = 10 * 60 * 1000
const COVER_CACHE_PREFIX = 'reader-tts-cover:'
const AUTHOR_SUFFIXES = new Set([
  'phd', 'ph.d', 'ph.d.', 'md', 'jr', 'jr.', 'sr', 'sr.',
  'ii', 'iii', 'iv', 'esq', 'esq.',
])

function stripHonorifics(raw: string): string {
  return raw.replace(/\b(Ph\.?\s*D\.?|M\.?D\.?|Jr\.?|Sr\.?|Esq\.?|II|III|IV)\b/gi, ' ')
}

function normalizeBookText(raw: string): string {
  return raw
    .replace(/\.[A-Za-z0-9]+$/, '')
    .replace(/\[[\d\s]*\]/g, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function splitCamelJoinedWords(raw: string): string {
  return raw
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^(\d{4})(?=[A-Za-z])/, '')
}

function titleCaseToken(token: string) {
  return token ? `${token[0].toUpperCase()}${token.slice(1).toLowerCase()}` : token
}

function isAuthorSuffix(token: string) {
  return AUTHOR_SUFFIXES.has(token.toLowerCase())
}

function looksLikeAuthorName(raw: string) {
  const tokens = raw.split(' ').filter(Boolean)
  const meaningful = tokens.filter((token) => !isAuthorSuffix(token))
  if (meaningful.length < 2 || meaningful.length > 3) return false
  // "B. Cialdini" is a leftover slice, not a full author name.
  if (meaningful.length === 2 && /^[A-Za-z]\.?$/.test(meaningful[0])) return false
  return meaningful.every((token) => (
    /^[A-Za-z][A-Za-z'.-]*$/.test(token) || /^[A-Za-z]\.$/.test(token)
  ))
}

function displayAuthor(raw: string) {
  return raw
    .split(' ')
    .filter((token) => token && !isAuthorSuffix(token))
    .map(titleCaseToken)
    .join(' ')
}

function uniqueTerms(terms: CoverSearchTerms[]) {
  const seen = new Set<string>()
  return terms.filter((term) => {
    const title = term.title.trim()
    if (title.length < 2) return false
    const key = `${title.toLowerCase()}::${term.author?.toLowerCase() ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    term.title = title
    if (term.author) term.author = term.author.trim()
    return true
  })
}

export function coverSearchTermsForBook(
  title: string,
  fileName?: string,
  author?: string,
): CoverSearchTerms[] {
  const sources = uniqueTerms([
    author ? { title, author } : { title },
    { title },
    fileName ? { title: fileName } : { title: '' },
  ])

  const candidates: CoverSearchTerms[] = []
  for (const source of sources) {
    const normalized = normalizeBookText(splitCamelJoinedWords(stripHonorifics(source.title)))
    if (!normalized) continue

    candidates.push({ title: normalized })

    const byParts = normalized.split(/\s+by\s+/i).filter(Boolean)
    if (byParts.length >= 2) {
      candidates.push({
        title: byParts[0].trim(),
        author: byParts.slice(1).join(' by ').trim(),
      })
    }

    const tokens = normalized.split(' ').filter(Boolean)
    if (tokens.length > 2) {
      for (const authorWordCount of [2, 3, 4]) {
        if (tokens.length <= authorWordCount) continue
        const possibleAuthor = tokens.slice(-authorWordCount).join(' ')
        const possibleTitle = tokens.slice(0, -authorWordCount).join(' ')
        if (looksLikeAuthorName(possibleAuthor) && possibleTitle.length >= 2) {
          candidates.push({
            title: possibleTitle,
            author: displayAuthor(possibleAuthor),
          })
        }
      }
    }
  }

  return uniqueTerms(candidates)
}

function coverCacheKey(query: CoverQuery) {
  return `${COVER_CACHE_PREFIX}${JSON.stringify([
    query.title.trim(),
    query.fileName?.trim() ?? '',
    query.author?.trim() ?? '',
    query.isbn?.trim() ?? '',
  ])}`
}

function normalizeCoverTitle(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

export function titlesCompatible(query: string, found: string) {
  const a = normalizeCoverTitle(query)
  const b = normalizeCoverTitle(found)
  if (!a || !b) return true
  if (a === b || a.includes(b) || b.includes(a)) return true
  const queryWords = a.split(' ').filter((word) => word.length > 2)
  if (queryWords.length === 0) return true
  const foundWords = new Set(b.split(' ').filter((word) => word.length > 2))
  const hits = queryWords.filter((word) => foundWords.has(word)).length
  return hits >= Math.ceil(Math.min(queryWords.length, 3) * 0.5)
}

function coverCacheStorage() {
  if (typeof window === 'undefined') return null
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

function readCachedCover(key: string): string | null | undefined {
  const storage = coverCacheStorage()
  if (!storage) return undefined
  try {
    const raw = storage.getItem(key)
    if (!raw) return undefined
    const cached = JSON.parse(raw) as { url: string | null; expiresAt: number }
    if (!cached.expiresAt || cached.expiresAt < Date.now()) {
      storage.removeItem(key)
      return undefined
    }
    return cached.url ?? null
  } catch {
    return undefined
  }
}

function writeCachedCover(key: string, url: string | null) {
  const storage = coverCacheStorage()
  if (!storage) return
  try {
    storage.setItem(key, JSON.stringify({
      url,
      expiresAt: Date.now() + (url ? COVER_CACHE_TTL_MS : EMPTY_COVER_CACHE_TTL_MS),
    }))
  } catch {
    // Cover lookup is cosmetic; storage failures should not affect library load.
  }
}

async function fetchWithTimeout(url: string) {
  const ctrl = new AbortController()
  const timer = globalThis.setTimeout(() => ctrl.abort(), COVER_LOOKUP_TIMEOUT_MS)
  try {
    return await fetch(url, { signal: ctrl.signal })
  } catch {
    return null
  } finally {
    globalThis.clearTimeout(timer)
  }
}

function coverIdUrl(coverId: number) {
  return `https://covers.openlibrary.org/b/id/${coverId}-L.jpg`
}

export async function fetchOpenLibraryCoverByIsbn(isbn: string): Promise<string | null> {
  const compact = canonicalIsbn(isbn) ?? compactIsbnFallback(isbn)
  if (!compact) return null

  const edition = await fetchWithTimeout(`https://openlibrary.org/isbn/${compact}.json`)
  if (edition?.ok) {
    const data = await edition.json() as { covers?: number[] }
    const coverId = data.covers?.find((id) => id > 0)
    if (coverId) return coverIdUrl(coverId)
  }

  const search = await fetchWithTimeout(
    `https://openlibrary.org/search.json?isbn=${encodeURIComponent(compact)}&limit=1&fields=cover_i`,
  )
  if (!search?.ok) return null
  const data = await search.json() as { docs?: { cover_i?: number }[] }
  const coverId = data.docs?.[0]?.cover_i
  return coverId ? coverIdUrl(coverId) : null
}

function compactIsbnFallback(raw: string) {
  const compact = raw.replace(/[^0-9Xx]/g, '').toUpperCase()
  return compact.length >= 10 ? compact : null
}

export async function fetchOpenLibraryCover({ title, author }: CoverSearchTerms): Promise<string | null> {
  const params = new URLSearchParams({
    title,
    limit: '8',
    fields: 'cover_i,title,author_name',
  })
  if (author) params.set('author', author)

  const res = await fetchWithTimeout(`https://openlibrary.org/search.json?${params.toString()}`)
  if (!res?.ok) return null

  const data = await res.json() as { docs?: { cover_i?: number; title?: string }[] }
  const docs = data.docs ?? []
  const match = docs.find((doc) => doc.cover_i && titlesCompatible(title, doc.title ?? ''))
  return match?.cover_i ? coverIdUrl(match.cover_i) : null
}

function asCoverQuery(query: CoverQuery | string, fileName?: string): CoverQuery {
  return typeof query === 'string' ? { title: query, fileName } : query
}

export async function findBookCover(
  query: CoverQuery | string,
  fileName?: string,
  options: { isbnOnly?: boolean } = {},
): Promise<string | null> {
  const q = asCoverQuery(query, fileName)
  const isbn = q.isbn || extractIsbnsFromText(`${q.title} ${q.fileName ?? ''}`)[0]
  const cacheKey = coverCacheKey({ ...q, isbn })
  const cached = readCachedCover(cacheKey)
  if (cached !== undefined && !options.isbnOnly) return cached

  if (isbn) {
    const byIsbn = await fetchOpenLibraryCoverByIsbn(isbn)
    if (byIsbn) {
      writeCachedCover(cacheKey, byIsbn)
      return byIsbn
    }
    if (options.isbnOnly) return null
  } else if (options.isbnOnly) {
    return null
  }

  const terms = coverSearchTermsForBook(q.title, q.fileName, q.author).slice(0, MAX_COVER_SEARCH_TERMS)
  for (const term of terms) {
    const coverUrl = await fetchOpenLibraryCover(term)
    if (coverUrl) {
      writeCachedCover(cacheKey, coverUrl)
      return coverUrl
    }
  }

  writeCachedCover(cacheKey, null)
  return null
}
