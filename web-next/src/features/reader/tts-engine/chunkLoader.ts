import {
  isModelReady,
  waitForModelReady,
  synthesizeLocalStreaming,
  localKokoroCacheKey,
  LOCAL_KOKORO_CACHE_VERSION,
} from '@/shared/storage/modelCache'
import { getCachedAudio, putCachedAudio } from '@/shared/storage/audioCache'
import {
  notePlaybackFetchEnd,
  notePlaybackFetchStart,
} from '@/shared/storage/rollingVoiceCache'
import {
  elapsedMs,
  performanceNow,
  queuePerformanceTelemetry,
} from '@/shared/telemetry/performanceTelemetry'
import {
  BROWSER_TTS_PROVIDER_ID,
  pacingFor,
  pacingForPlaybackRate,
} from '../audioPlayback'
import {
  liveAudioCooldownRemainingMs,
  loadLiveAudioBlob,
  requestLiveAudio,
  type LiveAudioPayload,
} from './liveAudio'
import { pcmToAudioBuffer } from './audioClock'
import type { NativeAudioResult, TtsAudioChunk } from './types'
import type { ChunkLoader } from './bufferPool'

const KOKORO_SYNTH_TIMEOUT_MS = 45_000
const LIVE_AUDIO_ATTEMPTS = 2
const LIVE_AUDIO_RETRY_MS = 500

export interface ChunkLoaderConfig {
  bookId?: string
  getProvider: () => string
  getVoice: () => string | null
  getSelectionKey: () => string
  getRate?: () => number
  ensureAudioContext: () => AudioContext
  trackObjectUrl: (url: string) => void
}

/**
 * Provider-aware chunk loader.
 *
 * Kokoro: stream sentence PCM into onFrame as soon as each frame arrives
 * (cache hits emit a single full buffer). Gemini: fetch/decode full chunk then
 * emit once. Browser speech is handled outside the loader by the runtime.
 */
export function createChunkLoader(config: ChunkLoaderConfig): ChunkLoader {
  return async function loadChunk(chunk, signal, { background, onFrame }) {
    const provider = config.getProvider()
    const voice = config.getVoice()
    const selectionKey = config.getSelectionKey()
    const stale = () => signal.aborted || config.getSelectionKey() !== selectionKey

    if (provider === BROWSER_TTS_PROVIDER_ID) return

    // Hosted Kokoro + Gemini share the Worker live-audio path (edge/R2 cache).
    if (provider === 'kokoro' || provider === 'google') {
      if (!config.bookId) {
        throw new Error('Open a book before playing cloud TTS.')
      }
      await loadLiveProviderChunk(chunk, signal, {
        bookId: config.bookId,
        provider,
        voice,
        rate: config.getRate?.() ?? 1,
        background,
        stale,
        ensureAudioContext: config.ensureAudioContext,
        trackObjectUrl: config.trackObjectUrl,
        onFrame,
      })
      return
    }

    // Legacy on-device Kokoro (only if some other code path still requests it).
    if (provider === 'kokoro-local') {
      await loadKokoroStreaming(chunk, signal, {
        voice,
        stale,
        ensureAudioContext: config.ensureAudioContext,
        onFrame,
      })
    }
  }
}

async function loadKokoroStreaming(
  chunk: TtsAudioChunk,
  signal: AbortSignal,
  opts: {
    voice: string | null
    stale: () => boolean
    ensureAudioContext: () => AudioContext
    onFrame: (frame: NativeAudioResult & { buffer: AudioBuffer }) => void
  },
) {
  if (!opts.voice) throw new Error('Select a Kokoro voice before playing.')

  const { lengthScale } = pacingFor('kokoro')
  const speed = lengthScale > 0 ? 1 / lengthScale : 1

  // Cache lookup can run while the model warms — hits skip synth entirely.
  const cacheKeyPromise = localKokoroCacheKey(opts.voice, speed, chunk.text)
  if (!isModelReady()) {
    // Don't block forever on a cold download; surface failure quickly if aborted.
    const ready = await waitForModelReady(signal)
    if (!ready || opts.stale()) {
      if (!signal.aborted) throw new Error('Kokoro is still downloading. Wait for the voice to finish preparing, then tap again.')
      return
    }
  }

  const cacheKey = await cacheKeyPromise
  if (opts.stale()) return

  const hit = await getCachedAudio(cacheKey, LOCAL_KOKORO_CACHE_VERSION).catch(() => null)
  if (opts.stale()) return
  if (hit) {
    const ctx = opts.ensureAudioContext()
    const buffer = await ctx.decodeAudioData(await hit.blob.arrayBuffer())
    if (opts.stale()) return
    opts.onFrame({
      url: null,
      buffer,
      cues: [],
      durationSec: hit.duration ?? buffer.duration,
      cacheHit: true,
      cacheStorage: 'indexeddb',
    })
    return
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false
    let frameCount = 0
    let timeoutId: ReturnType<typeof setTimeout> | null = null
    let cancel: (() => void) | null = null

    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      if (timeoutId) clearTimeout(timeoutId)
      signal.removeEventListener('abort', onAbort)
      notePlaybackFetchEnd()
      if (error) reject(error)
      else resolve()
    }

    const onAbort = () => {
      try {
        cancel?.()
      } catch {
        // best effort
      }
      finish()
    }

    notePlaybackFetchStart()
    const handle = synthesizeLocalStreaming(chunk.text, opts.voice!, speed, {
      onChunk: (pcm, sampleRate) => {
        if (settled || opts.stale() || pcm.length === 0) return
        try {
          const ctx = opts.ensureAudioContext()
          const buffer = pcmToAudioBuffer(ctx, pcm, sampleRate)
          frameCount += 1
          opts.onFrame({
            url: null,
            buffer,
            cues: [],
            durationSec: buffer.duration,
            cacheHit: false,
            cacheStorage: 'generated',
          })
        } catch {
          // Skip a bad frame; complete/error will still settle the load.
        }
      },
      onComplete: (result) => {
        if (settled || opts.stale()) {
          finish()
          return
        }
        // Cache the full WAV for the next hit. Frames already scheduled.
        const blob = new Blob([result.wav], { type: 'audio/wav' })
        void putCachedAudio({
          cacheKey,
          cacheVersion: LOCAL_KOKORO_CACHE_VERSION,
          blob,
          cues: [],
          duration: result.durationSec,
          contentType: 'audio/wav',
          byteLength: blob.size,
        }).catch(() => undefined)

        // If the worker never emitted stream frames (older path), schedule full audio once.
        if (frameCount === 0 && result.wav.byteLength > 0) {
          void (async () => {
            try {
              const ctx = opts.ensureAudioContext()
              const buffer = await ctx.decodeAudioData(result.wav.slice(0))
              if (!opts.stale()) {
                opts.onFrame({
                  url: null,
                  buffer,
                  cues: [],
                  durationSec: result.durationSec || buffer.duration,
                  cacheHit: false,
                  cacheStorage: 'generated',
                })
              }
            } finally {
              finish()
            }
          })()
          return
        }
        finish()
      },
      onError: (err) => {
        finish(err instanceof Error ? err : new Error(String(err)))
      },
    })

    if (!handle) {
      finish(new Error('Kokoro model is not ready.'))
      return
    }

    cancel = handle.cancel
    timeoutId = setTimeout(() => {
      try {
        cancel?.()
      } catch {
        // best effort
      }
      finish(frameCount > 0 ? undefined : new Error('Kokoro synthesis timed out.'))
    }, KOKORO_SYNTH_TIMEOUT_MS)

    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function isRetryableLiveAudioError(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error)
  if (/429|RESOURCE_EXHAUSTED|quota|rate limit|cooling down|Invalid live audio|does not match|not configured|Authentication|Unauthorized|Open a book/i.test(raw)) {
    return false
  }
  return /502|503|504|timeout|timed out|unreachable|Failed to fetch|NetworkError|Audio fetch failed|decode|empty audio/i.test(raw)
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

async function loadLiveProviderChunk(
  chunk: TtsAudioChunk,
  signal: AbortSignal,
  opts: {
    bookId: string
    provider: string
    voice: string | null
    rate: number
    background: boolean
    stale: () => boolean
    ensureAudioContext: () => AudioContext
    trackObjectUrl: (url: string) => void
    onFrame: (frame: NativeAudioResult & { buffer: AudioBuffer }) => void
  },
) {
  let lastError: unknown
  for (let attempt = 0; attempt < LIVE_AUDIO_ATTEMPTS; attempt += 1) {
    try {
      await loadLiveProviderChunkOnce(chunk, signal, opts)
      return
    } catch (error) {
      lastError = error
      if (
        signal.aborted
        || opts.stale()
        || !isRetryableLiveAudioError(error)
        || attempt === LIVE_AUDIO_ATTEMPTS - 1
      ) {
        throw error
      }
      await sleep(LIVE_AUDIO_RETRY_MS * (attempt + 1), signal)
    }
  }
  throw lastError
}

async function loadLiveProviderChunkOnce(
  chunk: TtsAudioChunk,
  signal: AbortSignal,
  opts: {
    bookId: string
    provider: string
    voice: string | null
    rate: number
    background: boolean
    stale: () => boolean
    ensureAudioContext: () => AudioContext
    trackObjectUrl: (url: string) => void
    onFrame: (frame: NativeAudioResult & { buffer: AudioBuffer }) => void
  },
) {
  const cooldownMs = liveAudioCooldownRemainingMs(opts.provider)
  if (cooldownMs > 0) {
    queuePerformanceTelemetry({
      eventName: 'tts.live_audio_backoff_v2',
      bookId: opts.bookId,
      provider: opts.provider,
      value: Math.ceil(cooldownMs / 1000),
      metadata: {
        chunkIndex: chunk.index,
        chunkChars: chunk.text.length,
        background: opts.background,
      },
    })
    if (!opts.background) {
      const label = opts.provider === 'kokoro' ? 'Kokoro' : 'Gemini'
      throw new Error(`${label} TTS is cooling down. Retry in ${Math.ceil(cooldownMs / 1000)}s.`)
    }
    return
  }

  // Kokoro: bake UI rate into server length_scale (pitch-safe native speed).
  // Gemini: base pacing only; AudioClock HTML preservesPitch handles UI rate.
  const { lengthScale, sentenceSilence } = opts.provider === 'kokoro'
    ? pacingForPlaybackRate('kokoro', opts.rate)
    : pacingFor(opts.provider)
  const payload: LiveAudioPayload = {
    provider: opts.provider,
    voice: opts.voice,
    model: null,
    output_format: 'mp3',
    narration_style: '',
    length_scale: lengthScale,
    sentence_silence: sentenceSilence,
    pageNumber: 1,
    start: chunk.start,
    end: chunk.end,
    text: chunk.text,
  }

  const fetchStartedAt = performanceNow()
  let liveAudio
  try {
    liveAudio = await requestLiveAudio(opts.bookId, payload, signal)
  } catch (error) {
    queuePerformanceTelemetry({
      eventName: 'tts.live_audio_error_v2',
      bookId: opts.bookId,
      provider: opts.provider,
      durationMs: elapsedMs(fetchStartedAt),
      metadata: {
        chunkIndex: chunk.index,
        chunkChars: chunk.text.length,
        background: opts.background,
        rateLimited: liveAudioCooldownRemainingMs(opts.provider) > 0,
      },
    })
    throw error
  }
  if (opts.stale()) return

  queuePerformanceTelemetry({
    eventName: 'tts.live_audio_fetch_v2',
    bookId: opts.bookId,
    provider: opts.provider,
    durationMs: elapsedMs(fetchStartedAt),
    cacheHit: liveAudio.cacheHit,
    cacheStorage: liveAudio.cacheStorage,
    metadata: {
      chunkIndex: chunk.index,
      chunkChars: chunk.text.length,
      background: opts.background,
    },
  })

  const { blob, cues } = await loadLiveAudioBlob(liveAudio, signal)
  if (opts.stale()) return
  const ctx = opts.ensureAudioContext()
  const buffer = await ctx.decodeAudioData(await blob.arrayBuffer())
  if (opts.stale()) return
  const url = URL.createObjectURL(blob)
  opts.trackObjectUrl(url)
  opts.onFrame({
    url,
    buffer,
    cues,
    durationSec: liveAudio.duration ?? buffer.duration,
    cacheHit: liveAudio.cacheHit,
    cacheStorage: liveAudio.cacheStorage,
  })
}
