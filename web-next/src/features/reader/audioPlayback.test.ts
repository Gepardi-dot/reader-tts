import { describe, expect, it } from 'vitest'
import {
  BROWSER_TTS_PROVIDER_ID,
  audioSliceStart,
  buildAudioChunks,
  buildPlaybackStartupPlan,
  findGridChunk,
  isChunking,
  patchAudioChunk,
  pacingFor,
} from './audioPlayback'

describe('audio playback chunking', () => {
  it('builds absolute-offset chunks and prefers sentence boundaries', () => {
    const text = `One short sentence. ${'middle '.repeat(20)}Final sentence.`
    const chunks = buildAudioChunks(text, 120, 34, 24)

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0]).toEqual({
      start: 120,
      end: 120 + 'One short sentence.'.length,
      text: 'One short sentence.',
    })
    expect(chunks.map((chunk) => chunk.text).join('')).toBe(text)
    expect(chunks.at(-1)?.end).toBe(120 + text.length)
  })

  it('clamps scroll-based audio slices into the readable text', () => {
    expect(audioSliceStart(0, 0.5)).toBe(0)
    expect(audioSliceStart(1000, 1)).toBe(0)
    expect(audioSliceStart(5000, 0)).toBe(0)
    expect(audioSliceStart(5000, 1)).toBe(2800)
  })

  it('finds the grid chunk containing a tapped offset', () => {
    const grid = [
      { start: 0, end: 100 },
      { start: 100, end: 240 },
      { start: 240, end: 420 },
    ]

    expect(findGridChunk(grid, 0)).toBe(0)
    expect(findGridChunk(grid, 100)).toBe(1)
    expect(findGridChunk(grid, 419)).toBe(2)
  })
})

describe('audio playback startup plan', () => {
  it('keeps browser speech local and does not request native audio', () => {
    expect(buildPlaybackStartupPlan({
      provider: BROWSER_TTS_PROVIDER_ID,
      chunkCount: 4,
      browserSpeechSupported: true,
      kokoroModelReady: false,
    })).toMatchObject({
      useBrowserSpeech: true,
      fetchNativeInBackground: false,
    })
  })

  it('masks Gemini cloud startup with browser speech while fetching native audio', () => {
    expect(buildPlaybackStartupPlan({
      provider: 'google',
      chunkCount: 4,
      browserSpeechSupported: true,
      kokoroModelReady: true,
    })).toEqual({
      startReadyChunkCount: 1,
      bootstrapCount: 2,
      useBrowserSpeech: true,
      fetchNativeInBackground: true,
    })
  })

  it('falls back to native startup when browser speech is unavailable for Gemini', () => {
    expect(buildPlaybackStartupPlan({
      provider: 'google',
      chunkCount: 1,
      browserSpeechSupported: false,
      kokoroModelReady: true,
    })).toEqual({
      startReadyChunkCount: 1,
      bootstrapCount: 1,
      useBrowserSpeech: false,
      fetchNativeInBackground: false,
    })
  })

  it('uses browser speech for cold Kokoro without pretending native audio is ready', () => {
    expect(buildPlaybackStartupPlan({
      provider: 'kokoro',
      chunkCount: 3,
      browserSpeechSupported: true,
      kokoroModelReady: false,
    })).toMatchObject({
      bootstrapCount: 2,
      useBrowserSpeech: true,
      fetchNativeInBackground: false,
    })
  })

  it('uses native Kokoro startup once the model is warm', () => {
    expect(buildPlaybackStartupPlan({
      provider: 'kokoro',
      chunkCount: 3,
      browserSpeechSupported: true,
      kokoroModelReady: true,
    })).toMatchObject({
      startReadyChunkCount: 1,
      bootstrapCount: 2,
      useBrowserSpeech: false,
    })
  })

  it('keeps provider metadata explicit', () => {
    expect(isChunking('google')).toBe(true)
    expect(isChunking(BROWSER_TTS_PROVIDER_ID)).toBe(false)
    expect(pacingFor('kokoro')).toEqual({ lengthScale: 0.93, sentenceSilence: 0.38 })
    expect(pacingFor('google')).toEqual({ lengthScale: 1.0, sentenceSilence: 0.20 })
  })
})

describe('audio chunk patching', () => {
  it('patches a chunk in place without replacing the chunk array', () => {
    const chunks = [
      { start: 0, end: 5, text: 'hello', status: 'idle' },
      { start: 5, end: 11, text: ' world', status: 'idle' },
    ]
    const originalArray = chunks
    const originalChunk = chunks[1]

    const patched = patchAudioChunk(chunks, 1, { status: 'ready' })

    expect(patched).toBe(true)
    expect(chunks).toBe(originalArray)
    expect(chunks[1]).toBe(originalChunk)
    expect(chunks[1].status).toBe('ready')
  })

  it('returns false for a missing chunk', () => {
    const chunks = [{ start: 0, end: 5, text: 'hello', status: 'idle' }]

    expect(patchAudioChunk(chunks, 3, { status: 'ready' })).toBe(false)
    expect(chunks).toEqual([{ start: 0, end: 5, text: 'hello', status: 'idle' }])
  })
})
