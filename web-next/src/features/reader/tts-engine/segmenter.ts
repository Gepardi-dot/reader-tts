import {
  AUDIO_SLICE_CHARS,
  CHUNK_CHARS,
  DEFAULT_AUDIO_CHARS,
  DEFAULT_FIRST_AUDIO_CHARS,
  DEFAULT_SECOND_AUDIO_CHARS,
  FIRST_AUDIO_CHARS,
  SECOND_AUDIO_CHARS,
  buildAudioChunks,
  buildAudioChunksFromGridWindow,
  findGridChunk,
} from '../audioPlayback'
import type { TtsAudioChunk, TtsGridChunk } from './types'

export interface BuildTtsChunksParams {
  bookText: string
  startOffset: number
  provider: string
  presynthGrid: readonly TtsGridChunk[] | null
  kokoroModelReady: boolean
}

function toTtsChunk(
  chunk: { start: number; end: number; text: string },
  index: number,
): TtsAudioChunk {
  return {
    id: `${index}:${chunk.start}:${chunk.end}:${chunk.text.length}`,
    index,
    start: chunk.start,
    end: chunk.end,
    text: chunk.text,
    status: 'idle',
    url: null,
    buffer: null,
    cues: [],
    durationSec: null,
  }
}

export function buildTtsChunks({
  bookText,
  startOffset,
  provider,
  presynthGrid,
  kokoroModelReady,
}: BuildTtsChunksParams): TtsAudioChunk[] {
  const start = Math.max(0, Math.min(Math.floor(startOffset), bookText.length))
  if (!bookText.slice(start).trim()) return []

  const chunkSize = CHUNK_CHARS[provider] ?? DEFAULT_AUDIO_CHARS
  const firstChunkSize = FIRST_AUDIO_CHARS[provider] ?? DEFAULT_FIRST_AUDIO_CHARS
  const secondChunkSize = SECOND_AUDIO_CHARS[provider] ?? DEFAULT_SECOND_AUDIO_CHARS
  const useGrid = provider === 'kokoro' && !kokoroModelReady && presynthGrid && presynthGrid.length > 0

  if (useGrid) {
    const grid = [...presynthGrid]
    const chunkIdx = findGridChunk(grid, start)
    const raw = buildAudioChunksFromGridWindow({
      fullText: bookText,
      grid,
      start,
      windowChunks: 50,
      targetChars: chunkSize,
      firstTargetChars: firstChunkSize,
      secondTargetChars: secondChunkSize,
    })

    const fallback = raw.length > 0
      ? raw
      : grid.slice(chunkIdx, chunkIdx + 50)
        .map((item) => ({
          start: Math.max(item.start, start),
          end: item.end,
          text: bookText.slice(Math.max(item.start, start), item.end),
        }))
        .filter((item) => item.text.trim())

    return fallback.map(toTtsChunk)
  }

  const end = Math.min(bookText.length, start + AUDIO_SLICE_CHARS)
  const snippet = bookText.slice(start, end)
  return buildAudioChunks(snippet, start, chunkSize, firstChunkSize, secondChunkSize).map(toTtsChunk)
}

