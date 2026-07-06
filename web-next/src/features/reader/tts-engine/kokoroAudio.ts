import { getCachedAudio, putCachedAudio } from '@/shared/storage/audioCache'
import {
  LOCAL_KOKORO_CACHE_VERSION,
  isModelReady,
  localKokoroCacheKey,
  synthesizeLocalStreaming,
} from '@/shared/storage/modelCache'
import {
  notePlaybackFetchEnd,
  notePlaybackFetchStart,
} from '@/shared/storage/rollingVoiceCache'

export interface KokoroAudioResult {
  blob: Blob
  duration: number | null
  cacheKey: string
  cacheHit: boolean
}

const KOKORO_SYNTH_TIMEOUT_MS = 45_000

export async function synthesizeKokoroLocal(
  text: string,
  voice: string,
  speed: number,
  signal: AbortSignal,
): Promise<KokoroAudioResult | null> {
  if (!isModelReady()) return null
  const cacheKey = await localKokoroCacheKey(voice, speed, text)
  if (signal.aborted) return null

  const hit = await getCachedAudio(cacheKey, LOCAL_KOKORO_CACHE_VERSION).catch(() => null)
  if (hit) {
    return {
      blob: hit.blob,
      duration: hit.duration,
      cacheKey,
      cacheHit: true,
    }
  }
  if (signal.aborted) return null

  notePlaybackFetchStart()
  let result
  try {
    result = await new Promise<{
      wav: ArrayBuffer
      sampleRate: number
      durationSec: number
    } | null>((resolve) => {
      let settled = false
      let timeoutId: ReturnType<typeof setTimeout> | null = null
      let removeAbortListener: (() => void) | null = null
      let synthCancel: (() => void) | null = null
      const finish = (value: { wav: ArrayBuffer; sampleRate: number; durationSec: number } | null) => {
        if (settled) return
        settled = true
        if (timeoutId) clearTimeout(timeoutId)
        removeAbortListener?.()
        resolve(value)
      }
      const handle = synthesizeLocalStreaming(text, voice, speed, {
        onComplete: (res) => finish(res),
        onError: () => finish(null),
      })
      if (!handle) {
        finish(null)
        return
      }
      if (settled) return
      synthCancel = handle.cancel
      timeoutId = setTimeout(() => {
        try {
          synthCancel?.()
        } catch {
          // Best effort.
        }
        finish(null)
      }, KOKORO_SYNTH_TIMEOUT_MS)
      const onAbort = () => {
        try {
          synthCancel?.()
        } catch {
          // Best effort.
        }
        finish(null)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      removeAbortListener = () => signal.removeEventListener('abort', onAbort)
    })
  } finally {
    notePlaybackFetchEnd()
  }
  if (!result || signal.aborted) return null

  const blob = new Blob([result.wav], { type: 'audio/wav' })
  await putCachedAudio({
    cacheKey,
    cacheVersion: LOCAL_KOKORO_CACHE_VERSION,
    blob,
    cues: [],
    duration: result.durationSec,
    contentType: 'audio/wav',
    byteLength: blob.size,
  }).catch(() => {
    // Cache write failures are non-fatal.
  })

  return {
    blob,
    duration: result.durationSec,
    cacheKey,
    cacheHit: false,
  }
}
