export class AuthError extends Error {}

// Cached JWT, kept fresh by the Supabase auth state listener in main.tsx
let _cachedToken = ''

export function setCachedToken(token: string) {
  _cachedToken = token
}

function getToken() {
  return _cachedToken
}

export async function request<T = unknown>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const token = getToken()
  const headers = new Headers(options.headers)
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (!headers.has('Content-Type') && options.body && typeof options.body === 'string') {
    headers.set('Content-Type', 'application/json')
  }

  const res = await fetch(url, { ...options, headers })

  if (res.status === 401) throw new AuthError('Unauthorized')
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`${res.status}: ${text}`)
  }

  const contentType = res.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) return res.json() as Promise<T>
  return res.text() as unknown as T
}

export const api = {
  get: <T>(url: string) => request<T>(url),
  post: <T>(url: string, body: unknown) =>
    request<T>(url, { method: 'POST', body: JSON.stringify(body) }),
  delete: <T>(url: string) => request<T>(url, { method: 'DELETE' }),
  patch: <T>(url: string, body: unknown) =>
    request<T>(url, { method: 'PATCH', body: JSON.stringify(body) }),
}
