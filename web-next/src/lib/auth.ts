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
/** Survives clearAuth so the login form can prefill after a forced sign-out. */
const LAST_EMAIL_KEY = 'reader-tts-last-email'

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
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<AuthUser>
    if (typeof parsed?.id === 'string' && typeof parsed?.email === 'string') {
      return { id: parsed.id, email: parsed.email }
    }
    return null
  } catch {
    return null
  }
}

function notify() {
  for (const listener of listeners) listener(cachedUser)
}

function isAuthPayload(value: unknown): value is AuthPayload {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<AuthPayload>
  return (
    typeof v.token === 'string'
    && v.token.length > 0
    && !!v.user
    && typeof v.user.id === 'string'
    && typeof v.user.email === 'string'
  )
}

function persistAuth(payload: AuthPayload) {
  cachedUser = payload.user
  window.localStorage.setItem(TOKEN_KEY, payload.token)
  window.localStorage.setItem(USER_KEY, JSON.stringify(payload.user))
  window.localStorage.setItem(LAST_EMAIL_KEY, payload.user.email)
  setCachedToken(payload.token)
  notify()
  return payload.user
}

/** Normalize credentials the same way the Worker does (trim + lower email). */
export function normalizeEmail(email: string) {
  return email.trim().toLowerCase()
}

export function getLastUsedEmail() {
  if (typeof window === 'undefined') return ''
  try {
    return window.localStorage.getItem(LAST_EMAIL_KEY) ?? ''
  } catch {
    return ''
  }
}

export function subscribeAuth(listener: (user: AuthUser | null) => void) {
  listeners.add(listener)
  // Immediately sync subscriber with current user (prefetch / shell).
  listener(cachedUser)
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

async function parseAuthPayload(res: Response): Promise<AuthPayload> {
  let body: unknown
  try {
    body = await res.json()
  } catch {
    throw new AuthApiError('Auth service returned an invalid response.', res.status || 500)
  }
  if (!isAuthPayload(body)) {
    throw new AuthApiError('Auth service returned an invalid response.', res.status || 500)
  }
  return body
}

export async function signIn(email: string, password: string) {
  // Drop any stale token first so a half-broken previous session cannot
  // interfere with the new login response or follow-up /session calls.
  clearAuth({ keepLastEmail: true })
  const res = await authFetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: normalizeEmail(email), password }),
  })
  if (!res.ok) throw classifyAuthError(res.status, await errorMessage(res))
  return persistAuth(await parseAuthPayload(res))
}

export async function signUp(email: string, password: string) {
  clearAuth({ keepLastEmail: true })
  const res = await authFetch('/api/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: normalizeEmail(email), password }),
  })
  if (!res.ok) throw classifyAuthError(res.status, await errorMessage(res))
  return persistAuth(await parseAuthPayload(res))
}

export async function restoreSession() {
  const token = getStoredAuthToken()
  if (!token) {
    clearAuth({ keepLastEmail: true })
    return null
  }
  setCachedToken(token)
  let res: Response
  try {
    res = await authFetch('/api/auth/session', {
      headers: { Authorization: `Bearer ${token}` },
    })
  } catch {
    // Transient network/CORS failure: keep the token so a brief offline blip
    // does not force a full re-login. Router still treats null as logged out.
    return null
  }
  if (!res.ok) {
    // 401/403 etc. — token is dead; clear it.
    clearAuth({ keepLastEmail: true })
    return null
  }
  let payload: { user?: AuthUser }
  try {
    payload = await res.json() as { user?: AuthUser }
  } catch {
    clearAuth({ keepLastEmail: true })
    return null
  }
  if (!payload.user?.id || !payload.user?.email) {
    clearAuth({ keepLastEmail: true })
    return null
  }
  cachedUser = payload.user
  window.localStorage.setItem(USER_KEY, JSON.stringify(payload.user))
  window.localStorage.setItem(LAST_EMAIL_KEY, payload.user.email)
  notify()
  return payload.user
}

export async function signOut() {
  const token = getStoredAuthToken()
  if (token) {
    await authFetch('/api/auth/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => undefined)
  }
  clearAuth({ keepLastEmail: true })
}

export function clearAuth(options?: { keepLastEmail?: boolean }) {
  const keepLastEmail = options?.keepLastEmail === true
  const lastEmail = keepLastEmail
    ? (cachedUser?.email || getLastUsedEmail())
    : ''
  cachedUser = null
  setCachedToken('')
  if (typeof window !== 'undefined') {
    window.localStorage.removeItem(TOKEN_KEY)
    window.localStorage.removeItem(USER_KEY)
    if (keepLastEmail && lastEmail) {
      window.localStorage.setItem(LAST_EMAIL_KEY, lastEmail)
    } else if (!keepLastEmail) {
      window.localStorage.removeItem(LAST_EMAIL_KEY)
    }
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
