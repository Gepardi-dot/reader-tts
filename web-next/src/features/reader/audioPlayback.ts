export const BROWSER_TTS_PROVIDER_ID = 'browser'
export const CLOUD_TTS_PROVIDER_ID = 'google'

export interface AudioTextChunk {
  start: number
  end: number
  text: string
}

// Streaming-style playback: keep the first request small so audio can start quickly,
// then synthesize larger follow-up chunks while the first chunk is playing.
export const FIRST_AUDIO_CHARS: Record<string, number> = {
  google: 240,
  kokoro: 65,
}

export const CHUNK_CHARS: Record<string, number> = {
  google: 420,
  kokoro: 420,
}

export const DEFAULT_FIRST_AUDIO_CHARS = 180
export const DEFAULT_AUDIO_CHARS = 800
export const PREFETCH_CHUNK_LIMIT = 3
export const AUDIO_SLICE_CHARS = 2200

// How many chunks to fire in parallel right when playback begins.
// The first chunk is awaited only when no instant browser mask is active.
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
export const PREFETCH_AHEAD_TARGET: Record<string, number> = {
  kokoro: 3,
}

export const DEFAULT_PREFETCH_AHEAD = 2

export interface PlaybackStartupPlan {
  startReadyChunkCount: number
  bootstrapCount: number
  useBrowserSpeech: boolean
  fetchNativeInBackground: boolean
}

export function isChunking(provider: string): boolean {
  return provider in CHUNK_CHARS
}

// Provider-tuned pacing
export function pacingFor(provider: string): { lengthScale: number; sentenceSilence: number } {
  if (provider === 'kokoro') return { lengthScale: 0.93, sentenceSilence: 0.38 }
  return { lengthScale: 1.0, sentenceSilence: 0.20 }
}

export function audioSliceStart(textLength: number, scrollPct: number) {
  if (textLength <= 0) return 0
  const rawStart = Math.round(scrollPct * textLength) - 200
  const maxStart = Math.max(0, textLength - AUDIO_SLICE_CHARS)
  return Math.max(0, Math.min(rawStart, maxStart))
}

/**
 * Split text into chunks at sentence boundaries.
 * Returns absolute offsets within the full book text so the backend can
 * validate each slice against the canonical book text.
 */
export function buildAudioChunks(
  fullText: string,
  globalStart: number,
  targetChars: number,
  firstTargetChars = targetChars,
): AudioTextChunk[] {
  const chunks: AudioTextChunk[] = []
  let localPos = 0

  while (localPos < fullText.length) {
    const isFirstChunk = chunks.length === 0
    const currentTarget = isFirstChunk ? firstTargetChars : targetChars
    const remaining = fullText.length - localPos
    if (remaining <= currentTarget) {
      chunks.push({
        start: globalStart + localPos,
        end: globalStart + fullText.length,
        text: fullText.slice(localPos),
      })
      break
    }

    const backtrack = isFirstChunk ? 60 : 100
    const lookahead = isFirstChunk ? 60 : 200
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

    const hardSlice = fullText.slice(localPos, localPos + currentTarget)
    const lastSpace = Math.max(
      hardSlice.lastIndexOf(' '),
      hardSlice.lastIndexOf('\n'),
      hardSlice.lastIndexOf('\t'),
    )
    const chunkLen = boundary >= 0
      ? searchStart + boundary
      : (lastSpace > currentTarget * 0.6 ? lastSpace + 1 : currentTarget)

    const localEnd = localPos + chunkLen
    const slice = fullText.slice(localPos, localEnd)
    if (slice.trim()) {
      chunks.push({ start: globalStart + localPos, end: globalStart + localEnd, text: slice })
    }
    localPos = localEnd
  }

  return chunks.filter((chunk) => chunk.text.trim())
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
  const boundedChunkCount = Math.max(0, Math.floor(chunkCount))
  const cloudBrowserMask = provider === CLOUD_TTS_PROVIDER_ID && browserSpeechSupported
  const useBrowserSpeech =
    provider === BROWSER_TTS_PROVIDER_ID ||
    (provider === 'kokoro' && !kokoroModelReady) ||
    cloudBrowserMask

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
    fetchNativeInBackground: cloudBrowserMask,
  }
}
