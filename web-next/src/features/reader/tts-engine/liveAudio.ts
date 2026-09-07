import { guessAudioMime, typedAudioBlob } from '@/lib/browser'
import { request, requestBlob } from '@/shared/api/client'
import { getCachedAudio, putCachedAudio } from '@/shared/storage/audioCache'

export interface LiveAudioPayload {
  provider: string
  voice: string | null
  model: string | null
  output_format: 'mp3'
  narration_style: string
  length_scale: number
  sentence_silence: number
  pageNumber: number
  start: number
  end: number
  text: string
}

export interface LiveAudioCue {
  start: number
  end: number
  timeStart: number
  timeEnd: number
}

export interface LiveAudioResult {
  url: string
  duration?: number | null
  cues?: LiveAudioCue[]
  cacheKey?: string
  cacheVersion?: number
  contentType?: string
  byteLength?: number | null
  cacheHit?: boolean
  cacheStorage?: 'edge' | 'r2' | 'generated' | 'indexeddb' | 'memory' | string
}

/** Survives browser refresh (IndexedDB). Bump if payload fields change. */
export const LIVE_CLIENT_CACHE_VERSION = 2

const LIVE_AUDIO_MEMORY_TTL_MS = 10 * 60_000
const LIVE_AUDIO_RATE_LIMIT_FALLBACK_MS = 60_000
/** Client wall-clock cap so a hung Fly/Worker request cannot deadlock Play. */
export const LIVE_AUDIO_FETCH_TIMEOUT_MS = 50_000
/** One reconnect after a frozen-tab / Worker-kill abort. Timeouts stay a single cap. */
const LIVE_AUDIO_DISCONNECT_ATTEMPTS = 2
const LIVE_AUDIO_DISCONNECT_RETRY_MS = 400
/** Tab hidden this long → drop in-flight fetches (browsers abort them on freeze). */
export const LIVE_AUDIO_STALE_HIDDEN_MS = 5 * 60_000
export const LIVE_AUDIO_ABORTED_MESSAGE = 'Audio request aborted.'

type LiveAudioMemoryEntry = { expiresAt: number; promise: Promise<LiveAudioResult> }
type LiveAudioInflight = {
  key: string
  waiters: Set<symbol>
  controller: AbortController
  promise: Promise<LiveAudioResult>
}

const liveAudioMemoryCache = new Map<string, LiveAudioMemoryEntry>()
const liveAudioInflight = new Map<string, LiveAudioInflight>()
let liveAudioCooldownUntil = 0
let liveAudioHiddenAt = 0
let liveAudioLifecycleBound = false

function liveAudioCacheKey(bookId: string, payload: LiveAudioPayload) {
  return JSON.stringify([
    bookId,
    payload.provider,
    payload.voice ?? '',
    payload.model ?? '',
    payload.output_format,
    payload.narration_style,
    payload.length_scale,
    payload.sentence_silence,
    payload.start,
    payload.end,
    payload.text,
  ])
}

/** Stable client IDB key for a live-audio payload (same text range → same key after refresh). */
export function clientLiveCacheKey(bookId: string, payload: LiveAudioPayload) {
  return `live-client:v${LIVE_CLIENT_CACHE_VERSION}:${liveAudioCacheKey(bookId, payload)}`
}

function liveAudioRetryDelayMs(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error)
  const retryMatch = raw.match(/retry in\s+([\d.]+)s/i)
  if (retryMatch) {
    const retrySeconds = Number(retryMatch[1])
    if (Number.isFinite(retrySeconds)) return Math.ceil(retrySeconds * 1000) + 1000
  }

  if (/429|RESOURCE_EXHAUSTED|quota|rate limit/i.test(raw)) {
    return LIVE_AUDIO_RATE_LIMIT_FALLBACK_MS
  }

  return 0
}

export function liveAudioCooldownRemainingMs(provider: string) {
  if (provider !== 'google') return 0
  return Math.max(0, liveAudioCooldownUntil - Date.now())
}

export function resetLiveAudioCooldownForTests() {
  liveAudioCooldownUntil = 0
  dropStaleLiveAudioWork()
  liveAudioHiddenAt = 0
}

function callerAbortError() {
  return new Error(LIVE_AUDIO_ABORTED_MESSAGE)
}

export function isCallerCancelledAudioError(error: unknown) {
  return error instanceof Error && error.message === LIVE_AUDIO_ABORTED_MESSAGE
}

function errorText(error: unknown) {
  if (error instanceof Error) {
    return `${error.name} ${error.message}`
  }
  return String(error)
}

/** Browser/Worker disconnected the fetch — retryable if *this* Play is still active. */
export function isDisconnectedAudioError(error: unknown) {
  if (isCallerCancelledAudioError(error)) return false
  if (typeof error === 'object' && error && 'name' in error && (error as { name?: string }).name === 'AbortError') {
    return true
  }
  return /Failed to fetch|NetworkError|Network connection lost|The user aborted|operation was aborted|signal is aborted|connection refused|ECONNRESET|ERR_NETWORK/i.test(
    errorText(error),
  )
}

export function isTransientLiveAudioError(error: unknown) {
  if (isCallerCancelledAudioError(error)) return false
  const raw = errorText(error)
  if (/429|RESOURCE_EXHAUSTED|quota|rate limit|cooling down|Invalid live audio|does not match|not configured|Authentication|Unauthorized|Open a book|session expired/i.test(raw)) {
    return false
  }
  return isDisconnectedAudioError(error)
    || /502|503|504|timeout|timed out|unreachable|Audio fetch failed|decode|empty audio/i.test(raw)
}

function waitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(callerAbortError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(callerAbortError())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(callerAbortError())
      return
    }
    const timer = setTimeout(resolve, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(callerAbortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function dropStaleLiveAudioWork() {
  for (const entry of liveAudioInflight.values()) {
    entry.controller.abort()
  }
  liveAudioInflight.clear()
  liveAudioMemoryCache.clear()
}

function pokeHostedKokoroWake() {
  void request('/api/providers/warmup', {
    method: 'POST',
    body: JSON.stringify({ provider: 'kokoro' }),
  }).catch(() => undefined)
}

function bindLiveAudioLifecycle() {
  if (liveAudioLifecycleBound || typeof document === 'undefined') return
  liveAudioLifecycleBound = true
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      liveAudioHiddenAt = Date.now()
      return
    }
    const hiddenFor = liveAudioHiddenAt > 0 ? Date.now() - liveAudioHiddenAt : 0
    liveAudioHiddenAt = 0
    if (hiddenFor < LIVE_AUDIO_STALE_HIDDEN_MS) return
    // Frozen / backgrounded tabs abort in-flight fetch. Don't let Play join a corpse.
    dropStaleLiveAudioWork()
    pokeHostedKokoroWake()
  })
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return
    dropStaleLiveAudioWork()
    pokeHostedKokoroWake()
  })
  window.addEventListener('online', () => {
    pokeHostedKokoroWake()
  })
}

function subscribeInflight(entry: LiveAudioInflight, signal?: AbortSignal): Promise<LiveAudioResult> {
  if (signal?.aborted) return Promise.reject(callerAbortError())
  const token = Symbol('live-audio-waiter')
  entry.waiters.add(token)
  const release = () => {
    if (!entry.waiters.delete(token)) return
    if (entry.waiters.size > 0) return
    queueMicrotask(() => {
      if (entry.waiters.size > 0) return
      if (liveAudioInflight.get(entry.key) !== entry) return
      entry.controller.abort()
    })
  }
  if (signal) signal.addEventListener('abort', release, { once: true })
  return waitWithSignal(entry.promise, signal).finally(() => {
    signal?.removeEventListener('abort', release)
    release()
  })
}

function noteLiveAudioFailure(error: unknown) {
  const retryMs = liveAudioRetryDelayMs(error)
  if (retryMs > 0) {
    liveAudioCooldownUntil = Math.max(liveAudioCooldownUntil, Date.now() + retryMs)
  }
}

async function blobFromResultUrl(url: string, signal?: AbortSignal): Promise<Blob> {
  if (url.startsWith('data:') || url.startsWith('blob:')) {
    const response = await fetch(url, { signal })
    if (!response.ok) throw new Error(`Audio fetch failed (${response.status})`)
    return response.blob()
  }
  if (needsAuthenticatedAudioFetch(url)) {
    return requestBlob(url, { signal })
  }
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`Audio fetch failed (${response.status})`)
  return response.blob()
}

async function persistClientLiveAudio(
  clientKey: string,
  result: LiveAudioResult,
  signal?: AbortSignal,
) {
  try {
    let blob: Blob
    if (result.url) {
      blob = await blobFromResultUrl(result.url, signal)
    } else if (isCacheableLiveAudio(result)) {
      const existing = await getCachedAudio(result.cacheKey, result.cacheVersion).catch(() => null)
      if (!existing?.blob) return
      blob = existing.blob
    } else {
      return
    }

    await putCachedAudio({
      cacheKey: clientKey,
      cacheVersion: LIVE_CLIENT_CACHE_VERSION,
      blob,
      cues: result.cues ?? [],
      duration: result.duration ?? null,
      contentType: result.contentType ?? (blob.type || 'audio/wav'),
      byteLength: result.byteLength ?? blob.size,
    })

    // Also store under server key when present (legacy loadLiveAudioBlob path).
    if (isCacheableLiveAudio(result) && result.cacheKey !== clientKey) {
      await putCachedAudio({
        cacheKey: result.cacheKey,
        cacheVersion: result.cacheVersion,
        blob,
        cues: result.cues ?? [],
        duration: result.duration ?? null,
        contentType: result.contentType ?? (blob.type || 'audio/wav'),
        byteLength: result.byteLength ?? blob.size,
      }).catch(() => undefined)
    }
  } catch {
    // Cache write failures are non-fatal.
  }
}

function timeoutErrorFor(payload: LiveAudioPayload) {
  return payload.provider === 'kokoro'
    ? 'Hosted Kokoro timed out'
    : 'Live audio timed out. Try Play again.'
}

async function fetchLiveAudioJsonOnce(
  bookId: string,
  payload: LiveAudioPayload,
  sharedSignal: AbortSignal,
): Promise<LiveAudioResult> {
  const timeoutError = timeoutErrorFor(payload)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), LIVE_AUDIO_FETCH_TIMEOUT_MS)
  const onSharedAbort = () => ctrl.abort()
  sharedSignal.addEventListener('abort', onSharedAbort, { once: true })
  try {
    if (sharedSignal.aborted) throw callerAbortError()
    return await new Promise<LiveAudioResult>((resolve, reject) => {
      const onAbort = () => {
        reject(new Error(sharedSignal.aborted ? LIVE_AUDIO_ABORTED_MESSAGE : timeoutError))
      }
      ctrl.signal.addEventListener('abort', onAbort, { once: true })
      request<LiveAudioResult>(`/api/books/${bookId}/live-audio`, {
        method: 'POST',
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      }).then((value) => {
        ctrl.signal.removeEventListener('abort', onAbort)
        resolve(value)
      }).catch((error) => {
        ctrl.signal.removeEventListener('abort', onAbort)
        if (ctrl.signal.aborted && !sharedSignal.aborted) {
          reject(new Error(timeoutError))
          return
        }
        if (sharedSignal.aborted) {
          reject(callerAbortError())
          return
        }
        reject(error)
      })
    })
  } finally {
    clearTimeout(timer)
    sharedSignal.removeEventListener('abort', onSharedAbort)
  }
}

/**
 * Network fetch for a book range. Shared across waiters so warmup abort cannot
 * cancel Play. Disconnects (frozen tab, Worker recycle) retry once.
 */
async function fetchLiveAudioJson(
  bookId: string,
  payload: LiveAudioPayload,
  sharedSignal: AbortSignal,
): Promise<LiveAudioResult> {
  let lastError: unknown
  for (let attempt = 0; attempt < LIVE_AUDIO_DISCONNECT_ATTEMPTS; attempt += 1) {
    if (sharedSignal.aborted) throw callerAbortError()
    try {
      return await fetchLiveAudioJsonOnce(bookId, payload, sharedSignal)
    } catch (error) {
      lastError = error
      if (
        sharedSignal.aborted
        || !isDisconnectedAudioError(error)
        || attempt === LIVE_AUDIO_DISCONNECT_ATTEMPTS - 1
      ) {
        throw error
      }
      await sleep(LIVE_AUDIO_DISCONNECT_RETRY_MS * (attempt + 1), sharedSignal)
    }
  }
  throw lastError
}

export async function requestLiveAudio(
  bookId: string,
  payload: LiveAudioPayload,
  signal?: AbortSignal,
) {
  bindLiveAudioLifecycle()
  const cooldownMs = liveAudioCooldownRemainingMs(payload.provider)
  if (cooldownMs > 0) {
    return Promise.reject(new Error(`Gemini TTS is cooling down after a rate limit. Retry in ${Math.ceil(cooldownMs / 1000)}s.`))
  }
  if (signal?.aborted) {
    return Promise.reject(callerAbortError())
  }

  const key = liveAudioCacheKey(bookId, payload)
  const clientKey = clientLiveCacheKey(bookId, payload)
  const now = Date.now()
  const cached = liveAudioMemoryCache.get(key)
  if (cached && cached.expiresAt > now) {
    return waitWithSignal(cached.promise, signal)
  }
  if (cached) liveAudioMemoryCache.delete(key)

  const existing = liveAudioInflight.get(key)
  if (existing && !existing.controller.signal.aborted) {
    return subscribeInflight(existing, signal)
  }

  const controller = new AbortController()
  const entry: LiveAudioInflight = {
    key,
    waiters: new Set(),
    controller,
    promise: new Promise(() => undefined),
  }

  const promise = (async (): Promise<LiveAudioResult> => {
    try {
      const idb = await getCachedAudio(clientKey, LIVE_CLIENT_CACHE_VERSION).catch(() => null)
      if (idb?.blob) {
        return {
          url: '',
          duration: idb.duration,
          cues: (idb.cues ?? []) as LiveAudioCue[],
          cacheKey: clientKey,
          cacheVersion: LIVE_CLIENT_CACHE_VERSION,
          contentType: idb.contentType,
          byteLength: idb.byteLength,
          cacheHit: true,
          cacheStorage: 'indexeddb',
        }
      }

      const result = await fetchLiveAudioJson(bookId, payload, controller.signal)

      // Fire-and-forget durable write so the next session/refresh is instant.
      void persistClientLiveAudio(clientKey, result)

      return {
        ...result,
        cacheKey: clientKey,
        cacheVersion: LIVE_CLIENT_CACHE_VERSION,
      }
    } catch (error) {
      noteLiveAudioFailure(error)
      liveAudioMemoryCache.delete(key)
      throw error
    } finally {
      if (liveAudioInflight.get(key) === entry) liveAudioInflight.delete(key)
    }
  })()

  entry.promise = promise
  liveAudioInflight.set(key, entry)
  promise.then((result) => {
    liveAudioMemoryCache.set(key, {
      expiresAt: Date.now() + LIVE_AUDIO_MEMORY_TTL_MS,
      promise: Promise.resolve(result),
    })
  }).catch(() => undefined)

  return subscribeInflight(entry, signal)
}

function isCacheableLiveAudio(result: LiveAudioResult): result is LiveAudioResult & { cacheKey: string; cacheVersion: number } {
  return Boolean(result.cacheKey && typeof result.cacheVersion === 'number')
}

function isAuthenticatedAudioPath(pathname: string) {
  return pathname.startsWith('/library/') || pathname.startsWith('/api/audio/files/')
}

function needsAuthenticatedAudioFetch(url: string) {
  if (isAuthenticatedAudioPath(url)) return true
  try {
    const parsed = new URL(url, window.location.href)
    const localApiHost = ['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(parsed.hostname)
    return isAuthenticatedAudioPath(parsed.pathname) && (parsed.origin === window.location.origin || localApiHost)
  } catch {
    return false
  }
}

async function fetchAndCacheLiveAudioBlob(result: LiveAudioResult, signal?: AbortSignal) {
  if (!result.url) {
    throw new Error('Audio provider returned no playable URL.')
  }
  const blob = await blobFromResultUrl(result.url, signal)

  if (isCacheableLiveAudio(result)) {
    await putCachedAudio({
      cacheKey: result.cacheKey,
      cacheVersion: result.cacheVersion,
      blob,
      cues: result.cues ?? [],
      duration: result.duration ?? null,
      contentType: result.contentType ?? (blob.type || 'audio/wav'),
      byteLength: result.byteLength ?? blob.size,
    }).catch(() => undefined)
  }

  return blob
}

export async function loadLiveAudioBlob(result: LiveAudioResult, signal?: AbortSignal) {
  const cachedAudio = isCacheableLiveAudio(result)
    ? await getCachedAudio(result.cacheKey, result.cacheVersion).catch(() => null)
    : null

  const fallbackType = result.contentType || 'audio/wav'
  if (cachedAudio?.blob) {
    return {
      blob: typedAudioBlob(cachedAudio.blob, cachedAudio.contentType || fallbackType),
      cues: (cachedAudio.cues ?? result.cues ?? []) as LiveAudioCue[],
    }
  }

  return {
    blob: typedAudioBlob(await fetchAndCacheLiveAudioBlob(result, signal), fallbackType),
    cues: (result.cues ?? []) as LiveAudioCue[],
  }
}

export async function playableAudioUrl(url: string, signal?: AbortSignal) {
  if (url.startsWith('blob:')) return { url, revoke: () => {} }
  if (url.startsWith('data:') || needsAuthenticatedAudioFetch(url)) {
    const blob = typedAudioBlob(await blobFromResultUrl(url, signal), guessAudioMime(url))
    const objectUrl = URL.createObjectURL(blob)
    return {
      url: objectUrl,
      revoke: () => URL.revokeObjectURL(objectUrl),
    }
  }
  return { url, revoke: () => {} }
}

export function audioErrorMessage(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error)
  // Prefer API JSON detail, including nested 502: {"detail":"..."} strings.
  const detail = raw.match(/"detail"\s*:\s*"((?:\\.|[^"\\])*)"/)?.[1]
    ?.replace(/\\"/g, '"')
    ?.replace(/\\n/g, ' ')
  const message = (detail ?? raw).trim()

  if (/Authentication required|Unauthorized|Session expired/i.test(message)) {
    return 'Your session expired. Sign in again, then try audio playback.'
  }
  if (
    isCallerCancelledAudioError(error)
    || /Audio request aborted|The user aborted|operation was aborted|signal is aborted/i.test(message)
    || (typeof error === 'object' && error && 'name' in error && (error as { name?: string }).name === 'AbortError')
  ) {
    return 'Could not start audio. Tap Play again.'
  }
  if (/not configured|configured yet/i.test(message)) {
    return message.length < 180 ? message : 'Hosted voice is not configured on the server.'
  }
  // Hosted Kokoro (Fly) — check BEFORE generic "kokoro" so we don't claim on-device.
  if (/Hosted Kokoro timed out|timed out.*Fly|Fly may be stopped/i.test(message)) {
    return 'Reading voice timed out. Wait a few seconds and try Play again (server may be waking up).'
  }
  if (/Hosted Kokoro unreachable|Hosted Kokoro failed|kokoro-remote|KOKORO_REMOTE/i.test(message)) {
    return 'Reading voice server is unavailable. Try again in a moment, or switch to Gemini in Audio settings.'
  }
  if (/429|RESOURCE_EXHAUSTED|quota|rate limit|cooling down/i.test(message)) {
    if (/kokoro/i.test(message)) {
      return 'Kokoro is busy. Wait a few seconds and try Play again.'
    }
    return 'Gemini TTS hit the free-tier rate limit. Try again shortly, or use Kokoro.'
  }
  if (/preparing|model is not ready|voice model|still downloading/i.test(message)) {
    return 'The voice model is still preparing. Try again in a moment.'
  }
  // True on-device path only (legacy kokoro-local / worker download).
  if (/on-device|kokoro-local|Kokoro is still downloading|local Kokoro/i.test(message)) {
    return 'On-device Kokoro could not generate audio. Use hosted Kokoro (default) or try again after the model finishes loading.'
  }
  if (/synthesis failed|synthesis timed out|could not generate/i.test(message)) {
    return 'Could not generate audio for this passage. Try again or pick another voice in Audio settings.'
  }
  if (/Audio provider did not return playable audio/i.test(message)) {
    return 'The selected voice did not return playable audio. Try again or switch voice in Audio settings.'
  }
  if (/text does not match|range/i.test(message)) {
    return 'Could not match this passage to the book text. Move slightly and try again.'
  }
  if (/Failed to fetch|NetworkError|fetch/i.test(message)) {
    return 'Could not reach the audio service. Check the connection and try again.'
  }
  // Strip noisy status prefixes: "502: Hosted Kokoro..."
  const cleaned = message.replace(/^\d{3}:\s*/, '')
  if (cleaned.length > 0 && cleaned.length < 160 && !/^\s*\{/.test(cleaned)) {
    return cleaned
  }
  return 'Could not start audio. Check the selected voice in Audio settings and try again.'
}
