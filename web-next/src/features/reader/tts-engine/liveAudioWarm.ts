/**
 * Speculative live-audio warm for hosted Kokoro / Gemini.
 *
 * Called when the user selects text (before Play). By the time they tap Play,
 * the Worker + edge cache often already have the first chunk ready, so playback
 * starts from a memory/edge hit instead of a cold synth.
 */

import { pacingFor, pacingForPlaybackRate } from '../audioPlayback'
import { buildTtsChunks } from './segmenter'
import {
  liveAudioCooldownRemainingMs,
  requestLiveAudio,
  type LiveAudioPayload,
} from './liveAudio'

export interface WarmLiveAudioParams {
  bookId: string
  bookText: string
  startOffset: number
  provider: string
  voice: string | null
  /** UI playback rate — baked into Kokoro server length_scale for cache key match. */
  rate?: number
  /** How many leading chunks to warm (1–2). Two reduces inter-chunk stalls. */
  chunkCount?: number
  signal?: AbortSignal
}

/**
 * Fire-and-forget warm of the first N chunks from startOffset.
 * Safe to call repeatedly; requestLiveAudio dedupes identical in-flight keys.
 */
export async function warmLiveAudioFromOffset(params: WarmLiveAudioParams): Promise<void> {
  const {
    bookId,
    bookText,
    startOffset,
    provider,
    voice,
    rate = 1,
    chunkCount = 2,
    signal,
  } = params

  if (provider !== 'kokoro' && provider !== 'google') return
  if (!bookId || !bookText || signal?.aborted) return
  if (liveAudioCooldownRemainingMs(provider) > 0) return

  const chunks = buildTtsChunks({
    bookText,
    startOffset,
    provider,
    presynthGrid: null,
    kokoroModelReady: true,
  }).slice(0, Math.max(1, Math.min(2, chunkCount)))

  if (!chunks.length) return

  const { lengthScale, sentenceSilence } = provider === 'kokoro'
    ? pacingForPlaybackRate('kokoro', rate)
    : pacingFor(provider)

  // Parallel warm of first two slices — cuts boundary silence when user hits Play
  // after the book has been open for a moment.
  await Promise.all(chunks.map(async (chunk) => {
    if (signal?.aborted) return
    const payload: LiveAudioPayload = {
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
    }
    try {
      await requestLiveAudio(bookId, payload)
    } catch {
      // Warm is best-effort; Play will surface real errors.
    }
  }))
}
