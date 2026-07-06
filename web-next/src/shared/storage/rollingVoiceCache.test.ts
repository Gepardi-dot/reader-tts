import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getCachedAudio: vi.fn(),
  putCachedAudio: vi.fn(),
  isModelReady: vi.fn(),
  localKokoroCacheKey: vi.fn(),
  synthesizeLocalStreaming: vi.fn(),
}))

vi.mock('./audioCache', () => ({
  getCachedAudio: mocks.getCachedAudio,
  putCachedAudio: mocks.putCachedAudio,
}))

vi.mock('./modelCache', () => ({
  LOCAL_KOKORO_CACHE_VERSION: 1,
  isModelReady: mocks.isModelReady,
  localKokoroCacheKey: mocks.localKokoroCacheKey,
  synthesizeLocalStreaming: mocks.synthesizeLocalStreaming,
}))

async function loadRollingCache() {
  return import('./rollingVoiceCache')
}

function startOptions() {
  return {
    bookId: 'book-1',
    voice: 'am_adam',
    speed: 1,
    text: 'hello world',
    grid: [{ start: 0, end: 5 }],
  }
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.useRealTimers()
  mocks.isModelReady.mockReturnValue(true)
  mocks.localKokoroCacheKey.mockResolvedValue('local:kokoro:test')
  mocks.getCachedAudio.mockResolvedValue(null)
  mocks.putCachedAudio.mockResolvedValue(undefined)
})

afterEach(async () => {
  vi.useRealTimers()
  vi.clearAllMocks()
  const mod = await loadRollingCache()
  mod.cancelRollingCache()
})

describe('rolling voice cache', () => {
  it('marks preparation failed instead of staying active when synthesis times out', async () => {
    vi.useFakeTimers()
    const cancel = vi.fn()
    mocks.synthesizeLocalStreaming.mockReturnValue({ cancel })

    const mod = await loadRollingCache()
    expect(mod.startRollingCache(startOptions())).toBe(true)
    await vi.waitFor(() => {
      expect(mocks.synthesizeLocalStreaming).toHaveBeenCalledTimes(1)
    })

    await vi.advanceTimersByTimeAsync(45_000)

    expect(cancel).toHaveBeenCalledTimes(1)
    expect(mod.getRollingCacheState()).toMatchObject({
      active: false,
      current: null,
      error: expect.stringContaining('timed out'),
    })
  })

  it('times out the whole chunk when cache lookup hangs before synthesis starts', async () => {
    vi.useFakeTimers()
    mocks.getCachedAudio.mockReturnValue(new Promise(() => undefined))
    mocks.synthesizeLocalStreaming.mockReturnValue({ cancel: vi.fn() })

    const mod = await loadRollingCache()
    expect(mod.startRollingCache(startOptions())).toBe(true)

    await vi.waitFor(() => {
      expect(mocks.localKokoroCacheKey).toHaveBeenCalledTimes(1)
    })
    await vi.advanceTimersByTimeAsync(45_000)

    expect(mocks.synthesizeLocalStreaming).not.toHaveBeenCalled()
    expect(mod.getRollingCacheState()).toMatchObject({
      active: false,
      current: null,
      error: expect.stringContaining('timed out'),
    })
  })

  it('resolves a cancelled background synth and retries after playback is idle', async () => {
    const cancels: Array<ReturnType<typeof vi.fn>> = []
    mocks.synthesizeLocalStreaming.mockImplementation(() => {
      const cancel = vi.fn()
      cancels.push(cancel)
      return { cancel }
    })

    const mod = await loadRollingCache()
    expect(mod.startRollingCache(startOptions())).toBe(true)

    await vi.waitFor(() => {
      expect(mocks.synthesizeLocalStreaming).toHaveBeenCalledTimes(1)
    })

    mod.notePlaybackFetchStart()

    await vi.waitFor(() => {
      expect(cancels[0]).toHaveBeenCalledTimes(1)
    })
    expect(mod.getRollingCacheState().active).toBe(true)

    mod.notePlaybackFetchEnd()

    await vi.waitFor(() => {
      expect(mocks.synthesizeLocalStreaming).toHaveBeenCalledTimes(2)
    })
  })
})
