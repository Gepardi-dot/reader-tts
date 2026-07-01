import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { request, requestBlob } from '@/shared/api/client'
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
import {
  elapsedMs,
  performanceNow,
  queuePerformanceTelemetry,
} from '@/shared/telemetry/performanceTelemetry'
import {
  AUDIO_SLICE_CHARS,
  BROWSER_TTS_PROVIDER_ID,
  CHUNK_CHARS,
  DEFAULT_AUDIO_CHARS,
  DEFAULT_FIRST_AUDIO_CHARS,
  DEFAULT_PREFETCH_AHEAD,
  FIRST_AUDIO_CHARS,
  PREFETCH_AHEAD_TARGET,
  SILENT_WAV_DATA_URL,
  audioBufferScheduledEndTime,
  audioBufferSourceStartTime,
  browserSpeechQueueTarget,
  buildAudioChunks,
  buildAudioChunksFromGridWindow,
  buildPlaybackStartupPlan,
  findGridChunk,
  patchAudioChunk,
  pacingFor,
  shouldBridgeNativeAudioGap,
  shouldPrimeNativeAudio,
  tapOffsetSeekSeconds,
} from './audioPlayback'
import {
  preferredBrowserSpeechVoice,
  supportsBrowserSpeech,
} from './browserSpeech'

export type AudioPhase = 'idle' | 'buffering' | 'playing' | 'paused'
export type ChunkStatus = 'idle' | 'fetching' | 'ready' | 'error'

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

export interface KokoroStreamState {
  buffers: AudioBuffer[]
  completed: boolean
  error: boolean
  waiters: Set<() => void>
  cancel?: () => void
}

export interface AudioChunk {
  start: number
  end: number
  text: string
  url: string | null
  buffer: AudioBuffer | null
  status: ChunkStatus
  stream?: KokoroStreamState
  cues?: LiveAudioCue[]
  tapOffset?: number
}

export interface WordAudioState {
  word: string
  status: 'loading' | 'ready' | 'playing'
}

export interface UseWordAudioControllerParams {
  bookId?: string
  bookText: string
  provider: string
  voice: string | null
  rate: number
  presynthGridRef: MutableRefObject<Array<{ start: number; end: number }> | null>
  syncAudioFollowCue: (chunk: AudioChunk, currentTime: number, follow: boolean) => void
  clearAudioFollow: () => void
  showToast: (message: string) => void
}

export interface WordAudioController {
  wordAudio: WordAudioState | null
  wordAudioPhase: AudioPhase
  wordAudioCurIdx: number
  wordAudioTotal: number
  playWord: (word: string, startOffset: number, reason?: 'voice-switch') => Promise<void>
  toggleWordAudio: () => void
  stopWordAudio: () => void
  isAudioActive: () => boolean
}

const LIVE_AUDIO_MEMORY_TTL_MS = 10 * 60_000
const KOKORO_STREAM_URL = 'stream:kokoro'
const liveAudioMemoryCache = new Map<string, { expiresAt: number; promise: Promise<LiveAudioResult> }>()

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

export function requestLiveAudio(bookId: string, payload: LiveAudioPayload) {
  const key = liveAudioCacheKey(bookId, payload)
  const now = Date.now()
  const cached = liveAudioMemoryCache.get(key)
  if (cached && cached.expiresAt > now) return cached.promise
  if (cached) liveAudioMemoryCache.delete(key)

  const promise = request<LiveAudioResult>(`/api/books/${bookId}/live-audio`, {
    method: 'POST',
    body: JSON.stringify(payload),
  }).catch((error) => {
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
    }).catch(() => {})
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
  if (/preparing|model is not ready|voice model/i.test(message)) {
    return 'The on-device voice is still preparing. Try again in a moment.'
  }
  if (/text does not match|range/i.test(message)) {
    return 'Could not match this passage to the book text. Move slightly and try again.'
  }
  if (/Failed to fetch|NetworkError|fetch/i.test(message)) {
    return 'Could not reach the audio service. Check the connection and try again.'
  }
  return 'Could not start audio. Check the selected voice provider and try again.'
}

function audioBufferFromPcm(ctx: AudioContext, pcm: Float32Array, sampleRate: number): AudioBuffer {
  const buffer = ctx.createBuffer(1, pcm.length, sampleRate)
  buffer.copyToChannel(new Float32Array(pcm), 0)
  return buffer
}

function notifyKokoroStream(stream: KokoroStreamState) {
  const waiters = Array.from(stream.waiters)
  stream.waiters.clear()
  for (const wake of waiters) {
    try { wake() } catch { /* listener fault should not break playback */ }
  }
}

function waitForKokoroStreamBuffer(stream: KokoroStreamState, index: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || stream.buffers[index] || stream.completed || stream.error) return Promise.resolve()
  return new Promise((resolve) => {
    const wake = () => {
      stream.waiters.delete(wake)
      signal.removeEventListener('abort', wake)
      resolve()
    }
    stream.waiters.add(wake)
    signal.addEventListener('abort', wake, { once: true })
  })
}

export async function synthesizeKokoroLocal(
  text: string,
  voice: string,
  speed: number,
  signal: AbortSignal,
): Promise<{ blob: Blob; duration: number | null; cacheKey: string } | null> {
  if (!isModelReady()) return null
  const cacheKey = await localKokoroCacheKey(voice, speed, text)
  if (signal.aborted) return null

  const hit = await getCachedAudio(cacheKey, LOCAL_KOKORO_CACHE_VERSION).catch(() => null)
  if (hit) return { blob: hit.blob, duration: hit.duration, cacheKey }
  if (signal.aborted) return null

  notePlaybackFetchStart()
  let result
  try {
    result = await new Promise<{
      wav: ArrayBuffer
      sampleRate: number
      durationSec: number
    } | null>((resolve) => {
      const handle = synthesizeLocalStreaming(text, voice, speed, {
        onComplete: (res) => resolve(res),
        onError: () => resolve(null),
      })
      if (!handle) {
        resolve(null)
        return
      }
      signal.addEventListener('abort', () => {
        try { handle.cancel() } catch { /* best effort */ }
        resolve(null)
      }, { once: true })
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
  }).catch(() => { /* cache write failures are non-fatal */ })

  return { blob, duration: result.durationSec, cacheKey }
}

export function useWordAudioController({
  bookId,
  bookText,
  provider,
  voice,
  rate,
  presynthGridRef,
  syncAudioFollowCue,
  clearAudioFollow,
  showToast,
}: UseWordAudioControllerParams): WordAudioController {
  const [wordAudio, setWordAudio] = useState<WordAudioState | null>(null)
  const [wordAudioCurIdx, setWordAudioCurIdx] = useState(0)
  const [wordAudioTotal, setWordAudioTotal] = useState(0)
  const audioRateRef = useRef(rate)
  audioRateRef.current = rate

  const wordAudioRef = useRef<HTMLAudioElement | null>(null)
  const wordAudioPrimedRef = useRef<HTMLAudioElement | null>(null)
  const wordAudioAbortRef = useRef<AbortController | null>(null)
  const browserSpeechUtteranceRef = useRef<SpeechSynthesisUtterance | null>(null)
  const browserSpeechActiveRef = useRef(false)
  const wordAudioCurIdxRef = useRef(0)
  const wordAudioChunksRef = useRef<AudioChunk[]>([])
  const wordAudioChunkFetchesRef = useRef<Map<number, Promise<string | null>>>(new Map())
  const wordAudioObjectUrlsRef = useRef<Set<string>>(new Set())
  const wordAudioPlaybackStartRef = useRef<number | null>(null)
  const wordAudioFirstAudioReportedRef = useRef(false)
  const wordAudioVoiceSwitchStartRef = useRef<number | null>(null)
  const wordAudioCtxRef = useRef<AudioContext | null>(null)
  const wordAudioSourceRef = useRef<AudioBufferSourceNode | null>(null)
  const wordAudioScheduledEndRef = useRef<number>(0)
  const wordAudioChunkStartRef = useRef<number>(0)
  const wordAudioRafRef = useRef<number | null>(null)
  const wordAudioChunkSeekRef = useRef<number>(0)

  const wordAudioPhase: AudioPhase = !wordAudio
    ? 'idle'
    : wordAudio.status === 'loading'
      ? 'buffering'
      : wordAudio.status === 'playing'
        ? 'playing'
        : 'paused'

  const isAudioActive = useCallback(() => (
    (wordAudioCtxRef.current?.state === 'running') ||
    Boolean(wordAudioRef.current && !wordAudioRef.current.paused)
  ), [])

  function clearWordAudioObjectUrls() {
    for (const url of wordAudioObjectUrlsRef.current) URL.revokeObjectURL(url)
    wordAudioObjectUrlsRef.current.clear()
  }

  function getWordAudioCtx(): AudioContext {
    if (!wordAudioCtxRef.current || wordAudioCtxRef.current.state === 'closed') {
      wordAudioCtxRef.current = new AudioContext()
      wordAudioScheduledEndRef.current = 0
    }
    return wordAudioCtxRef.current
  }

  function primeWordAudioElement() {
    let audio = wordAudioRef.current
    if (!audio) {
      audio = new Audio()
      audio.preservesPitch = true
      wordAudioRef.current = audio
    }
    audio.muted = true
    audio.loop = false
    audio.src = SILENT_WAV_DATA_URL
    wordAudioPrimedRef.current = audio
    const playPromise = audio.play()
    if (playPromise && typeof playPromise.then === 'function') {
      playPromise.catch(() => undefined)
    }
    return audio
  }

  function clearPrimedWordAudioElement() {
    if (wordAudioPrimedRef.current) wordAudioPrimedRef.current = null
  }

  function stopWordAudioCueRAF() {
    if (wordAudioRafRef.current !== null) {
      cancelAnimationFrame(wordAudioRafRef.current)
      wordAudioRafRef.current = null
    }
  }

  function canUseBrowserSpeech() {
    return supportsBrowserSpeech()
  }

  function browserSpeechVoice() {
    return preferredBrowserSpeechVoice()
  }

  function browserSpeechWordAt(text: string, charIndex: number) {
    const boundedIndex = Math.max(0, Math.min(charIndex, text.length))
    const rest = text.slice(boundedIndex)
    const match = rest.match(/\S+/)
    if (!match || match.index == null) return null
    const start = boundedIndex + match.index
    return { start, end: start + match[0].length }
  }

  function updateWordAudioChunk(idx: number, patch: Partial<AudioChunk>) {
    patchAudioChunk(wordAudioChunksRef.current, idx, patch)
  }

  function markWordAudioFirstAudible(
    mode: 'browser' | 'web-audio' | 'html-audio' | 'kokoro-stream',
    idx: number,
    chunk: AudioChunk,
  ) {
    if (wordAudioFirstAudioReportedRef.current) return
    wordAudioFirstAudioReportedRef.current = true
    const startedAt = wordAudioPlaybackStartRef.current
    const voiceSwitchStartedAt = wordAudioVoiceSwitchStartRef.current
    wordAudioVoiceSwitchStartRef.current = null
    queuePerformanceTelemetry({
      eventName: 'tts.first_audio',
      bookId,
      provider,
      durationMs: startedAt == null ? null : elapsedMs(startedAt),
      metadata: {
        mode,
        chunkIndex: idx,
        chunkChars: chunk.text.length,
        totalChunks: wordAudioChunksRef.current.length,
      },
    })
    if (voiceSwitchStartedAt != null) {
      queuePerformanceTelemetry({
        eventName: 'tts.voice_switch_first_audio',
        bookId,
        provider,
        durationMs: elapsedMs(voiceSwitchStartedAt),
        metadata: {
          mode,
          chunkIndex: idx,
          chunkChars: chunk.text.length,
          voice: voice ?? '',
        },
      })
    }
  }

  function createBrowserSpeechUtterance(
    idx: number,
    chunk: AudioChunk,
    ctrl: AbortController,
    word: string,
    onEnd: () => void,
  ) {
    const utterance = new SpeechSynthesisUtterance(chunk.text)
    const browserVoice = browserSpeechVoice()
    if (browserVoice) utterance.voice = browserVoice
    utterance.lang = browserVoice?.lang || 'en-US'
    utterance.rate = Math.max(0.5, Math.min(audioRateRef.current, 2))
    utterance.pitch = 1
    utterance.volume = 1

    utterance.onstart = () => {
      if (ctrl.signal.aborted || !browserSpeechActiveRef.current) return
      browserSpeechUtteranceRef.current = utterance
      wordAudioCurIdxRef.current = idx
      setWordAudioCurIdx(idx)
      setWordAudio({ word, status: 'playing' })
      updateWordAudioChunk(idx, { status: 'ready', cues: [] })
      markWordAudioFirstAudible('browser', idx, chunk)
      syncAudioFollowCue(chunk, 0, true)
    }
    utterance.onboundary = (event) => {
      if (ctrl.signal.aborted || !browserSpeechActiveRef.current) return
      const range = browserSpeechWordAt(chunk.text, event.charIndex)
      if (!range) return
      syncAudioFollowCue({
        ...chunk,
        cues: [{
          start: chunk.start + range.start,
          end: chunk.start + range.end,
          timeStart: 0,
          timeEnd: 0,
        }],
      }, 0, true)
    }
    utterance.onend = () => {
      if (ctrl.signal.aborted || !browserSpeechActiveRef.current) return
      onEnd()
    }
    utterance.onerror = (event) => {
      if (ctrl.signal.aborted || !browserSpeechActiveRef.current || event.error === 'interrupted') return
      showToast('Browser speech stopped. Tap a word to start again.')
      stopWordAudio()
    }

    return utterance
  }

  function queueBrowserSpeechChunksAt(idx: number, currentChunks: AudioChunk[], ctrl: AbortController, word: string) {
    if (!canUseBrowserSpeech()) return false
    const chunk = currentChunks[idx]
    if (!chunk) {
      stopWordAudio()
      return true
    }

    stopWordAudioCueRAF()
    browserSpeechActiveRef.current = true
    wordAudioCurIdxRef.current = idx
    setWordAudioCurIdx(idx)
    setWordAudio({ word, status: 'playing' })
    updateWordAudioChunk(idx, { status: 'ready', cues: [] })
    syncAudioFollowCue(chunk, 0, true)

    window.speechSynthesis.cancel()
    let queuedUntil = idx - 1
    const enqueueThrough = (targetIdx: number) => {
      const lastIdx = Math.min(targetIdx, currentChunks.length - 1)
      while (queuedUntil < lastIdx) {
        const queuedIdx = queuedUntil + 1
        queuedUntil = queuedIdx
        const queuedChunk = currentChunks[queuedIdx]
        if (!queuedChunk) continue
        const utterance = createBrowserSpeechUtterance(
          queuedIdx,
          queuedChunk,
          ctrl,
          word,
          () => {
            if (queuedIdx >= wordAudioChunksRef.current.length - 1) stopWordAudio()
          },
        )
        const originalOnStart = utterance.onstart
        utterance.onstart = (event) => {
          if (typeof originalOnStart === 'function') originalOnStart.call(utterance, event)
          if (!ctrl.signal.aborted && browserSpeechActiveRef.current) {
            enqueueThrough(browserSpeechQueueTarget(queuedIdx, currentChunks.length))
          }
        }
        window.speechSynthesis.speak(utterance)
        if (queuedIdx === idx) browserSpeechUtteranceRef.current = utterance
      }
    }

    enqueueThrough(browserSpeechQueueTarget(idx, currentChunks.length))

    return true
  }

  function playBrowserSpeechChunkAt(
    idx: number,
    currentChunks: AudioChunk[],
    ctrl: AbortController,
    word: string,
    options: { switchToNativeWhenReady?: boolean } = {},
  ) {
    if (!canUseBrowserSpeech()) return false
    const chunk = currentChunks[idx]
    if (!chunk) {
      stopWordAudio()
      return true
    }

    stopWordAudioCueRAF()
    browserSpeechActiveRef.current = true
    wordAudioCurIdxRef.current = idx
    setWordAudioCurIdx(idx)
    setWordAudio({ word, status: 'playing' })
    updateWordAudioChunk(idx, { status: 'ready', cues: [] })
    if (options.switchToNativeWhenReady) {
      prefetchWordAudioAhead(idx, currentChunks, ctrl.signal)
    }
    syncAudioFollowCue(chunk, 0, true)

    window.speechSynthesis.cancel()
    const utterance = createBrowserSpeechUtterance(idx, chunk, ctrl, word, () => {
      const nextIdx = idx + 1
      if (nextIdx >= wordAudioChunksRef.current.length) {
        stopWordAudio()
        return
      }
      if (options.switchToNativeWhenReady) {
        const latest = wordAudioChunksRef.current
        const nextChunk = latest[nextIdx]
        if (nextChunk?.url) {
          browserSpeechActiveRef.current = false
          browserSpeechUtteranceRef.current = null
          playWordAudioChunkAt(nextIdx, latest, ctrl, word)
          return
        }
        if (nextChunk?.status === 'idle') {
          void fetchWordAudioChunk(nextIdx, nextChunk, ctrl.signal, { background: true })
        }
      }
      playBrowserSpeechChunkAt(nextIdx, wordAudioChunksRef.current, ctrl, word, options)
    })
    browserSpeechUtteranceRef.current = utterance

    window.speechSynthesis.speak(utterance)
    return true
  }

  function startWordAudioCueRAF() {
    stopWordAudioCueRAF()
    const ctx = wordAudioCtxRef.current
    if (!ctx) return
    const chunkStart = wordAudioChunkStartRef.current
    const curIdx = wordAudioCurIdxRef.current
    const seekOffset = wordAudioChunkSeekRef.current
    const tick = () => {
      if (wordAudioAbortRef.current?.signal.aborted) return
      const chunk = wordAudioChunksRef.current[curIdx]
      if (chunk) syncAudioFollowCue(chunk, Math.max(0, ctx.currentTime - chunkStart) + seekOffset, false)
      wordAudioRafRef.current = requestAnimationFrame(tick)
    }
    wordAudioRafRef.current = requestAnimationFrame(tick)
  }

  function streamKokoroAudioChunk(
    idx: number,
    chunk: AudioChunk,
    signal: AbortSignal,
    kokoroVoice: string,
    speed: number,
    cacheKey: string,
  ): Promise<string | null> {
    const ctx = wordAudioCtxRef.current
    if (!ctx || ctx.state === 'closed') return Promise.resolve(null)

    return new Promise((resolve) => {
      const stream: KokoroStreamState = {
        buffers: [],
        completed: false,
        error: false,
        waiters: new Set(),
      }
      let resolved = false
      let playbackFetchEnded = false

      const resolveOnce = (value: string | null) => {
        if (resolved) return
        resolved = true
        resolve(value)
      }
      const endPlaybackFetch = () => {
        if (playbackFetchEnded) return
        playbackFetchEnded = true
        notePlaybackFetchEnd()
      }

      updateWordAudioChunk(idx, { stream })
      notePlaybackFetchStart()

      const handle = synthesizeLocalStreaming(chunk.text, kokoroVoice, speed, {
        onChunk: (pcm, sampleRate) => {
          if (signal.aborted) return
          const currentCtx = wordAudioCtxRef.current
          if (!currentCtx || currentCtx.state === 'closed') return
          const buffer = audioBufferFromPcm(currentCtx, pcm, sampleRate)
          stream.buffers.push(buffer)
          if (stream.buffers.length === 1) {
            updateWordAudioChunk(idx, {
              status: 'ready',
              url: KOKORO_STREAM_URL,
              buffer,
              stream,
              cues: [],
            })
            prefetchWordAudioAhead(wordAudioCurIdxRef.current, wordAudioChunksRef.current, signal)
            resolveOnce(KOKORO_STREAM_URL)
          } else {
            updateWordAudioChunk(idx, { stream })
          }
          notifyKokoroStream(stream)
        },
        onComplete: async (result) => {
          endPlaybackFetch()
          stream.completed = true
          notifyKokoroStream(stream)
          if (!signal.aborted) {
            try {
              const blob = new Blob([result.wav], { type: 'audio/wav' })
              await putCachedAudio({
                cacheKey,
                cacheVersion: LOCAL_KOKORO_CACHE_VERSION,
                blob,
                cues: [],
                duration: result.durationSec,
                contentType: 'audio/wav',
                byteLength: blob.size,
              })
            } catch { /* cache write failures are non-fatal */ }
          }
          resolveOnce(stream.buffers.length ? KOKORO_STREAM_URL : null)
        },
        onError: () => {
          endPlaybackFetch()
          stream.error = true
          notifyKokoroStream(stream)
          updateWordAudioChunk(idx, { status: 'error' })
          resolveOnce(null)
        },
      })

      if (!handle) {
        endPlaybackFetch()
        stream.error = true
        notifyKokoroStream(stream)
        resolveOnce(null)
        return
      }

      stream.cancel = handle.cancel
      signal.addEventListener('abort', () => {
        try { handle.cancel() } catch { /* best effort */ }
        endPlaybackFetch()
        stream.error = true
        notifyKokoroStream(stream)
        resolveOnce(null)
      }, { once: true })
    })
  }

  async function fetchWordAudioChunk(
    idx: number,
    chunk: AudioChunk,
    signal: AbortSignal,
    options: { background?: boolean } = {},
  ): Promise<string | null> {
    const existingChunk = wordAudioChunksRef.current[idx]
    if (existingChunk?.url) return existingChunk.url
    const existingFetch = wordAudioChunkFetchesRef.current.get(idx)
    if (existingFetch) return existingFetch

    updateWordAudioChunk(idx, { status: 'fetching' })
    const fetchPromise = (async () => {
      const finalizeBlob = async (blob: Blob, cues: LiveAudioCue[]): Promise<string | null> => {
        const blobUrl = URL.createObjectURL(blob)
        wordAudioObjectUrlsRef.current.add(blobUrl)

        let buffer: AudioBuffer | null = null
        try {
          const ctx = wordAudioCtxRef.current
          if (ctx && ctx.state !== 'closed') {
            buffer = await ctx.decodeAudioData(await blob.arrayBuffer())
          }
        } catch { /* decode failure: fallback to HTMLAudio */ }

        if (signal.aborted) return null
        updateWordAudioChunk(idx, {
          status: 'ready',
          url: blobUrl,
          buffer,
          cues,
        })
        prefetchWordAudioAhead(wordAudioCurIdxRef.current, wordAudioChunksRef.current, signal)
        return blobUrl
      }

      try {
        if (provider === 'kokoro' && isModelReady() && voice) {
          const { lengthScale: localLs } = pacingFor('kokoro')
          const localSpeed = localLs > 0 ? 1 / localLs : 1
          const cacheKey = await localKokoroCacheKey(voice, localSpeed, chunk.text)
          if (signal.aborted) return null

          const hit = await getCachedAudio(cacheKey, LOCAL_KOKORO_CACHE_VERSION).catch(() => null)
          if (hit) return finalizeBlob(hit.blob, (hit.cues ?? []) as LiveAudioCue[])

          if (audioRateRef.current === 1.0) {
            const streamed = await streamKokoroAudioChunk(idx, chunk, signal, voice, localSpeed, cacheKey)
            if (streamed) return streamed
          }

          const local = await synthesizeKokoroLocal(chunk.text, voice, localSpeed, signal)
          if (signal.aborted) return null
          if (local) return finalizeBlob(local.blob, [])
          throw new Error('The on-device voice model is not ready.')
        }

        if (provider === 'kokoro') {
          throw new Error('The on-device voice model is still preparing.')
        }

        if (!bookId) throw new Error('Missing book id for live audio.')

        const { lengthScale, sentenceSilence } = pacingFor(provider)
        const liveAudioStartedAt = performanceNow()
        const liveAudio = await requestLiveAudio(bookId, {
          provider,
          voice,
          model: null,
          output_format: 'mp3',
          narration_style: '',
          length_scale: lengthScale,
          sentence_silence: sentenceSilence,
          pageNumber: 1,
          start: chunk.start,
          end: chunk.end,
          text: chunk.text,
        })
        if (signal.aborted) return null
        queuePerformanceTelemetry({
          eventName: 'tts.live_audio_fetch',
          bookId,
          provider,
          durationMs: elapsedMs(liveAudioStartedAt),
          cacheHit: liveAudio.cacheHit,
          cacheStorage: liveAudio.cacheStorage,
          metadata: {
            chunkIndex: idx,
            chunkChars: chunk.text.length,
            background: Boolean(options.background),
          },
        })

        const { blob, cues } = await loadLiveAudioBlob(liveAudio, signal)
        if (signal.aborted) return null
        return finalizeBlob(blob, cues)
      } catch (error) {
        if ((error as Error).name !== 'AbortError') {
          if (options.background) {
            updateWordAudioChunk(idx, { status: 'idle' })
          } else {
            setWordAudio(null)
            showToast(audioErrorMessage(error))
            updateWordAudioChunk(idx, { status: 'error' })
          }
        }
        return null
      } finally {
        wordAudioChunkFetchesRef.current.delete(idx)
      }
    })()

    wordAudioChunkFetchesRef.current.set(idx, fetchPromise)
    return fetchPromise
  }

  function prefetchWordAudioAhead(fromIdx: number, currentChunks: AudioChunk[], signal: AbortSignal) {
    if (signal.aborted) return
    const target = PREFETCH_AHEAD_TARGET[provider] ?? DEFAULT_PREFETCH_AHEAD
    for (let offset = 1; offset <= target; offset += 1) {
      const idx = fromIdx + offset
      const chunk = currentChunks[idx]
      if (!chunk) break
      if (chunk.url || chunk.status === 'fetching') continue
      if (chunk.status === 'idle') {
        void fetchWordAudioChunk(idx, chunk, signal, { background: true })
      }
    }
  }

  function stopWordAudio() {
    stopWordAudioCueRAF()
    wordAudioAbortRef.current?.abort()
    wordAudioAbortRef.current = null
    try {
      if (wordAudioSourceRef.current) {
        wordAudioSourceRef.current.onended = null
        wordAudioSourceRef.current.stop(0)
        wordAudioSourceRef.current.disconnect()
      }
    } catch { /* already stopped */ }
    wordAudioSourceRef.current = null
    wordAudioScheduledEndRef.current = 0
    wordAudioChunkStartRef.current = 0
    wordAudioChunkSeekRef.current = 0
    browserSpeechActiveRef.current = false
    if (canUseBrowserSpeech()) window.speechSynthesis.cancel()
    browserSpeechUtteranceRef.current = null
    if (wordAudioCtxRef.current?.state === 'suspended') void wordAudioCtxRef.current.resume()
    wordAudioRef.current?.pause()
    wordAudioRef.current = null
    clearPrimedWordAudioElement()
    wordAudioCurIdxRef.current = 0
    wordAudioChunksRef.current = []
    wordAudioChunkFetchesRef.current.clear()
    wordAudioPlaybackStartRef.current = null
    wordAudioFirstAudioReportedRef.current = false
    wordAudioVoiceSwitchStartRef.current = null
    clearWordAudioObjectUrls()
    clearAudioFollow()
    setWordAudioCurIdx(0)
    setWordAudioTotal(0)
    setWordAudio(null)
  }

  async function continueWordAudioPlayback(nextIdx: number, ctrl: AbortController, word: string) {
    const latest = wordAudioChunksRef.current
    if (nextIdx >= latest.length) {
      stopWordAudio()
      return
    }

    const nextChunk = latest[nextIdx]
    if (nextChunk.url) {
      playWordAudioChunkAt(nextIdx, latest, ctrl, word)
      return
    }

    if (shouldBridgeNativeAudioGap(provider, canUseBrowserSpeech())) {
      queuePerformanceTelemetry({
        eventName: 'tts.native_gap_bridge',
        bookId,
        provider,
        metadata: {
          chunkIndex: nextIdx,
          chunkChars: nextChunk.text.length,
          chunkStatus: nextChunk.status,
        },
      })
      if (nextChunk.status === 'idle') {
        void fetchWordAudioChunk(nextIdx, nextChunk, ctrl.signal, { background: true })
      }
      if (playBrowserSpeechChunkAt(nextIdx, latest, ctrl, word, { switchToNativeWhenReady: true })) {
        return
      }
    }

    setWordAudio({ word, status: 'loading' })
    const url = await fetchWordAudioChunk(nextIdx, nextChunk, ctrl.signal)
    if (ctrl.signal.aborted) return
    if (!url) {
      stopWordAudio()
      return
    }
    playWordAudioChunkAt(nextIdx, wordAudioChunksRef.current, ctrl, word)
  }

  function playWordAudioStreamBufferAt(
    idx: number,
    streamIndex: number,
    currentChunks: AudioChunk[],
    ctrl: AbortController,
    word: string,
  ) {
    const chunk = currentChunks[idx]
    const stream = chunk?.stream
    const ctx = wordAudioCtxRef.current
    if (!chunk || !stream || !ctx || ctx.state === 'closed') return

    const buffer = stream.buffers[streamIndex]
    if (!buffer) {
      if (stream.completed || stream.error) {
        void continueWordAudioPlayback(idx + 1, ctrl, word)
        return
      }
      setWordAudio({ word, status: 'loading' })
      void waitForKokoroStreamBuffer(stream, streamIndex, ctrl.signal).then(() => {
        if (ctrl.signal.aborted) return
        playWordAudioStreamBufferAt(idx, streamIndex, wordAudioChunksRef.current, ctrl, word)
      })
      return
    }

    stopWordAudioCueRAF()
    wordAudioCurIdxRef.current = idx
    setWordAudioCurIdx(idx)
    setWordAudio({ word, status: 'playing' })
    prefetchWordAudioAhead(idx, currentChunks, ctrl.signal)

    if (ctx.state === 'suspended') void ctx.resume()

    try {
      if (wordAudioSourceRef.current) {
        wordAudioSourceRef.current.onended = null
        wordAudioSourceRef.current.disconnect()
      }
    } catch { /* ignore */ }
    wordAudioRef.current?.pause()
    wordAudioRef.current = null
    clearPrimedWordAudioElement()

    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(ctx.destination)
    wordAudioSourceRef.current = source

    wordAudioChunkSeekRef.current = 0
    const now = ctx.currentTime
    const startAt = audioBufferSourceStartTime(now, wordAudioScheduledEndRef.current)
    source.start(startAt)
    markWordAudioFirstAudible('kokoro-stream', idx, chunk)
    wordAudioScheduledEndRef.current = audioBufferScheduledEndTime({
      startAt,
      bufferDuration: buffer.duration,
    })
    wordAudioChunkStartRef.current = startAt
    syncAudioFollowCue(chunk, 0, true)
    startWordAudioCueRAF()

    source.onended = () => {
      if (ctrl.signal.aborted) return
      stopWordAudioCueRAF()
      const nextStreamIndex = streamIndex + 1
      if (stream.buffers[nextStreamIndex]) {
        playWordAudioStreamBufferAt(idx, nextStreamIndex, wordAudioChunksRef.current, ctrl, word)
        return
      }
      if (!stream.completed && !stream.error) {
        void waitForKokoroStreamBuffer(stream, nextStreamIndex, ctrl.signal).then(() => {
          if (ctrl.signal.aborted) return
          playWordAudioStreamBufferAt(idx, nextStreamIndex, wordAudioChunksRef.current, ctrl, word)
        })
        return
      }
      void continueWordAudioPlayback(idx + 1, ctrl, word)
    }
  }

  function playWordAudioChunkAt(idx: number, currentChunks: AudioChunk[], ctrl: AbortController, word: string) {
    const chunk = currentChunks[idx]
    if (!chunk?.url) return

    stopWordAudioCueRAF()
    wordAudioCurIdxRef.current = idx
    setWordAudioCurIdx(idx)
    setWordAudio({ word, status: 'playing' })
    prefetchWordAudioAhead(idx, currentChunks, ctrl.signal)

    const ctx = wordAudioCtxRef.current
    if (chunk.url === KOKORO_STREAM_URL && audioRateRef.current !== 1.0) {
      updateWordAudioChunk(idx, {
        status: 'idle',
        url: null,
        buffer: null,
        stream: undefined,
      })
      setWordAudio({ word, status: 'loading' })
      void fetchWordAudioChunk(idx, wordAudioChunksRef.current[idx], ctrl.signal).then((url) => {
        if (ctrl.signal.aborted) return
        if (!url) {
          stopWordAudio()
          return
        }
        playWordAudioChunkAt(idx, wordAudioChunksRef.current, ctrl, word)
      })
      return
    }
    if (
      chunk.url === KOKORO_STREAM_URL &&
      audioRateRef.current === 1.0 &&
      ctx &&
      ctx.state !== 'closed' &&
      chunk.stream
    ) {
      playWordAudioStreamBufferAt(idx, 0, currentChunks, ctrl, word)
      return
    }

    if (audioRateRef.current === 1.0 && ctx && ctx.state !== 'closed' && chunk.buffer) {
      if (ctx.state === 'suspended') void ctx.resume()

      try {
        if (wordAudioSourceRef.current) {
          wordAudioSourceRef.current.onended = null
          wordAudioSourceRef.current.disconnect()
        }
      } catch { /* ignore */ }
      wordAudioRef.current?.pause()
      wordAudioRef.current = null
      clearPrimedWordAudioElement()

      const source = ctx.createBufferSource()
      source.buffer = chunk.buffer
      source.playbackRate.value = audioRateRef.current
      source.connect(ctx.destination)
      wordAudioSourceRef.current = source

      const seekSec = tapOffsetSeekSeconds(chunk.start, chunk.tapOffset, chunk.cues)
      wordAudioChunkSeekRef.current = seekSec

      const now = ctx.currentTime
      const startAt = audioBufferSourceStartTime(now, wordAudioScheduledEndRef.current)
      source.start(startAt, seekSec > 0 ? seekSec : undefined)
      markWordAudioFirstAudible('web-audio', idx, chunk)
      wordAudioScheduledEndRef.current = audioBufferScheduledEndTime({
        startAt,
        bufferDuration: chunk.buffer.duration,
        seekSeconds: seekSec,
        playbackRate: audioRateRef.current,
      })
      wordAudioChunkStartRef.current = startAt
      syncAudioFollowCue(chunk, seekSec, true)
      startWordAudioCueRAF()

      source.onended = () => {
        if (ctrl.signal.aborted) return
        stopWordAudioCueRAF()
        void continueWordAudioPlayback(idx + 1, ctrl, word)
      }
    } else {
      const primedAudio = wordAudioPrimedRef.current
      const audio = primedAudio ?? new Audio()
      if (wordAudioRef.current && wordAudioRef.current !== audio) wordAudioRef.current.pause()
      audio.src = chunk.url
      audio.muted = false
      audio.loop = false
      audio.preservesPitch = true
      audio.playbackRate = audioRateRef.current
      wordAudioRef.current = audio
      clearPrimedWordAudioElement()
      syncAudioFollowCue(chunk, 0, true)

      audio.play()
        .then(() => markWordAudioFirstAudible('html-audio', idx, chunk))
        .catch(() => {
          if (ctrl.signal.aborted) return
          setWordAudio({ word, status: 'ready' })
          showToast('Audio is ready. Tap the banner play button.')
        })

      audio.ontimeupdate = () => {
        if (ctrl.signal.aborted) return
        syncAudioFollowCue(chunk, audio.currentTime, true)
      }
      audio.onended = () => {
        if (ctrl.signal.aborted) return
        void continueWordAudioPlayback(idx + 1, ctrl, word)
      }
      audio.onerror = () => {
        if (ctrl.signal.aborted) return
        showToast('Audio playback failed. Try starting it again.')
        stopWordAudio()
      }
    }
  }

  async function playWord(word: string, startOffset: number, reason?: 'voice-switch') {
    stopWordAudio()
    const playStartedAt = performanceNow()
    wordAudioPlaybackStartRef.current = playStartedAt
    wordAudioFirstAudioReportedRef.current = false
    wordAudioVoiceSwitchStartRef.current = reason === 'voice-switch' ? playStartedAt : null
    const audioCtx = getWordAudioCtx()
    void audioCtx.resume()
    setWordAudio({ word, status: 'loading' })
    const fullText = bookText
    const start = Math.max(0, Math.min(startOffset, fullText.length))
    const kokoroModelReady = isModelReady()

    let initial: AudioChunk[]
    const grid = provider === 'kokoro' && !kokoroModelReady ? presynthGridRef.current : null
    if (grid && grid.length > 0) {
      const chunkIdx = findGridChunk(grid, start)
      const chunkSize = CHUNK_CHARS[provider] ?? DEFAULT_AUDIO_CHARS
      const firstChunkSize = FIRST_AUDIO_CHARS[provider] ?? DEFAULT_FIRST_AUDIO_CHARS
      const raw = buildAudioChunksFromGridWindow({
        fullText,
        grid,
        start,
        windowChunks: 50,
        targetChars: chunkSize,
        firstTargetChars: firstChunkSize,
      })
      initial = raw.map((chunk) => ({
        ...chunk,
        url: null,
        buffer: null,
        status: 'idle' as ChunkStatus,
      }))
      if (!initial.length) {
        const fallbackWindow = grid.slice(chunkIdx, chunkIdx + 50)
        initial = fallbackWindow.map((g) => ({
          start: Math.max(g.start, start),
          end: g.end,
          text: fullText.slice(Math.max(g.start, start), g.end),
          url: null,
          buffer: null,
          status: 'idle' as ChunkStatus,
        })).filter((chunk) => chunk.text.trim())
      }
    } else {
      const end = Math.min(fullText.length, start + AUDIO_SLICE_CHARS)
      const snippet = fullText.slice(start, end)
      if (!snippet.trim()) {
        setWordAudio(null)
        showToast('There is no readable text at this position.')
        return
      }
      const chunkSize = CHUNK_CHARS[provider] ?? DEFAULT_AUDIO_CHARS
      const firstChunkSize = FIRST_AUDIO_CHARS[provider] ?? DEFAULT_FIRST_AUDIO_CHARS
      const raw = buildAudioChunks(snippet, start, chunkSize, firstChunkSize)
      initial = raw.map((chunk) => ({ ...chunk, url: null, buffer: null, status: 'idle' as ChunkStatus }))
    }
    if (!initial.length) {
      setWordAudio(null)
      showToast('There is no readable text at this position.')
      return
    }

    wordAudioChunksRef.current = initial
    wordAudioCurIdxRef.current = 0
    setWordAudioCurIdx(0)
    setWordAudioTotal(initial.length)
    const ctrl = new AbortController()
    wordAudioAbortRef.current = ctrl

    const startupPlan = buildPlaybackStartupPlan({
      provider,
      chunkCount: initial.length,
      browserSpeechSupported: canUseBrowserSpeech(),
      kokoroModelReady,
    })
    if (shouldPrimeNativeAudio(startupPlan)) {
      primeWordAudioElement()
    }
    queuePerformanceTelemetry({
      eventName: 'tts.play_start',
      bookId,
      provider,
      metadata: {
        startOffset: start,
        selectedChars: word.length,
        chunkCount: initial.length,
        browserSpeech: startupPlan.useBrowserSpeech,
        nativeBackgroundFetch: startupPlan.fetchNativeInBackground,
        kokoroModelReady,
      },
    })

    const shouldBootstrapNativeAudio = !startupPlan.useBrowserSpeech || startupPlan.fetchNativeInBackground
    if (shouldBootstrapNativeAudio) {
      for (let idx = 0; idx < startupPlan.bootstrapCount; idx += 1) {
        void fetchWordAudioChunk(idx, initial[idx], ctrl.signal, {
          background: startupPlan.fetchNativeInBackground || idx >= startupPlan.startReadyChunkCount,
        })
      }
    }

    if (startupPlan.useBrowserSpeech) {
      const started = startupPlan.fetchNativeInBackground
        ? playBrowserSpeechChunkAt(0, initial, ctrl, word, { switchToNativeWhenReady: true })
        : queueBrowserSpeechChunksAt(0, initial, ctrl, word)
      if (started) return
      if (provider === BROWSER_TTS_PROVIDER_ID) {
        stopWordAudio()
        showToast('Browser speech is not supported by this browser.')
        return
      }
    }

    try {
      const startupReady = await Promise.all(
        initial
          .slice(0, startupPlan.startReadyChunkCount)
          .map((chunk, idx) => fetchWordAudioChunk(idx, chunk, ctrl.signal)),
      )
      if (ctrl.signal.aborted || startupReady.some((url) => !url)) {
        stopWordAudio()
        return
      }
      playWordAudioChunkAt(0, wordAudioChunksRef.current, ctrl, word)
    } catch (error) {
      stopWordAudio()
      showToast(audioErrorMessage(error))
    }
  }

  function resumeWordAudio() {
    if (!wordAudio) return
    if (browserSpeechActiveRef.current && canUseBrowserSpeech()) {
      if (window.speechSynthesis.paused) {
        window.speechSynthesis.resume()
        setWordAudio({ word: wordAudio.word, status: 'playing' })
        return
      }
      if (window.speechSynthesis.speaking) {
        setWordAudio({ word: wordAudio.word, status: 'playing' })
        return
      }
      browserSpeechActiveRef.current = false
      browserSpeechUtteranceRef.current = null
      const currentChunk = wordAudioChunksRef.current[wordAudioCurIdxRef.current] ?? wordAudioChunksRef.current[0]
      if (currentChunk) {
        void playWord(wordAudio.word, currentChunk.start)
        return
      }
      stopWordAudio()
      return
    }
    const ctx = wordAudioCtxRef.current
    if (ctx && ctx.state === 'suspended') {
      void ctx.resume().then(() => {
        setWordAudio({ word: wordAudio.word, status: 'playing' })
        startWordAudioCueRAF()
      })
      return
    }
    const audio = wordAudioRef.current
    if (!audio) {
      const currentChunk = wordAudioChunksRef.current[wordAudioCurIdxRef.current] ?? wordAudioChunksRef.current[0]
      if (currentChunk) {
        void playWord(wordAudio.word, currentChunk.start)
        return
      }
      stopWordAudio()
      return
    }
    audio.play()
      .then(() => setWordAudio({ word: wordAudio.word, status: 'playing' }))
      .catch(() => showToast('Playback was blocked by the browser. Tap play again.'))
  }

  function toggleWordAudio() {
    if (!wordAudio) return
    if (wordAudio.status === 'loading') {
      stopWordAudio()
      return
    }
    if (wordAudio.status === 'playing') {
      if (browserSpeechActiveRef.current && canUseBrowserSpeech()) {
        window.speechSynthesis.pause()
        setWordAudio({ word: wordAudio.word, status: 'ready' })
        return
      }
      const ctx = wordAudioCtxRef.current
      const source = wordAudioSourceRef.current
      if (ctx && source && ctx.state === 'running') {
        stopWordAudioCueRAF()
        void ctx.suspend().then(() => setWordAudio({ word: wordAudio.word, status: 'ready' }))
        return
      }
      wordAudioRef.current?.pause()
      setWordAudio({ word: wordAudio.word, status: 'ready' })
      return
    }
    resumeWordAudio()
  }

  useEffect(() => {
    if (wordAudioRef.current) {
      wordAudioRef.current.playbackRate = rate
      return
    }
    if (rate === 1.0) return

    const ctx = wordAudioCtxRef.current
    const source = wordAudioSourceRef.current
    const ctrl = wordAudioAbortRef.current
    const idx = wordAudioCurIdxRef.current
    const chunk = wordAudioChunksRef.current[idx]
    if (!ctx || ctx.state === 'closed' || !source || !ctrl || ctrl.signal.aborted || !chunk?.url) {
      return
    }
    if (chunk.url === KOKORO_STREAM_URL) return

    const seekSec = wordAudioChunkSeekRef.current
    const elapsed = Math.max(0, ctx.currentTime - wordAudioChunkStartRef.current)
    const positionInChunk = Math.max(0, seekSec + elapsed)

    try {
      source.onended = null
      source.stop()
      source.disconnect()
    } catch { /* already stopped */ }
    wordAudioSourceRef.current = null
    stopWordAudioCueRAF()

    const word = wordAudio?.word ?? ''
    const audio = new Audio(chunk.url)
    audio.preservesPitch = true
    audio.playbackRate = rate
    wordAudioRef.current = audio
    clearPrimedWordAudioElement()

    const start = () => {
      try { audio.currentTime = positionInChunk } catch { /* ignore */ }
      void audio.play().catch(() => { /* ignore */ })
    }
    if (audio.readyState >= 1) {
      start()
    } else {
      audio.addEventListener('loadedmetadata', start, { once: true })
    }

    audio.ontimeupdate = () => {
      if (ctrl.signal.aborted) return
      syncAudioFollowCue(chunk, audio.currentTime, true)
    }
    audio.onended = () => {
      if (ctrl.signal.aborted) return
      void continueWordAudioPlayback(idx + 1, ctrl, word)
    }
    audio.onerror = () => {
      if (ctrl.signal.aborted) return
      showToast('Audio playback failed. Try starting it again.')
      stopWordAudio()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rate])

  useEffect(() => {
    const current = wordAudio
    if (!current || current.status === 'loading') return
    const chunks = wordAudioChunksRef.current
    const curIdx = wordAudioCurIdxRef.current
    const currentChunk = chunks[curIdx]
    if (!currentChunk) return
    void playWord(current.word, currentChunk.start, 'voice-switch')
  // playWord and wordAudio are intentionally not deps. This should fire only
  // when the committed provider/voice changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, voice])

  useEffect(() => () => {
    stopWordAudioCueRAF()
    wordAudioAbortRef.current?.abort()
    browserSpeechActiveRef.current = false
    if (canUseBrowserSpeech()) window.speechSynthesis.cancel()
    browserSpeechUtteranceRef.current = null
    try { wordAudioSourceRef.current?.stop(0); wordAudioSourceRef.current?.disconnect() } catch { /* already stopped */ }
    wordAudioSourceRef.current = null
    wordAudioCtxRef.current?.close().catch(() => {})
    wordAudioCtxRef.current = null
    wordAudioRef.current?.pause()
    wordAudioRef.current = null
    clearPrimedWordAudioElement()
    wordAudioChunkFetchesRef.current.clear()
    clearWordAudioObjectUrls()
  }, [])

  return {
    wordAudio,
    wordAudioPhase,
    wordAudioCurIdx,
    wordAudioTotal,
    playWord,
    toggleWordAudio,
    stopWordAudio,
    isAudioActive,
  }
}
