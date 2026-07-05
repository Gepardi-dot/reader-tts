import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getCachedAudio: vi.fn(),
  putCachedAudio: vi.fn(),
  isModelReady: vi.fn(),
  localKokoroCacheKey: vi.fn(),
  synthesizeLocalStreaming: vi.fn(),
  notePlaybackFetchStart: vi.fn(),
  notePlaybackFetchEnd: vi.fn(),
}))

vi.mock('@/shared/storage/audioCache', () => ({
  getCachedAudio: mocks.getCachedAudio,
  putCachedAudio: mocks.putCachedAudio,
}))

vi.mock('@/shared/storage/modelCache', () => ({
  LOCAL_KOKORO_CACHE_VERSION: 1,
  isModelReady: mocks.isModelReady,
  localKokoroCacheKey: mocks.localKokoroCacheKey,
  synthesizeLocalStreaming: mocks.synthesizeLocalStreaming,
}))

vi.mock('@/shared/storage/rollingVoiceCache', () => ({
  notePlaybackFetchStart: mocks.notePlaybackFetchStart,
  notePlaybackFetchEnd: mocks.notePlaybackFetchEnd,
}))

import { synthesizeKokoroLocal } from './kokoroAudio'

describe('kokoro audio helper', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.isModelReady.mockReturnValue(true)
    mocks.localKokoroCacheKey.mockResolvedValue('local:kokoro:test')
    mocks.getCachedAudio.mockResolvedValue(null)
    mocks.putCachedAudio.mockResolvedValue(undefined)
    mocks.synthesizeLocalStreaming.mockImplementation((
      _text: string,
      _voice: string,
      _speed: number,
      handle: { onComplete: (result: { wav: ArrayBuffer; sampleRate: number; durationSec: number }) => void },
    ) => {
      handle.onComplete({
        wav: new Uint8Array([1, 2, 3]).buffer,
        sampleRate: 24_000,
        durationSec: 1.25,
      })
      return { cancel: vi.fn() }
    })
  })

  it('returns null while the model is not ready', async () => {
    mocks.isModelReady.mockReturnValue(false)

    await expect(synthesizeKokoroLocal('hello', 'af_bella', 1, new AbortController().signal))
      .resolves.toBeNull()

    expect(mocks.localKokoroCacheKey).not.toHaveBeenCalled()
    expect(mocks.synthesizeLocalStreaming).not.toHaveBeenCalled()
  })

  it('returns cached audio without starting synthesis', async () => {
    const cachedBlob = new Blob(['cached'], { type: 'audio/wav' })
    mocks.getCachedAudio.mockResolvedValue({
      blob: cachedBlob,
      duration: 2.5,
    })

    const result = await synthesizeKokoroLocal('hello', 'af_bella', 1, new AbortController().signal)

    expect(result).toEqual({
      blob: cachedBlob,
      duration: 2.5,
      cacheKey: 'local:kokoro:test',
      cacheHit: true,
    })
    expect(mocks.notePlaybackFetchStart).not.toHaveBeenCalled()
    expect(mocks.synthesizeLocalStreaming).not.toHaveBeenCalled()
  })

  it('synthesizes and caches a local WAV on cache miss', async () => {
    const result = await synthesizeKokoroLocal('hello', 'af_bella', 1, new AbortController().signal)

    expect(result?.cacheHit).toBe(false)
    expect(result?.cacheKey).toBe('local:kokoro:test')
    expect(result?.duration).toBe(1.25)
    expect(result?.blob.type).toBe('audio/wav')
    expect(mocks.notePlaybackFetchStart).toHaveBeenCalledTimes(1)
    expect(mocks.notePlaybackFetchEnd).toHaveBeenCalledTimes(1)
    expect(mocks.putCachedAudio).toHaveBeenCalledWith(expect.objectContaining({
      cacheKey: 'local:kokoro:test',
      cacheVersion: 1,
      duration: 1.25,
      contentType: 'audio/wav',
    }))
  })
})

