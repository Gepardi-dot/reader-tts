export interface CoverSearchTerms {
  title: string
  author?: string
}

const MAX_COVER_SEARCH_TERMS = 3
const COVER_LOOKUP_TIMEOUT_MS = 2500
const COVER_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const COVER_CACHE_PREFIX = 'reader-tts-cover:'

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

function looksLikeAuthorName(raw: string) {
  const tokens = raw.split(' ').filter(Boolean)
  if (tokens.length < 2 || tokens.length > 3) return false
  return tokens.every((token) => /^[A-Za-z][A-Za-z'.-]*$/.test(token))
}

function displayAuthor(raw: string) {
  return raw.split(' ').map(titleCaseToken).join(' ')
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

export function coverSearchTermsForBook(title: string, fileName?: string): CoverSearchTerms[] {
  const sources = uniqueTerms([
    { title },
    fileName ? { title: fileName } : { title: '' },
  ])

  const candidates: CoverSearchTerms[] = []
  for (const source of sources) {
    const normalized = normalizeBookText(splitCamelJoinedWords(source.title))
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
      for (const authorWordCount of [2, 3]) {
        if (tokens.length <= authorWordCount) continue
        const possibleAuthor = tokens.slice(-authorWordCount).join(' ')
        const possibleTitle = tokens.slice(0, -authorWordCount).join(' ')
        if (looksLikeAuthorName(possibleAuthor)) {
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

function coverCacheKey(title: string, fileName?: string) {
  return `${COVER_CACHE_PREFIX}${JSON.stringify([title.trim(), fileName?.trim() ?? ''])}`
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
      expiresAt: Date.now() + COVER_CACHE_TTL_MS,
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

export async function fetchOpenLibraryCover({ title, author }: CoverSearchTerms): Promise<string | null> {
  const params = new URLSearchParams({
    title,
    limit: '1',
    fields: 'cover_i',
  })
  if (author) params.set('author', author)

  const res = await fetchWithTimeout(`https://openlibrary.org/search.json?${params.toString()}`)
  if (!res?.ok) return null

  const data = await res.json() as { docs?: { cover_i?: number }[] }
  const coverId = data.docs?.[0]?.cover_i
  return coverId ? `https://covers.openlibrary.org/b/id/${coverId}-L.jpg` : null
}

export async function findBookCover(title: string, fileName?: string): Promise<string | null> {
  const cacheKey = coverCacheKey(title, fileName)
  const cached = readCachedCover(cacheKey)
  if (cached !== undefined) return cached

  const terms = coverSearchTermsForBook(title, fileName).slice(0, MAX_COVER_SEARCH_TERMS)
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
