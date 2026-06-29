import { setCachedToken } from '@/shared/api/client'

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

function configuredApiOrigin() {
  const configured = import.meta.env.VITE_API_ORIGIN?.trim()
  return configured ? configured.replace(/\/$/, '') : ''
}

function resolveUrl(url: string) {
  return url.startsWith('http') ? url : `${configuredApiOrigin()}${url}`
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

export async function signIn(email: string, password: string) {
  const res = await fetch(resolveUrl('/api/auth/login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!res.ok) throw new Error(await errorMessage(res))
  return persistAuth(await res.json() as AuthPayload)
}

export async function signUp(email: string, password: string, inviteCode: string) {
  const res = await fetch(resolveUrl('/api/auth/signup'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, inviteCode: inviteCode.trim() || null }),
  })
  if (!res.ok) throw new Error(await errorMessage(res))
  return persistAuth(await res.json() as AuthPayload)
}

export async function restoreSession() {
  const token = getStoredAuthToken()
  if (!token) {
    clearAuth()
    return null
  }
  setCachedToken(token)
  const res = await fetch(resolveUrl('/api/auth/session'), {
    headers: { Authorization: `Bearer ${token}` },
  })
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
