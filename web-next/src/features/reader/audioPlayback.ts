export const BROWSER_TTS_PROVIDER_ID = 'browser'
export const CLOUD_TTS_PROVIDER_ID = 'google'
export const SILENT_WAV_DATA_URL = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA='

export interface AudioTextChunk {
  start: number
  end: number
  text: string
}

// Progressive chunk ramp:
//   chunk 0 → short (~1.5–2s speech) so first synth is quick on Fly
//   chunk 1 → medium while 0 plays
//   chunk 2+ → steady
// Speech ≈ 14–18 chars/sec; ~70 chars ≈ 1.5–2s of cushion after first audio starts.
export const FIRST_AUDIO_CHARS: Record<string, number> = {
  google: 100,
  // Shorter = faster cold synth; follow-up fills while this plays.
  kokoro: 70,
}

/** Second slice after the first; bridges until steady-state chunks arrive. */
export const SECOND_AUDIO_CHARS: Record<string, number> = {
  google: 200,
  kokoro: 180,
}

export const CHUNK_CHARS: Record<string, number> = {
  google: 280,
  kokoro: 280,
}

export const DEFAULT_FIRST_AUDIO_CHARS = 180
export const DEFAULT_SECOND_AUDIO_CHARS = 220
export const DEFAULT_AUDIO_CHARS = 800
export const PREFETCH_CHUNK_LIMIT = 3
export const AUDIO_SLICE_CHARS = 2200
// Slight lead hides scheduling jitter between concatenated PCM frames.
export const AUDIO_CONTEXT_START_LEAD_SEC = 0.008

// How many chunks to bootstrap when playback begins. Cloud chunks are fetched
// sequentially by the native queue so Gemini quota is not burned in bursts.
// Native providers stay native-first so the selected voice is always honored.
export const PLAYBACK_BOOTSTRAP_CHUNKS: Record<string, number> = {
  google: 2,
  kokoro: 2,
}

// How many native chunks we wait for before pressing play. Set to 1 everywhere
// so audio starts the instant the first slice is decoded.
export const START_PLAYBACK_READY_CHUNKS: Record<string, number> = {
  kokoro: 1,
}

// Rolling window of chunks we keep in flight ahead of the cursor while playing.
// Keep this modest: hosted Kokoro is one machine — parallel storms delay first audio.
export const PREFETCH_AHEAD_TARGET: Record<string, number> = {
  google: 1,
  kokoro: 2,
}

/** Char budget for the Nth chunk in the progressive ramp (0-based). */
export function targetCharsForChunkIndex(provider: string, index: number): number {
  if (index <= 0) return FIRST_AUDIO_CHARS[provider] ?? DEFAULT_FIRST_AUDIO_CHARS
  if (index === 1) {
    return SECOND_AUDIO_CHARS[provider]
      ?? CHUNK_CHARS[provider]
      ?? DEFAULT_SECOND_AUDIO_CHARS
  }
  return CHUNK_CHARS[provider] ?? DEFAULT_AUDIO_CHARS
}

export const DEFAULT_PREFETCH_AHEAD = 2

export interface PlaybackStartupPlan {
  startReadyChunkCount: number
  bootstrapCount: number
  useBrowserSpeech: boolean
  fetchNativeInBackground: boolean
}

export function committedVoiceForDraft(provider: string, draftVoice: string | null | undefined): string | null {
  // Legacy browser id had no voice; all remaining providers need a voice id.
  if (provider === BROWSER_TTS_PROVIDER_ID) return null
  return draftVoice ?? null
}

export function audioSelectionKey(provider: string, voice: string | null | undefined): string {
  return `${provider}:${voice ?? ''}`
}

export function audioPreferenceDraftChanged({
  committedProvider,
  committedVoice,
  draftProvider,
  draftVoice,
}: {
  committedProvider: string
  committedVoice: string | null | undefined
  draftProvider: string
  draftVoice: string | null | undefined
}): boolean {
  return committedProvider !== draftProvider ||
    (committedVoice ?? null) !== committedVoiceForDraft(draftProvider, draftVoice)
}

export function patchAudioChunk<T extends object>(
  chunks: T[],
  idx: number,
  patch: Partial<T>,
): boolean {
  const chunk = chunks[idx]
  if (!chunk) return false
  Object.assign(chunk, patch)
  return true
}

export function audioBufferSourceStartTime(
  currentTime: number,
  scheduledEnd: number,
  leadSeconds = AUDIO_CONTEXT_START_LEAD_SEC,
): number {
  const safeCurrentTime = Number.isFinite(currentTime) ? currentTime : 0
  const safeScheduledEnd = Number.isFinite(scheduledEnd) ? scheduledEnd : 0
  const safeLead = Math.max(0, Number.isFinite(leadSeconds) ? leadSeconds : 0)
  return Math.max(safeCurrentTime + safeLead, safeScheduledEnd)
}

export function audioBufferScheduledEndTime({
  startAt,
  bufferDuration,
  seekSeconds = 0,
  playbackRate = 1,
}: {
  startAt: number
  bufferDuration: number
  seekSeconds?: number
  playbackRate?: number
}): number {
  const safeStartAt = Number.isFinite(startAt) ? startAt : 0
  const safeDuration = Math.max(0, Number.isFinite(bufferDuration) ? bufferDuration : 0)
  const safeSeek = Math.max(0, Math.min(
    safeDuration,
    Number.isFinite(seekSeconds) ? seekSeconds : 0,
  ))
  const safeRate = playbackRate > 0 && Number.isFinite(playbackRate) ? playbackRate : 1
  return safeStartAt + Math.max(0, safeDuration - safeSeek) / safeRate
}

export function tapOffsetSeekSeconds(
  chunkStart: number,
  tapOffset: number | null | undefined,
  cues: readonly { start: number; timeStart: number }[] | null | undefined,
): number {
  if (tapOffset == null || tapOffset <= chunkStart || !cues?.length) return 0
  const seekCue = cues.find((cue) => cue.start >= tapOffset)
  return seekCue ? Math.max(0, seekCue.timeStart) : 0
}

export function browserSpeechQueueTarget(activeIdx: number, chunkCount: number, ahead = 1): number {
  if (chunkCount <= 0) return -1
  const safeIdx = Math.max(0, Math.floor(activeIdx))
  const safeAhead = Math.max(0, Math.floor(ahead))
  return Math.min(chunkCount - 1, safeIdx + safeAhead)
}

export function isChunking(provider: string): boolean {
  return provider in CHUNK_CHARS
}

// Provider-tuned pacing
export function pacingFor(provider: string): { lengthScale: number; sentenceSilence: number } {
  if (provider === 'kokoro') return { lengthScale: 0.93, sentenceSilence: 0.38 }
  return { lengthScale: 1.0, sentenceSilence: 0.20 }
}

/**
 * Hosted Kokoro: bake UI speed into server length_scale so the remote model
 * synthesizes at the listening rate (natural pitch). Worker uses speed = 1/length_scale.
 * Gemini keeps base pacing; client HTMLAudio preservesPitch handles UI rate.
 */
export function pacingForPlaybackRate(
  provider: string,
  playbackRate: number,
): { lengthScale: number; sentenceSilence: number } {
  const base = pacingFor(provider)
  if (provider !== 'kokoro') return base
  const rate = playbackRate > 0 && Number.isFinite(playbackRate) ? playbackRate : 1
  // Clamp so free-tier / server stays in a sane band (matches kokoro_server 0.5–2.0 speed).
  const safeRate = Math.max(0.5, Math.min(2, rate))
  return {
    lengthScale: base.lengthScale / safeRate,
    sentenceSilence: base.sentenceSilence,
  }
}

/** Client clock rate: Kokoro speed is server-side; Gemini uses pitch-preserving HTML. */
export function clientClockRateForProvider(provider: string, playbackRate: number): number {
  if (provider === 'kokoro') return 1
  return playbackRate > 0 && Number.isFinite(playbackRate) ? playbackRate : 1
}

export function audioSliceStart(textLength: number, scrollPct: number) {
  if (textLength <= 0) return 0
  const rawStart = Math.round(scrollPct * textLength) - 200
  const maxStart = Math.max(0, textLength - AUDIO_SLICE_CHARS)
  return Math.max(0, Math.min(rawStart, maxStart))
}

/**
 * Split text into chunks at sentence boundaries with a progressive size ramp.
 * Returns absolute offsets within the full book text so the backend can
 * validate each slice against the canonical book text.
 *
 * @param targetChars steady-state size (chunk index ≥ 2)
 * @param firstTargetChars chunk 0 (fast start)
 * @param secondTargetChars chunk 1 (bridge)
 */
export function buildAudioChunks(
  fullText: string,
  globalStart: number,
  targetChars: number,
  firstTargetChars = targetChars,
  secondTargetChars = targetChars,
): AudioTextChunk[] {
  const chunks: AudioTextChunk[] = []
  let localPos = 0

  while (localPos < fullText.length) {
    const index = chunks.length
    const isFirstChunk = index === 0
    const isSecondChunk = index === 1
    const currentTarget = isFirstChunk
      ? firstTargetChars
      : isSecondChunk
        ? secondTargetChars
        : targetChars
    const remaining = fullText.length - localPos
    if (remaining <= currentTarget) {
      chunks.push({
        start: globalStart + localPos,
        end: globalStart + fullText.length,
        text: fullText.slice(localPos),
      })
      break
    }

    // Prefer real sentence ends, especially on the short first slice.
    const backtrack = isFirstChunk ? 48 : isSecondChunk ? 80 : 100
    const lookahead = isFirstChunk ? 90 : isSecondChunk ? 140 : 200
    const searchStart = Math.max(0, currentTarget - backtrack)
    const searchWindow = fullText.slice(
      localPos + searchStart,
      localPos + currentTarget + lookahead,
    )
    let boundary = -1
    for (let i = searchWindow.length - 1; i >= 0; i -= 1) {
      if (/[.!?]/.test(searchWindow[i]) && /[\s"']/.test(searchWindow[i + 1] ?? ' ')) {
        boundary = i + 1
        break
      }
    }

    // First chunk: also accept early sentence end in the first half of the window
    // so we start on a full short sentence when possible.
    if (isFirstChunk && boundary < 0) {
      for (let i = 0; i < searchWindow.length; i += 1) {
        if (/[.!?]/.test(searchWindow[i]) && /[\s"']/.test(searchWindow[i + 1] ?? ' ')) {
          const abs = searchStart + i + 1
          if (abs >= Math.min(28, currentTarget * 0.45)) {
            boundary = i + 1
            break
          }
        }
      }
    }

    const hardSlice = fullText.slice(localPos, localPos + currentTarget)
    const lastSpace = Math.max(
      hardSlice.lastIndexOf(' '),
      hardSlice.lastIndexOf('\n'),
      hardSlice.lastIndexOf('\t'),
    )
    const minSpaceRatio = isFirstChunk ? 0.45 : 0.6
    const chunkLen = boundary >= 0
      ? searchStart + boundary
      : (lastSpace > currentTarget * minSpaceRatio ? lastSpace + 1 : currentTarget)

    const localEnd = localPos + chunkLen
    const slice = fullText.slice(localPos, localEnd)
    if (slice.trim()) {
      chunks.push({ start: globalStart + localPos, end: globalStart + localEnd, text: slice })
    }
    localPos = localEnd
  }

  return chunks.filter((chunk) => chunk.text.trim())
}

export function buildAudioChunksFromGridWindow({
  fullText,
  grid,
  start,
  windowChunks,
  targetChars,
  firstTargetChars,
  secondTargetChars,
}: {
  fullText: string
  grid: Array<{ start: number; end: number }>
  start: number
  windowChunks: number
  targetChars: number
  firstTargetChars: number
  secondTargetChars?: number
}): AudioTextChunk[] {
  if (!fullText || grid.length === 0 || windowChunks <= 0) return []
  const boundedStart = Math.max(0, Math.min(start, fullText.length))
  const chunkIdx = findGridChunk(grid, boundedStart)
  const lastGridIdx = Math.min(grid.length - 1, chunkIdx + Math.max(1, Math.floor(windowChunks)) - 1)
  const boundedEnd = Math.max(boundedStart, Math.min(grid[lastGridIdx]?.end ?? boundedStart, fullText.length))
  const snippet = fullText.slice(boundedStart, boundedEnd)
  return buildAudioChunks(
    snippet,
    boundedStart,
    targetChars,
    firstTargetChars,
    secondTargetChars ?? targetChars,
  )
}

// Binary search: find the grid chunk whose range contains `offset`.
export function findGridChunk(grid: Array<{ start: number; end: number }>, offset: number): number {
  let lo = 0
  let hi = grid.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (grid[mid].end <= offset) lo = mid + 1
    else hi = mid
  }
  return lo
}

export function buildPlaybackStartupPlan({
  provider,
  chunkCount,
  browserSpeechSupported,
  kokoroModelReady,
}: {
  provider: string
  chunkCount: number
  browserSpeechSupported: boolean
  kokoroModelReady: boolean
}): PlaybackStartupPlan {
  void browserSpeechSupported
  void kokoroModelReady
  const boundedChunkCount = Math.max(0, Math.floor(chunkCount))
  const useBrowserSpeech = provider === BROWSER_TTS_PROVIDER_ID

  const startReadyChunkCount = Math.min(
    boundedChunkCount,
    START_PLAYBACK_READY_CHUNKS[provider] ?? 1,
  )
  const bootstrapCount = Math.min(
    boundedChunkCount,
    Math.max(PLAYBACK_BOOTSTRAP_CHUNKS[provider] ?? 1, startReadyChunkCount),
  )

  return {
    startReadyChunkCount,
    bootstrapCount,
    useBrowserSpeech,
    fetchNativeInBackground: false,
  }
}

export function shouldPrimeNativeAudio(startupPlan: PlaybackStartupPlan): boolean {
  return startupPlan.fetchNativeInBackground || !startupPlan.useBrowserSpeech
}

export function shouldBridgeNativeAudioGap(provider: string, browserSpeechSupported: boolean): boolean {
  void provider
  void browserSpeechSupported
  return false
}

export function nativePrefetchStartIndexForFallback(provider: string, currentIndex: number) {
  const safeIndex = Math.max(0, Math.floor(currentIndex))
  void provider
  return safeIndex
}
