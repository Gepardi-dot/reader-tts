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
  cacheStorage?: 'edge' | 'r2' | 'generated' | string
}

const LIVE_AUDIO_MEMORY_TTL_MS = 10 * 60_000
const LIVE_AUDIO_RATE_LIMIT_FALLBACK_MS = 60_000
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
}

function noteLiveAudioFailure(error: unknown) {
  const retryMs = liveAudioRetryDelayMs(error)
  if (retryMs > 0) {
    liveAudioCooldownUntil = Math.max(liveAudioCooldownUntil, Date.now() + retryMs)
  }
}

export function requestLiveAudio(bookId: string, payload: LiveAudioPayload) {
  const cooldownMs = liveAudioCooldownRemainingMs(payload.provider)
  if (cooldownMs > 0) {
    return Promise.reject(new Error(`Gemini TTS is cooling down after a rate limit. Retry in ${Math.ceil(cooldownMs / 1000)}s.`))
  }

  const key = liveAudioCacheKey(bookId, payload)
  const now = Date.now()
  const cached = liveAudioMemoryCache.get(key)
  if (cached && cached.expiresAt > now) return cached.promise
  if (cached) liveAudioMemoryCache.delete(key)

  const promise = request<LiveAudioResult>(`/api/books/${bookId}/live-audio`, {
    method: 'POST',
    body: JSON.stringify(payload),
  }).catch((error) => {
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

function needsAuthenticatedAudioFetch(url: string) {
  if (url.startsWith('/library/')) return true
  try {
    const parsed = new URL(url, window.location.href)
    const localApiHost = ['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(parsed.hostname)
    return parsed.pathname.startsWith('/library/') && (parsed.origin === window.location.origin || localApiHost)
  } catch {
    return false
  }
}

async function fetchAndCacheLiveAudioBlob(result: LiveAudioResult, signal?: AbortSignal) {
  const blob = needsAuthenticatedAudioFetch(result.url)
    ? await requestBlob(result.url, { signal })
    : await fetch(result.url, { signal }).then((response) => {
      if (!response.ok) throw new Error(`Audio fetch failed (${response.status})`)
      return response.blob()
    })

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

  return {
    blob: cachedAudio?.blob ?? await fetchAndCacheLiveAudioBlob(result, signal),
    cues: (cachedAudio?.cues ?? result.cues ?? []) as LiveAudioCue[],
  }
}

export async function playableAudioUrl(url: string, signal?: AbortSignal) {
  if (!needsAuthenticatedAudioFetch(url)) return { url, revoke: () => {} }

  const blob = await requestBlob(url, { signal })
  const objectUrl = URL.createObjectURL(blob)
  return {
    url: objectUrl,
    revoke: () => URL.revokeObjectURL(objectUrl),
  }
}

export function audioErrorMessage(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error)
  const detail = raw.match(/"detail"\s*:\s*"([^"]+)"/)?.[1]
  const message = detail ?? raw

  if (/Authentication required|Unauthorized|Session expired/i.test(message)) {
    return 'Your session expired. Sign in again, then try audio playback.'
  }
  if (/not configured|configured yet/i.test(message)) {
    return message
  }
  if (/429|RESOURCE_EXHAUSTED|quota|rate limit|cooling down/i.test(message)) {
    return 'Gemini TTS hit the free-tier rate limit. Browser speech will continue; try Gemini again shortly.'
  }
  if (/preparing|model is not ready|voice model/i.test(message)) {
    return 'The on-device voice is still preparing. Try again in a moment.'
  }
  if (/kokoro|on-device|synthesis failed|synthesis timed out|could not generate/i.test(message)) {
    return 'The on-device voice could not generate audio. Try another Kokoro voice or retry after preparation finishes.'
  }
  if (/Audio provider did not return playable audio/i.test(message)) {
    return 'The selected voice did not return playable audio. Try another voice or start playback again.'
  }
  if (/text does not match|range/i.test(message)) {
    return 'Could not match this passage to the book text. Move slightly and try again.'
  }
  if (/Failed to fetch|NetworkError|fetch/i.test(message)) {
    return 'Could not reach the audio service. Check the connection and try again.'
  }
  return 'Could not start audio. Check the selected voice provider and try again.'
}
