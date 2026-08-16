import { setCachedToken } from '@/shared/api/authToken'
import {
  looksLikeMissingApi,
  resolveApiUrl,
} from '@/shared/api/apiOrigin'

export interface AuthUser {
  id: string
  email: string
}

interface AuthPayload {
  token: string
  user: AuthUser
  expiresAt?: number
}

const TOKEN_KEY = 'reader-tts-auth-token'
const USER_KEY = 'reader-tts-auth-user'

let cachedUser: AuthUser | null = readStoredUser()
const listeners = new Set<(user: AuthUser | null) => void>()

const API_UNREACHABLE_MESSAGE =
  'Could not reach the auth service. Check your connection, hard-refresh, and try again. If this keeps happening, open https://readertts.vercel.app (not a Vercel preview SSO URL).'

function resolveUrl(url: string) {
  return resolveApiUrl(url)
}

function readStoredUser(): AuthUser | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(USER_KEY)
    return raw ? JSON.parse(raw) as AuthUser : null
  } catch {
    return null
  }
}

function notify() {
  for (const listener of listeners) listener(cachedUser)
}

function persistAuth(payload: AuthPayload) {
  cachedUser = payload.user
  window.localStorage.setItem(TOKEN_KEY, payload.token)
  window.localStorage.setItem(USER_KEY, JSON.stringify(payload.user))
  setCachedToken(payload.token)
  notify()
  return payload.user
}

export function subscribeAuth(listener: (user: AuthUser | null) => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getStoredAuthToken() {
  if (typeof window === 'undefined') return ''
  return window.localStorage.getItem(TOKEN_KEY) ?? ''
}

export function getStoredUser() {
  return cachedUser
}

export function hasAuthToken() {
  return Boolean(getStoredAuthToken())
}

export class AuthApiError extends Error {
  status: number
  code?: 'email_taken' | 'invalid_credentials' | 'auth_required' | 'api_unreachable'

  constructor(
    message: string,
    status: number,
    code?: 'email_taken' | 'invalid_credentials' | 'auth_required' | 'api_unreachable',
  ) {
    super(message)
    this.name = 'AuthApiError'
    this.status = status
    this.code = code
  }
}

function classifyAuthError(status: number, message: string): AuthApiError {
  const lower = message.toLowerCase()
  if (
    status === 409
    || /already (exists|registered)|email is already|account already/i.test(lower)
  ) {
    return new AuthApiError(
      'This email is already registered. Sign in with your password to keep your books and vocabulary.',
      status === 409 ? 409 : status,
      'email_taken',
    )
  }
  if (status === 401 || /invalid email or password/i.test(lower)) {
    return new AuthApiError(
      'Invalid email or password. If you already have an account, use Sign in — do not create a new one.',
      status || 401,
      'invalid_credentials',
    )
  }
  if (
    status === 0
    || looksLikeMissingApi(status, message)
    || /failed to fetch|networkerror|load failed|cors/i.test(lower)
  ) {
    return new AuthApiError(API_UNREACHABLE_MESSAGE, status || 0, 'api_unreachable')
  }
  if (/authentication required/i.test(lower)) {
    return new AuthApiError(
      'Could not reach the auth service. Hard-refresh the page and try again. Use Sign in if you already have an account.',
      status || 401,
      'auth_required',
    )
  }
  return new AuthApiError(message || 'Something went wrong.', status || 500)
}

async function authFetch(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(resolveUrl(path), init)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch'
    throw classifyAuthError(0, message)
  }
}

export async function signIn(email: string, password: string) {
  const res = await authFetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!res.ok) throw classifyAuthError(res.status, await errorMessage(res))
  return persistAuth(await res.json() as AuthPayload)
}

export async function signUp(email: string, password: string) {
  const res = await authFetch('/api/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!res.ok) throw classifyAuthError(res.status, await errorMessage(res))
  return persistAuth(await res.json() as AuthPayload)
}

export async function restoreSession() {
  const token = getStoredAuthToken()
  if (!token) {
    clearAuth()
    return null
  }
  setCachedToken(token)
  let res: Response
  try {
    res = await fetch(resolveUrl('/api/auth/session'), {
      headers: { Authorization: `Bearer ${token}` },
    })
  } catch {
    // Network/CORS failure: treat as logged out so the router can send users to /login
    // with a recoverable state instead of hanging on "Loading…".
    clearAuth()
    return null
  }
  if (!res.ok) {
    clearAuth()
    return null
  }
  const payload = await res.json() as { user: AuthUser }
  cachedUser = payload.user
  window.localStorage.setItem(USER_KEY, JSON.stringify(payload.user))
  notify()
  return payload.user
}

export async function signOut() {
  const token = getStoredAuthToken()
  if (token) {
    await fetch(resolveUrl('/api/auth/logout'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => undefined)
  }
  clearAuth()
}

export function clearAuth() {
  cachedUser = null
  setCachedToken('')
  if (typeof window !== 'undefined') {
    window.localStorage.removeItem(TOKEN_KEY)
    window.localStorage.removeItem(USER_KEY)
  }
  notify()
}

async function errorMessage(res: Response) {
  const text = await res.text().catch(() => '')
  if (!text) return res.statusText || 'Request failed'
  try {
    const parsed = JSON.parse(text) as { detail?: string; message?: string }
    return parsed.detail ?? parsed.message ?? text
  } catch {
    return text
  }
}
