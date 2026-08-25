import { api, requestBlob } from '@/shared/api/client'
import { extractIsbnsFromText } from '@/shared/books/bookIdentifiers'
import { blobToDataUrl, compressCover, dataUrlToBlob } from '@/shared/books/extractCover'
import {
  getStoredCover,
  putEmptyCover,
  putStoredCover,
} from '@/shared/storage/coverCache'
import {
  coverSearchTermsForBook,
  findBookCover,
  type CoverQuery,
} from './coverLookup'

export type CoverKind = 'package' | 'pdf-page'

export interface ResolvedBookCover {
  dataUrl: string
  sourceUrl: string | null
  source: 'embedded' | 'lookup' | 'stored'
}

interface CoverSearchResponse {
  url?: string | null
}

const backfillInFlight = new Map<string, Promise<string | null>>()

function isPersistedCover(coverUrl?: string | null) {
  if (coverUrl == null) return 'missing' as const
  if (coverUrl === '') return 'none' as const
  return 'ready' as const
}

async function searchCoverUrl(
  query: CoverQuery,
  options: { isbnOnly?: boolean } = {},
): Promise<string | null> {
  const isbn = query.isbn || extractIsbnsFromText(`${query.title} ${query.fileName ?? ''}`)[0]
  if (isbn) {
    try {
      const found = await api.get<CoverSearchResponse>(
        `/api/covers/search?${new URLSearchParams({ isbn }).toString()}`,
      )
      if (found.url) return found.url
    } catch {
      // Worker search is best-effort; fall through to the browser lookup.
    }
    const byIsbn = await findBookCover({ ...query, isbn }, undefined, { isbnOnly: true })
    if (byIsbn) return byIsbn
    if (options.isbnOnly) return null
  } else if (options.isbnOnly) {
    return null
  }

  const terms = coverSearchTermsForBook(query.title, query.fileName, query.author).slice(0, 3)
  for (const term of terms) {
    try {
      const params = new URLSearchParams({ title: term.title })
      if (term.author) params.set('author', term.author)
      const found = await api.get<CoverSearchResponse>(`/api/covers/search?${params.toString()}`)
      if (found.url) return found.url
    } catch {
      // Worker search is best-effort; fall through to the browser lookup.
    }
  }

  return findBookCover({ ...query, isbn: undefined })
}

async function downloadCoverImage(url: string): Promise<Blob | null> {
  try {
    const params = new URLSearchParams({ url })
    return await requestBlob(`/api/covers/image?${params.toString()}`)
  } catch {
    try {
      const res = await fetch(url, { mode: 'cors', credentials: 'omit' })
      if (!res.ok) return null
      return await res.blob()
    } catch {
      return null
    }
  }
}

export async function lookupRemoteCover(
  title: string,
  fileName?: string,
  extras: Pick<CoverQuery, 'author' | 'isbn'> & { isbnOnly?: boolean } = {},
): Promise<ResolvedBookCover | null> {
  const { isbnOnly, ...queryExtras } = extras
  const sourceUrl = await searchCoverUrl({ title, fileName, ...queryExtras }, { isbnOnly })
  if (!sourceUrl) return null
  const blob = await downloadCoverImage(sourceUrl)
  if (!blob || blob.size < 32) return null
  return {
    dataUrl: await compressCover(blob),
    sourceUrl,
    source: 'lookup',
  }
}

export async function persistBookCover(bookId: string, cover: ResolvedBookCover): Promise<void> {
  try {
    await putStoredCover(bookId, await dataUrlToBlob(cover.dataUrl))
  } catch {
    // Local cache is optional.
  }
  try {
    await api.put(`/api/books/${bookId}/cover`, { coverUrl: cover.dataUrl })
  } catch {
    // API persistence is optional on older backends; the local cache still shows.
  }
}

export async function resolveCoverForUpload(
  file: File,
  title: string,
  embedded?: Blob | null,
  options: {
    author?: string
    isbn?: string
    coverKind?: CoverKind | null
  } = {},
): Promise<ResolvedBookCover | null> {
  const packageCover = options.coverKind === 'package' && embedded && embedded.size > 32
    ? embedded
    : null
  const pageCover = options.coverKind === 'pdf-page' && embedded && embedded.size > 32
    ? embedded
    : !options.coverKind && embedded && embedded.size > 32
      ? embedded
      : null

  const extras = { author: options.author, isbn: options.isbn }
  const byIsbn = await lookupRemoteCover(title, file.name, { ...extras, isbnOnly: true })
  if (byIsbn) {
    if (packageCover && byIsbn.dataUrl.length < 8_000) {
      return {
        dataUrl: await compressCover(packageCover),
        sourceUrl: null,
        source: 'embedded',
      }
    }
    return byIsbn
  }

  if (packageCover) {
    return {
      dataUrl: await compressCover(packageCover),
      sourceUrl: null,
      source: 'embedded',
    }
  }

  const byTitle = await lookupRemoteCover(title, file.name, { author: options.author })
  if (byTitle) return byTitle

  if (pageCover) {
    return {
      dataUrl: await compressCover(pageCover),
      sourceUrl: null,
      source: 'embedded',
    }
  }

  return null
}

export async function loadLibraryCover(book: {
  id: string
  title: string
  fileName: string
  excerpt?: string
  coverUrl?: string | null
}): Promise<string | null> {
  const local = await getStoredCover(book.id)
  if (local?.blob) return blobToDataUrl(local.blob)
  if (local?.empty) return null

  const state = isPersistedCover(book.coverUrl)
  if (state === 'none') {
    await putEmptyCover(book.id)
    return null
  }

  if (state === 'ready' && book.coverUrl) {
    if (book.coverUrl.startsWith('data:')) {
      try {
        await putStoredCover(book.id, await dataUrlToBlob(book.coverUrl))
      } catch {
        // Display the persisted data URL even if IDB write fails.
      }
      return book.coverUrl
    }
    try {
      const blob = await requestBlob(`/api/books/${book.id}/cover`)
      await putStoredCover(book.id, blob)
      return blobToDataUrl(blob)
    } catch {
      // Fall through to a one-time internet lookup for older rows.
    }
  }

  const existing = backfillInFlight.get(book.id)
  if (existing) return existing

  const task = (async () => {
    const isbn = extractIsbnsFromText(`${book.title} ${book.fileName} ${book.excerpt ?? ''}`)[0]
    const found = await lookupRemoteCover(book.title, book.fileName, { isbn })
    if (!found) {
      await putEmptyCover(book.id)
      try {
        await api.put(`/api/books/${book.id}/cover`, { coverUrl: '' })
      } catch {
        // Marking "no cover" is best-effort.
      }
      return null
    }
    await persistBookCover(book.id, found)
    return found.dataUrl
  })()

  backfillInFlight.set(book.id, task)
  try {
    return await task
  } finally {
    backfillInFlight.delete(book.id)
  }
}
