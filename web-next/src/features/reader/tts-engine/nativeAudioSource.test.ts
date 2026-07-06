import { describe, expect, it, vi } from 'vitest'
import { createNativeAudioSource, type NativeAudioSourceDeps } from './nativeAudioSource'
import type { TtsAudioChunk } from './types'

function buffer(duration: number) {
  return { duration } as AudioBuffer
}

function chunk(): TtsAudioChunk {
  return {
    id: 'chunk-0',
    index: 0,
    start: 10,
    end: 25,
    text: 'Hello world.',
    status: 'idle',
    url: null,
    buffer: null,
    cues: [],
    durationSec: null,
  }
}

function deps(overrides: Partial<NativeAudioSourceDeps> = {}): NativeAudioSourceDeps {
  return {
    isModelReady: vi.fn(() => true),
    waitForModelReady: vi.fn(async () => true),
    synthesizeKokoroLocal: vi.fn(async () => ({
      blob: new Blob(['kokoro'], { type: 'audio/wav' }),
      duration: 1.4,
      cacheKey: 'kokoro-cache',
      cacheHit: true,
    })),
    liveAudioCooldownRemainingMs: vi.fn(() => 0),
    requestLiveAudio: vi.fn(async () => ({
      url: '/library/audio.wav',
      duration: 2.5,
      cues: [{ start: 10, end: 15, timeStart: 0, timeEnd: 1 }],
      cacheHit: false,
      cacheStorage: 'generated',
    })),
    loadLiveAudioBlob: vi.fn(async (result) => ({
      blob: new Blob(['live'], { type: 'audio/wav' }),
      cues: result.cues ?? [],
    })),
    decodeAudioBlob: vi.fn(async () => buffer(3)),
    createObjectUrl: vi.fn(() => 'blob:live-audio'),
    now: vi.fn(() => 100),
    elapsedMs: vi.fn(() => 50),
    queueTelemetry: vi.fn(),
    ...overrides,
  }
}

describe('native audio source', () => {
  it('loads Kokoro audio with the selected voice and cache metadata', async () => {
    let selectionKey = 'kokoro:am_adam'
    const sourceDeps = deps()
    const source = createNativeAudioSource({
      getProvider: () => 'kokoro',
      getVoice: () => 'am_adam',
      getSelectionKey: () => selectionKey,
      ensureAudioContext: () => ({}) as AudioContext,
      trackObjectUrl: vi.fn(),
    }, sourceDeps)

    const result = await source(chunk(), new AbortController().signal, false)

    expect(sourceDeps.synthesizeKokoroLocal).toHaveBeenCalledWith(
      'Hello world.',
      'am_adam',
      expect.any(Number),
      expect.any(AbortSignal),
    )
    expect(sourceDeps.requestLiveAudio).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      url: null,
      buffer: buffer(3),
      durationSec: 1.4,
      cacheHit: true,
      cacheStorage: 'indexeddb',
    })
    selectionKey = 'kokoro:am_adam'
  })

  it('drops Kokoro work if the voice selection changes while waiting for the model', async () => {
    let selectionKey = 'kokoro:am_adam'
    const sourceDeps = deps({
      isModelReady: vi.fn(() => false),
      waitForModelReady: vi.fn(async () => {
        selectionKey = 'kokoro:af_bella'
        return true
      }),
    })
    const source = createNativeAudioSource({
      getProvider: () => 'kokoro',
      getVoice: () => 'am_adam',
      getSelectionKey: () => selectionKey,
      ensureAudioContext: () => ({}) as AudioContext,
      trackObjectUrl: vi.fn(),
    }, sourceDeps)

    await expect(source(chunk(), new AbortController().signal, false)).resolves.toBeNull()
    expect(sourceDeps.synthesizeKokoroLocal).not.toHaveBeenCalled()
  })

  it('loads live Gemini audio, decodes it, and tracks the object URL', async () => {
    const trackedUrls: string[] = []
    const sourceDeps = deps()
    const source = createNativeAudioSource({
      bookId: 'book-1',
      getProvider: () => 'google',
      getVoice: () => 'Puck',
      getSelectionKey: () => 'google:Puck',
      ensureAudioContext: () => ({}) as AudioContext,
      trackObjectUrl: (url) => trackedUrls.push(url),
    }, sourceDeps)

    const result = await source(chunk(), new AbortController().signal, true)

    expect(sourceDeps.requestLiveAudio).toHaveBeenCalledWith('book-1', expect.objectContaining({
      provider: 'google',
      voice: 'Puck',
      output_format: 'mp3',
      start: 10,
      end: 25,
      text: 'Hello world.',
    }))
    expect(sourceDeps.loadLiveAudioBlob).toHaveBeenCalled()
    expect(trackedUrls).toEqual(['blob:live-audio'])
    expect(result).toMatchObject({
      url: 'blob:live-audio',
      buffer: buffer(3),
      durationSec: 2.5,
      cacheHit: false,
      cacheStorage: 'generated',
    })
  })

  it('backs off live audio during provider cooldown without calling the network', async () => {
    const sourceDeps = deps({
      liveAudioCooldownRemainingMs: vi.fn(() => 12_500),
    })
    const source = createNativeAudioSource({
      bookId: 'book-1',
      getProvider: () => 'google',
      getVoice: () => 'Puck',
      getSelectionKey: () => 'google:Puck',
      ensureAudioContext: () => ({}) as AudioContext,
      trackObjectUrl: vi.fn(),
    }, sourceDeps)

    await expect(source(chunk(), new AbortController().signal, true)).resolves.toBeNull()
    expect(sourceDeps.requestLiveAudio).not.toHaveBeenCalled()
    expect(sourceDeps.queueTelemetry).toHaveBeenCalledWith(expect.objectContaining({
      eventName: 'tts.live_audio_backoff_v2',
      value: 13,
    }))
  })
})
