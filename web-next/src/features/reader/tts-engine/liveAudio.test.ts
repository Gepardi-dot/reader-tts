import { afterEach, describe, expect, it, vi } from 'vitest'
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
const requestMock = vi.mocked(request)

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

afterEach(() => {
  resetLiveAudioCooldownForTests()
  requestMock.mockReset()
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
})
