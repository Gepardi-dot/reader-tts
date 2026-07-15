import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  audioErrorMessage,
  liveAudioCooldownRemainingMs,
  requestLiveAudio,
  resetLiveAudioCooldownForTests,
  type LiveAudioPayload,
} from './liveAudio'

vi.mock('@/shared/api/client', () => ({
  request: vi.fn(),
  requestBlob: vi.fn(),
}))

vi.mock('@/shared/storage/audioCache', () => ({
  getCachedAudio: vi.fn(),
  putCachedAudio: vi.fn(),
}))

const { request } = await import('@/shared/api/client')
const { getCachedAudio, putCachedAudio } = await import('@/shared/storage/audioCache')
const requestMock = vi.mocked(request)
const getCachedAudioMock = vi.mocked(getCachedAudio)
const putCachedAudioMock = vi.mocked(putCachedAudio)

function payload(): LiveAudioPayload {
  return {
    provider: 'google',
    voice: 'Kore',
    model: null,
    output_format: 'mp3',
    narration_style: '',
    length_scale: 1,
    sentence_silence: 0.2,
    pageNumber: 1,
    start: 0,
    end: 5,
    text: 'hello',
  }
}

beforeEach(() => {
  resetLiveAudioCooldownForTests()
  requestMock.mockReset()
  getCachedAudioMock.mockReset()
  putCachedAudioMock.mockReset()
  getCachedAudioMock.mockResolvedValue(null)
  putCachedAudioMock.mockResolvedValue(undefined)
})

describe('live audio quota backoff', () => {
  it('starts a cooldown after Gemini reports a retry delay', async () => {
    requestMock.mockRejectedValueOnce(new Error('429: RESOURCE_EXHAUSTED. Please retry in 12.5s.'))

    await expect(requestLiveAudio('book-1', payload())).rejects.toThrow(/RESOURCE_EXHAUSTED/)

    expect(liveAudioCooldownRemainingMs('google')).toBeGreaterThan(10_000)
    await expect(requestLiveAudio('book-1', payload())).rejects.toThrow(/cooling down/)
    expect(requestMock).toHaveBeenCalledTimes(1)
  })

  it('surfaces quota errors as browser-fallback guidance', () => {
    expect(audioErrorMessage(new Error('429: RESOURCE_EXHAUSTED quota exceeded'))).toBe(
      'Gemini TTS hit the free-tier rate limit. Browser speech will continue; try Gemini again shortly.',
    )
  })

  it('keeps separate memory cache entries for different Gemini voices', async () => {
    requestMock.mockResolvedValue({
      url: 'data:audio/wav;base64,test',
      duration: 1,
    })

    await requestLiveAudio('book-1', { ...payload(), voice: 'Kore' })
    await requestLiveAudio('book-1', { ...payload(), voice: 'Puck' })

    expect(requestMock).toHaveBeenCalledTimes(2)
  })

  it('serves IndexedDB hits without calling the network (survives refresh)', async () => {
    getCachedAudioMock.mockResolvedValueOnce({
      cacheKey: 'client-key',
      cacheVersion: 2,
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' }),
      cues: [],
      duration: 1.2,
      contentType: 'audio/wav',
      createdAt: 0,
      lastAccessedAt: 0,
      byteLength: 3,
      id: 'x',
      userId: 'u',
    })

    const result = await requestLiveAudio('book-1', payload())
    expect(result.cacheStorage).toBe('indexeddb')
    expect(result.cacheHit).toBe(true)
    expect(requestMock).not.toHaveBeenCalled()
  })
})
