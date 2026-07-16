import { getCachedToken, setCachedToken } from '@/shared/api/authToken'
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

/**
 * API origin:
 * - empty / "relative" → same-origin `/api` (Cloudflare unified Worker+SPA — preferred)
 * - absolute URL → cross-origin API (e.g. Vercel UI talking to Worker)
 */
const FALLBACK_ABSOLUTE_API = 'https://reader-tts-api.reader-tts-ari.workers.dev'

function configuredApiOrigin() {
  const raw = import.meta.env.VITE_API_ORIGIN as string | undefined
  if (raw === 'relative' || raw === 'same-origin') return ''
  const fromEnv = typeof raw === 'string' ? raw.trim() : ''
  if (fromEnv) return fromEnv.replace(/\/$/, '')
  if (import.meta.env.DEV) return ''
  if (import.meta.env.PROD && import.meta.env.VITE_API_MODE === 'absolute') {
    return FALLBACK_ABSOLUTE_API
  }
  return ''
}

function resolveUrl(url: string) {
  return url.startsWith('http') ? url : `${configuredApiOrigin()}${url}`
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

export const BOOK_ACCEPT = [
  '.pdf',
  '.txt',
  '.md',
  '.markdown',
  '.html',
  '.htm',
  '.xhtml',
].join(',')

const BOOK_CONTENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  html: 'text/html',
  htm: 'text/html',
  xhtml: 'application/xhtml+xml',
}

export function isSupportedBookFile(file: File) {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? ''
  return extension in BOOK_CONTENT_TYPES
}

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
}

interface UploadBookOptions {
  onProgress?: (progress: BookExtractionProgress) => void
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

export async function uploadBook(file: File, title?: string | null, options: UploadBookOptions = {}) {
  const { extractBookText } = await import('@/shared/books/extractBookText')
  const payload = await extractBookText(file, { title, onProgress: options.onProgress })
  options.onProgress?.({ phase: 'uploading', progress: 100, message: 'Saving book...' })

  return request<Book>('/api/books', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}
