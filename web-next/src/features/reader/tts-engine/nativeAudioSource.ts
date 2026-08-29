import {
  isModelReady,
  waitForModelReady,
} from '@/shared/storage/modelCache'
import {
  elapsedMs,
  performanceNow,
  queuePerformanceTelemetry,
} from '@/shared/telemetry/performanceTelemetry'
import { decodeAudioDataSafe, typedAudioBlob } from '@/lib/browser'
import {
  BROWSER_TTS_PROVIDER_ID,
  pacingFor,
} from '../audioPlayback'
import {
  liveAudioCooldownRemainingMs,
  loadLiveAudioBlob,
  requestLiveAudio,
  type LiveAudioPayload,
  type LiveAudioResult,
  type LiveAudioCue,
} from './liveAudio'
import { synthesizeKokoroLocal, type KokoroAudioResult } from './kokoroAudio'
import type { NativeAudioResult, TtsAudioChunk } from './types'

export interface NativeAudioSourceConfig {
  bookId?: string
  getProvider: () => string
  getVoice: () => string | null
  getSelectionKey: () => string
  ensureAudioContext: () => AudioContext
  trackObjectUrl: (url: string) => void
}

export interface NativeAudioSourceDeps {
  isModelReady: () => boolean
  waitForModelReady: (signal: AbortSignal) => Promise<boolean>
  synthesizeKokoroLocal: (
    text: string,
    voice: string,
    speed: number,
    signal: AbortSignal,
  ) => Promise<KokoroAudioResult | null>
  liveAudioCooldownRemainingMs: (provider: string) => number
  requestLiveAudio: (bookId: string, payload: LiveAudioPayload) => Promise<LiveAudioResult>
  loadLiveAudioBlob: (
    result: LiveAudioResult,
    signal?: AbortSignal,
  ) => Promise<{ blob: Blob; cues: LiveAudioCue[] }>
  decodeAudioBlob: (ctx: AudioContext, blob: Blob) => Promise<AudioBuffer>
  createObjectUrl: (blob: Blob) => string
  now: () => number
  elapsedMs: (startedAt: number) => number | null
  queueTelemetry: typeof queuePerformanceTelemetry
}

export const defaultNativeAudioSourceDeps: NativeAudioSourceDeps = {
  isModelReady,
  waitForModelReady,
  synthesizeKokoroLocal,
  liveAudioCooldownRemainingMs,
  requestLiveAudio,
  loadLiveAudioBlob,
  decodeAudioBlob: async (ctx, blob) => decodeAudioDataSafe(ctx, blob),
  createObjectUrl: (blob) => URL.createObjectURL(blob),
  now: performanceNow,
  elapsedMs,
  queueTelemetry: queuePerformanceTelemetry,
}

export function createNativeAudioSource(
  config: NativeAudioSourceConfig,
  deps: NativeAudioSourceDeps = defaultNativeAudioSourceDeps,
) {
  return async function loadNativeAudioChunk(
    chunk: TtsAudioChunk,
    signal: AbortSignal,
    background: boolean,
  ): Promise<NativeAudioResult | null> {
    const selectedProvider = config.getProvider()
    const selectedVoice = config.getVoice()
    const requestSelectionKey = config.getSelectionKey()
    const selectionChanged = () => config.getSelectionKey() !== requestSelectionKey

    if (selectedProvider === 'kokoro') {
      if (!selectedVoice) return null
      if (!deps.isModelReady()) {
        const ready = await deps.waitForModelReady(signal)
        if (!ready || signal.aborted || selectionChanged()) return null
      }
      const { lengthScale } = pacingFor('kokoro')
      const speed = lengthScale > 0 ? 1 / lengthScale : 1
      const synthesized = await deps.synthesizeKokoroLocal(chunk.text, selectedVoice, speed, signal)
      if (signal.aborted || selectionChanged()) return null
      if (!synthesized) throw new Error('Kokoro synthesis timed out or returned no audio.')

      const ctx = config.ensureAudioContext()
      const buffer = await deps.decodeAudioBlob(ctx, synthesized.blob)
      if (signal.aborted || selectionChanged()) return null
      return {
        url: null,
        buffer,
        cues: [],
        durationSec: synthesized.duration ?? buffer.duration,
        cacheHit: synthesized.cacheHit,
        cacheStorage: synthesized.cacheHit ? 'indexeddb' : 'generated',
      }
    }

    if (!config.bookId || selectedProvider === BROWSER_TTS_PROVIDER_ID) return null

    const cooldownMs = deps.liveAudioCooldownRemainingMs(selectedProvider)
    if (cooldownMs > 0) {
      deps.queueTelemetry({
        eventName: 'tts.live_audio_backoff_v2',
        bookId: config.bookId,
        provider: selectedProvider,
        value: Math.ceil(cooldownMs / 1000),
        metadata: {
          chunkIndex: chunk.index,
          chunkChars: chunk.text.length,
          background,
        },
      })
      return null
    }

    const { lengthScale, sentenceSilence } = pacingFor(selectedProvider)
    const payload: LiveAudioPayload = {
      provider: selectedProvider,
      voice: selectedVoice,
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
    const fetchStartedAt = deps.now()
    let liveAudio
    try {
      liveAudio = await deps.requestLiveAudio(config.bookId, payload)
    } catch (error) {
      deps.queueTelemetry({
        eventName: 'tts.live_audio_error_v2',
        bookId: config.bookId,
        provider: selectedProvider,
        durationMs: deps.elapsedMs(fetchStartedAt),
        metadata: {
          chunkIndex: chunk.index,
          chunkChars: chunk.text.length,
          background,
          rateLimited: deps.liveAudioCooldownRemainingMs(selectedProvider) > 0,
        },
      })
      throw error
    }
    if (signal.aborted || selectionChanged()) return null

    deps.queueTelemetry({
      eventName: 'tts.live_audio_fetch_v2',
      bookId: config.bookId,
      provider: selectedProvider,
      durationMs: deps.elapsedMs(fetchStartedAt),
      cacheHit: liveAudio.cacheHit,
      cacheStorage: liveAudio.cacheStorage,
      metadata: {
        chunkIndex: chunk.index,
        chunkChars: chunk.text.length,
        background,
      },
    })

    const { blob, cues } = await deps.loadLiveAudioBlob(liveAudio, signal)
    if (signal.aborted || selectionChanged()) return null
    const playable = typedAudioBlob(blob, liveAudio.contentType || 'audio/wav')
    const ctx = config.ensureAudioContext()
    const buffer = await deps.decodeAudioBlob(ctx, playable)
    if (signal.aborted || selectionChanged()) return null
    const url = deps.createObjectUrl(playable)
    config.trackObjectUrl(url)
    return {
      url,
      buffer,
      cues,
      durationSec: liveAudio.duration ?? buffer.duration,
      cacheHit: liveAudio.cacheHit,
      cacheStorage: liveAudio.cacheStorage,
    }
  }
}
