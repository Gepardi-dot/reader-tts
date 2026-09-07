import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  audioErrorMessage,
  LIVE_AUDIO_FETCH_TIMEOUT_MS,
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
    expect(audioErrorMessage(new Error(
      '502: Hosted Kokoro timed out (Fly may be stopped or cold). Restart: fly machines list',
    ))).toMatch(/timed out|waking up/i)

    expect(audioErrorMessage(new Error(
      '502: {"detail":"Hosted Kokoro failed (502): connection refused"}',
    ))).toMatch(/unavailable|server/i)

    expect(audioErrorMessage(new Error(
      'Kokoro is still downloading. Wait for the voice to finish preparing, then tap again.',
    ))).toMatch(/on-device|preparing|hosted Kokoro/i)

    // Must NOT mislabel hosted failures as on-device.
    expect(audioErrorMessage(new Error('Hosted Kokoro unreachable: timeout'))).not.toMatch(/on-device/i)

    expect(audioErrorMessage(new Error('429: RESOURCE_EXHAUSTED quota exceeded'))).toBe(
      'Gemini TTS hit the free-tier rate limit. Try again shortly, or use Kokoro.',
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

  it('times out a hung live-audio request so a later Play is not stuck on it', async () => {
    vi.useFakeTimers()
    requestMock.mockImplementation(() => new Promise(() => {}))

    const pending = requestLiveAudio('book-1', { ...payload(), provider: 'kokoro' })
    const expectation = expect(pending).rejects.toThrow(/timed out/i)
    await vi.advanceTimersByTimeAsync(LIVE_AUDIO_FETCH_TIMEOUT_MS + 10)
    await expectation

    requestMock.mockReset()
    requestMock.mockResolvedValue({
      url: 'data:audio/wav;base64,test',
      duration: 1,
    })
    await expect(requestLiveAudio('book-1', { ...payload(), provider: 'kokoro' })).resolves.toMatchObject({
      duration: 1,
    })
    expect(requestMock).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('does not let a cancelled warmup abort an in-flight Play for the same passage', async () => {
    let resolveRequest: ((value: { url: string; duration: number }) => void) | undefined
    requestMock.mockImplementation(() => new Promise((resolve) => {
      resolveRequest = resolve
    }))

    const warm = new AbortController()
    const play = new AbortController()
    const warmPending = requestLiveAudio('book-1', payload(), warm.signal)
    const playPending = requestLiveAudio('book-1', payload(), play.signal)
    await vi.waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1))

    warm.abort()
    await expect(warmPending).rejects.toThrow(/Audio request aborted/)

    resolveRequest?.({ url: 'data:audio/wav;base64,test', duration: 1.5 })
    await expect(playPending).resolves.toMatchObject({ duration: 1.5 })
    expect(play.signal.aborted).toBe(false)
    expect(requestMock).toHaveBeenCalledTimes(1)
  })

  it('retries a disconnected live-audio fetch so idle/frozen tabs can Play again', async () => {
    vi.useFakeTimers()
    requestMock
      .mockRejectedValueOnce(Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' }))
      .mockResolvedValueOnce({
        url: 'data:audio/wav;base64,test',
        duration: 2,
      })

    const pending = requestLiveAudio('book-1', { ...payload(), provider: 'kokoro' })
    const expectation = expect(pending).resolves.toMatchObject({ duration: 2 })
    await vi.advanceTimersByTimeAsync(500)
    await expectation
    expect(requestMock).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('starts a fresh fetch after warmup is cancelled with no Play waiter', async () => {
    requestMock.mockImplementation(() => new Promise(() => {}))
    const warm = new AbortController()
    const warmPending = requestLiveAudio('book-1', payload(), warm.signal)
    await vi.waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1))
    warm.abort()
    await expect(warmPending).rejects.toThrow(/Audio request aborted/)

    requestMock.mockReset()
    requestMock.mockResolvedValue({
      url: 'data:audio/wav;base64,test',
      duration: 3,
    })
    await expect(requestLiveAudio('book-1', payload())).resolves.toMatchObject({ duration: 3 })
    expect(requestMock).toHaveBeenCalledTimes(1)
  })

  it('does not retry when this Play was cancelled', async () => {
    requestMock.mockImplementation(() => new Promise(() => {}))
    const play = new AbortController()
    const pending = requestLiveAudio('book-1', payload(), play.signal)
    await vi.waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1))
    play.abort()
    await expect(pending).rejects.toThrow(/Audio request aborted/)
    expect(requestMock).toHaveBeenCalledTimes(1)
  })

  it('maps leftover abort errors to a retry prompt instead of the raw message', () => {
    expect(audioErrorMessage(new Error('Audio request aborted.'))).toBe(
      'Could not start audio. Tap Play again.',
    )
    expect(audioErrorMessage(Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' })))
      .toBe('Could not start audio. Tap Play again.')
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
