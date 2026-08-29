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
const liveAudioMemoryCache = new Map<string, { expiresAt: number; promise: Promise<LiveAudioResult> }>()
let liveAudioCooldownUntil = 0

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
  liveAudioMemoryCache.clear()
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

/**
 * Fetch live audio for a book range.
 * Lookup order: in-memory → IndexedDB (survives refresh) → network (Worker edge/R2/synth).
 */
async function fetchLiveAudioJson(
  bookId: string,
  payload: LiveAudioPayload,
  signal?: AbortSignal,
): Promise<LiveAudioResult> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), LIVE_AUDIO_FETCH_TIMEOUT_MS)
  const onParentAbort = () => ctrl.abort()
  signal?.addEventListener('abort', onParentAbort, { once: true })
  const timeoutError = payload.provider === 'kokoro'
    ? 'Hosted Kokoro timed out'
    : 'Live audio timed out. Try Play again.'
  try {
    if (signal?.aborted) throw new Error('Audio request aborted.')
    return await new Promise<LiveAudioResult>((resolve, reject) => {
      const onAbort = () => {
        reject(new Error(signal?.aborted ? 'Audio request aborted.' : timeoutError))
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
        if (ctrl.signal.aborted && !signal?.aborted) {
          reject(new Error(timeoutError))
          return
        }
        reject(error)
      })
    })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onParentAbort)
  }
}

export async function requestLiveAudio(
  bookId: string,
  payload: LiveAudioPayload,
  signal?: AbortSignal,
) {
  const cooldownMs = liveAudioCooldownRemainingMs(payload.provider)
  if (cooldownMs > 0) {
    return Promise.reject(new Error(`Gemini TTS is cooling down after a rate limit. Retry in ${Math.ceil(cooldownMs / 1000)}s.`))
  }
  if (signal?.aborted) {
    return Promise.reject(new Error('Audio request aborted.'))
  }

  const key = liveAudioCacheKey(bookId, payload)
  const clientKey = clientLiveCacheKey(bookId, payload)
  const now = Date.now()
  const cached = liveAudioMemoryCache.get(key)
  if (cached && cached.expiresAt > now) return cached.promise
  if (cached) liveAudioMemoryCache.delete(key)

  const promise = (async (): Promise<LiveAudioResult> => {
    // Durable client cache — works after browser refresh.
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

    const result = await fetchLiveAudioJson(bookId, payload, signal)

    // Fire-and-forget durable write so the next session/refresh is instant.
    void persistClientLiveAudio(clientKey, result)

    return {
      ...result,
      // Prefer client key so loadLiveAudioBlob reads IDB without re-fetching the data URL.
      cacheKey: clientKey,
      cacheVersion: LIVE_CLIENT_CACHE_VERSION,
    }
  })().catch((error) => {
    noteLiveAudioFailure(error)
    liveAudioMemoryCache.delete(key)
    throw error
  })

  liveAudioMemoryCache.set(key, { expiresAt: now + LIVE_AUDIO_MEMORY_TTL_MS, promise })
  return promise
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
