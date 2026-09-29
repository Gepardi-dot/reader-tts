// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { holdScreenAwake, releaseScreenAwake, screenWakeForPhase } from './screenWakeLock'

class FakeSentinel extends EventTarget {
  released = false
  type = 'screen' as const
  readonly release = vi.fn(async () => {
    if (this.released) return
    this.released = true
    this.dispatchEvent(new Event('release'))
  })
}

function installWakeLock() {
  const sentinels: FakeSentinel[] = []
  const request = vi.fn(async (_type: 'screen') => {
    const sentinel = new FakeSentinel()
    sentinels.push(sentinel)
    return sentinel as unknown as WakeLockSentinel
  })
  vi.stubGlobal('navigator', { ...navigator, wakeLock: { request } })
  return { request, sentinels }
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  })
}

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('screenWakeLock', () => {
  afterEach(() => {
    releaseScreenAwake()
    setVisibility('visible')
    vi.unstubAllGlobals()
  })

  it('requests a screen lock while speech is playing and releases it on pause', async () => {
    const { request, sentinels } = installWakeLock()

    screenWakeForPhase('playing')
    await flush()

    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith('screen')
    expect(sentinels[0]?.release).not.toHaveBeenCalled()

    screenWakeForPhase('paused')
    await flush()

    expect(sentinels[0]?.release).toHaveBeenCalledTimes(1)
  })

  it('keeps the lock across stop and start in the same turn', async () => {
    const { request, sentinels } = installWakeLock()

    screenWakeForPhase('playing')
    await flush()
    screenWakeForPhase('idle')
    screenWakeForPhase('buffering')
    await flush()

    expect(request).toHaveBeenCalledTimes(1)
    expect(sentinels[0]?.release).not.toHaveBeenCalled()
    expect(sentinels[0]?.released).toBe(false)
  })

  it('does not drop the lock when the page hides, and asks again when it shows', async () => {
    const { request, sentinels } = installWakeLock()

    holdScreenAwake()
    await flush()
    const first = sentinels[0]!
    expect(request).toHaveBeenCalledTimes(1)

    setVisibility('hidden')
    first.dispatchEvent(new Event('release'))
    first.released = true
    document.dispatchEvent(new Event('visibilitychange'))
    await flush()

    expect(request).toHaveBeenCalledTimes(1)
    expect(first.release).not.toHaveBeenCalled()

    setVisibility('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    await flush()

    expect(request).toHaveBeenCalledTimes(2)
    expect(sentinels[1]?.released).toBe(false)
  })

  it('asks again on a tap after the browser released the lock', async () => {
    const { request, sentinels } = installWakeLock()

    holdScreenAwake()
    await flush()
    const first = sentinels[0]!
    first.released = true
    first.dispatchEvent(new Event('release'))

    window.dispatchEvent(new Event('pointerdown'))
    await flush()

    expect(request).toHaveBeenCalledTimes(2)
  })

  it('asks the display once when play requests the lock twice in one turn', async () => {
    let resolveRequest: (sentinel: WakeLockSentinel) => void = () => undefined
    const request = vi.fn(() => new Promise<WakeLockSentinel>((resolve) => {
      resolveRequest = resolve
    }))
    vi.stubGlobal('navigator', { ...navigator, wakeLock: { request } })

    screenWakeForPhase('buffering')
    screenWakeForPhase('idle')
    screenWakeForPhase('buffering')
    expect(request).toHaveBeenCalledTimes(1)

    const granted = new FakeSentinel()
    resolveRequest(granted as unknown as WakeLockSentinel)
    await flush()

    expect(granted.release).not.toHaveBeenCalled()
    expect(granted.released).toBe(false)
  })

  it('releases a lock that arrives after speech has already stopped', async () => {
    let resolveRequest: (sentinel: WakeLockSentinel) => void = () => undefined
    const request = vi.fn((_type: WakeLockType) => new Promise<WakeLockSentinel>((resolve) => {
      resolveRequest = resolve
    }))
    vi.stubGlobal('navigator', { ...navigator, wakeLock: { request } })

    holdScreenAwake()
    releaseScreenAwake()
    const late = new FakeSentinel()
    resolveRequest(late as unknown as WakeLockSentinel)
    await flush()

    expect(late.release).toHaveBeenCalledTimes(1)
  })
})
