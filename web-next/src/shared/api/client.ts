export class AuthError extends Error {}

// Cached bearer token, kept fresh by the custom auth client.
let _cachedToken = ''

export function setCachedToken(token: string) {
  _cachedToken = token
}

function getToken() {
  return _cachedToken
}

async function readSessionToken() {
  if (typeof window === 'undefined') return getToken()
  const { getStoredAuthToken } = await import('@/lib/auth')
  const token = getStoredAuthToken()
  if (token !== _cachedToken) {
    setCachedToken(token)
  }
  return token
}

async function refreshSessionToken(previousToken: string) {
  return previousToken
}

function configuredApiOrigin() {
  const configured = import.meta.env.VITE_API_ORIGIN?.trim()
  return configured ? configured.replace(/\/$/, '') : ''
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

function shouldUseDirectBookUpload() {
  return import.meta.env.VITE_ENABLE_DIRECT_UPLOAD === 'true'
}

export const BOOK_ACCEPT = [
  '.pdf',
  '.epub',
  '.txt',
  '.md',
  '.markdown',
  '.html',
  '.htm',
  '.xhtml',
  '.docx',
].join(',')

const BOOK_CONTENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  epub: 'application/epub+zip',
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  html: 'text/html',
  htm: 'text/html',
  xhtml: 'application/xhtml+xml',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}

export function isSupportedBookFile(file: File) {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? ''
  return extension in BOOK_CONTENT_TYPES
}

function contentTypeForBook(file: File) {
  if (file.type && file.type !== 'application/octet-stream') return file.type
  const extension = file.name.split('.').pop()?.toLowerCase() ?? ''
  return BOOK_CONTENT_TYPES[extension] ?? 'application/octet-stream'
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

interface DirectBookUploadInitResponse {
  bookId: string
  upload: {
    url: string
    fields: Record<string, string>
  }
}

async function uploadBookDirect(file: File, title?: string | null) {
  const init = await request<DirectBookUploadInitResponse>('/api/books/direct-upload', {
    method: 'POST',
    body: JSON.stringify({
      fileName: file.name,
      contentType: contentTypeForBook(file),
      size: file.size,
      title: title?.trim() || null,
    }),
  })

  const formData = new FormData()
  for (const [key, value] of Object.entries(init.upload.fields)) {
    formData.append(key, value)
  }
  formData.append('file', file)

  const uploadResponse = await fetch(init.upload.url, {
    method: 'POST',
    body: formData,
  })
  if (!uploadResponse.ok) {
    const detail = await uploadResponse.text().catch(() => uploadResponse.statusText)
    throw new Error(`Direct upload failed (${uploadResponse.status}): ${detail || uploadResponse.statusText}`)
  }

  return request<Book>('/api/books/direct-upload/complete', {
    method: 'POST',
    body: JSON.stringify({
      bookId: init.bookId,
      fileName: file.name,
      title: title?.trim() || null,
    }),
  })
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

export async function uploadBook(file: File, title?: string | null) {
  if (shouldUseDirectBookUpload()) {
    return uploadBookDirect(file, title)
  }

  const formData = new FormData()
  formData.append('file', file)
  if (title?.trim()) {
    formData.append('title', title.trim())
  }

  return request<Book>('/api/books', {
    method: 'POST',
    body: formData,
  })
}
