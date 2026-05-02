export interface CoverSearchTerms {
  title: string
  author?: string
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

export async function fetchOpenLibraryCover({ title, author }: CoverSearchTerms): Promise<string | null> {
  const params = new URLSearchParams({
    title,
    limit: '1',
    fields: 'cover_i',
  })
  if (author) params.set('author', author)

  const res = await fetch(`https://openlibrary.org/search.json?${params.toString()}`)
  if (!res.ok) return null

  const data = await res.json() as { docs?: { cover_i?: number }[] }
  const coverId = data.docs?.[0]?.cover_i
  return coverId ? `https://covers.openlibrary.org/b/id/${coverId}-L.jpg` : null
}

export async function fetchGoogleBooksCover({ title, author }: CoverSearchTerms): Promise<string | null> {
  const query = author ? `intitle:${title} inauthor:${author}` : title
  const params = new URLSearchParams({
    q: query,
    maxResults: '5',
    fields: 'items(volumeInfo(imageLinks))',
  })

  const res = await fetch(`https://www.googleapis.com/books/v1/volumes?${params.toString()}`)
  if (!res.ok) return null

  const data = await res.json() as {
    items?: { volumeInfo?: { imageLinks?: { thumbnail?: string; smallThumbnail?: string } } }[]
  }
  const raw = data.items
    ?.map((item) => item.volumeInfo?.imageLinks?.thumbnail ?? item.volumeInfo?.imageLinks?.smallThumbnail)
    .find(Boolean)

  return raw
    ? raw.replace('http://', 'https://').replace('&edge=curl', '').replace('zoom=1', 'zoom=2')
    : null
}

export async function findBookCover(title: string, fileName?: string): Promise<string | null> {
  const terms = coverSearchTermsForBook(title, fileName)
  for (const term of terms) {
    const coverUrl = await fetchOpenLibraryCover(term) ?? await fetchGoogleBooksCover(term)
    if (coverUrl) return coverUrl
  }
  return null
}
