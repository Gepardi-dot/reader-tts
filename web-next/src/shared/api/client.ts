import { getCachedToken, setCachedToken } from '@/shared/api/authToken'
import { resolveApiUrl } from '@/shared/api/apiOrigin'
import type { BookExtractionProgress } from '@/shared/books/extractBookText'

export class AuthError extends Error {}

function getToken() {
  return getCachedToken()
}

async function readSessionToken() {
  if (typeof window === 'undefined') return getToken()
  const { getStoredAuthToken } = await import('@/lib/auth')
  const token = getStoredAuthToken()
  if (token !== getCachedToken()) {
    setCachedToken(token)
  }
  return token
}

async function refreshSessionToken(previousToken: string) {
  return previousToken
}

function resolveUrl(url: string) {
  return resolveApiUrl(url)
}

export async function request<T = unknown>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  let token = getToken() || await readSessionToken()
  const headers = new Headers(options.headers)
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (!headers.has('Content-Type') && options.body && typeof options.body === 'string') {
    headers.set('Content-Type', 'application/json')
  }

  let res = await fetch(resolveUrl(url), { ...options, headers })

  if (res.status === 401) {
    const refreshedToken = await refreshSessionToken(token)
    if (refreshedToken && refreshedToken !== token) {
      token = refreshedToken
      headers.set('Authorization', `Bearer ${token}`)
      res = await fetch(resolveUrl(url), { ...options, headers })
    }
  }

  if (res.status === 401) throw new AuthError('Unauthorized')
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`${res.status}: ${text}`)
  }

  const contentType = res.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) return res.json() as Promise<T>
  return res.text() as unknown as T
}

export async function requestBlob(
  url: string,
  options: RequestInit = {},
): Promise<Blob> {
  let token = getToken() || await readSessionToken()
  const headers = new Headers(options.headers)
  if (token) headers.set('Authorization', `Bearer ${token}`)

  let res = await fetch(resolveUrl(url), { ...options, headers })

  if (res.status === 401) {
    const refreshedToken = await refreshSessionToken(token)
    if (refreshedToken && refreshedToken !== token) {
      token = refreshedToken
      headers.set('Authorization', `Bearer ${token}`)
      res = await fetch(resolveUrl(url), { ...options, headers })
    }
  }

  if (res.status === 401) throw new AuthError('Unauthorized')
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`${res.status}: ${text}`)
  }

  return res.blob()
}

export {
  bookAcceptAttribute as BOOK_ACCEPT_LIST,
  bookFileInputAccept,
  bookFormatsHelpText,
  isSupportedBookFile,
  unsupportedBookMessage,
} from '@/shared/books/bookFormats'

/** Value for <input accept>. Kept as a string for existing imports. */
export const BOOK_ACCEPT = [
  '.pdf',
  '.epub',
  '.docx',
  '.odt',
  '.rtf',
  '.fb2',
  '.txt',
  '.text',
  '.md',
  '.markdown',
  '.html',
  '.htm',
  '.xhtml',
  '.csv',
  '.tsv',
  '.json',
  '.rst',
  '.org',
  '.log',
  'application/pdf',
  'application/epub+zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.oasis.opendocument.text',
  'application/rtf',
  'text/plain',
  'text/markdown',
  'text/html',
  'text/csv',
  'application/json',
].join(',')


interface Book {
  id: string
  title: string
  fileName: string
  uploadedAt: string
  pageCount: number
  textCharacters: number
  sourceUrl: string
  excerpt: string
  highlightCount: number
  /** data: URL, remote URL, 'stored', or '' when lookup already found nothing. */
  coverUrl?: string | null
}

interface UploadBookOptions {
  onProgress?: (progress: BookExtractionProgress) => void
  /**
   * When true (default), every upload is normalized through the built-in
   * any-format → EPUB pipeline, then text is saved for reading/TTS.
   * Set false only for tests that need the raw extractor.
   */
  convertToEpub?: boolean
}

export interface UploadBookResult {
  book: Book
  epub?: {
    fileName: string
    chapterCount: number
    /** Present when convertToEpub ran; not kept after download helper uses it */
    blob?: Blob
  }
}

export const api = {
  get: <T>(url: string) => request<T>(url),
  post: <T>(url: string, body: unknown) =>
    request<T>(url, { method: 'POST', body: JSON.stringify(body) }),
  put: <T>(url: string, body: unknown) =>
    request<T>(url, { method: 'PUT', body: JSON.stringify(body) }),
  delete: <T>(url: string) => request<T>(url, { method: 'DELETE' }),
  patch: <T>(url: string, body: unknown) =>
    request<T>(url, { method: 'PATCH', body: JSON.stringify(body) }),
}

/**
 * Import a book: convert any supported format → EPUB → save text to the API.
 * Reading/TTS still uses extracted plain text (fast path).
 */
export async function uploadBook(
  file: File,
  title?: string | null,
  options: UploadBookOptions = {},
): Promise<UploadBookResult> {
  const convert = options.convertToEpub !== false

  let payload: {
    title: string
    fileName: string
    text: string
    pageCount: number
    sourceFormat: string
    cover?: Blob | null
    coverKind?: 'package' | 'pdf-page'
    isbn?: string
    author?: string
  }
  let epubMeta: UploadBookResult['epub']
  let resolvedCover: { dataUrl: string; sourceUrl: string | null; source: 'embedded' | 'lookup' | 'stored' } | null = null

  if (convert) {
    const { convertFileToEpub } = await import('@/shared/books/convertToEpub')
    const result = await convertFileToEpub(file, {
      title,
      onProgress: options.onProgress,
    })
    payload = result.book
    resolvedCover = result.resolvedCover ?? null
    epubMeta = {
      fileName: result.epub.fileName,
      chapterCount: result.epub.chapterCount,
      blob: result.epub.blob,
    }
  } else {
    const { extractBookText } = await import('@/shared/books/extractBookText')
    payload = await extractBookText(file, { title, onProgress: options.onProgress })
  }

  options.onProgress?.({ phase: 'uploading', progress: 96, message: 'Saving cover...' })
  const { persistBookCover, resolveCoverForUpload } = await import('@/features/library/resolveBookCover')
  const cover = resolvedCover ?? await resolveCoverForUpload(file, payload.title, payload.cover, {
    author: payload.author,
    isbn: payload.isbn,
    coverKind: payload.coverKind,
  })

  options.onProgress?.({ phase: 'uploading', progress: 100, message: 'Saving book...' })

  const book = await request<Book>('/api/books', {
    method: 'POST',
    body: JSON.stringify({
      title: payload.title,
      fileName: payload.fileName,
      text: payload.text,
      pageCount: payload.pageCount,
      sourceFormat: payload.sourceFormat,
      ...(cover ? { coverUrl: cover.dataUrl } : {}),
    }),
  })

  if (cover) {
    await persistBookCover(book.id, cover)
  }

  return { book: { ...book, coverUrl: cover?.dataUrl ?? book.coverUrl ?? null }, epub: epubMeta }
}
