import { describe, expect, it } from 'vitest'
import { TtsNativeQueue } from './nativeQueue'
import type { NativeAudioResult, TtsAudioChunk } from './types'

function buffer(duration: number) {
  return { duration } as AudioBuffer
}

function chunk(index: number): TtsAudioChunk {
  return {
    id: `chunk-${index}`,
    index,
    start: index * 10,
    end: index * 10 + 10,
    text: `chunk ${index}`,
    status: 'idle',
    url: null,
    buffer: null,
    cues: [],
    durationSec: null,
  }
}

function result(duration = 4): NativeAudioResult {
  return {
    url: null,
    buffer: buffer(duration),
    cues: [],
    durationSec: duration,
  }
}

describe('tts v2 native queue', () => {
  it('dedupes concurrent fetches for the same chunk', async () => {
    let calls = 0
    const queue = new TtsNativeQueue([chunk(0)], async () => {
      calls += 1
      return result()
    })
    const ctrl = new AbortController()

    await Promise.all([
      queue.ensure(0, ctrl.signal),
      queue.ensure(0, ctrl.signal),
      queue.ensure(0, ctrl.signal),
    ])

    expect(calls).toBe(1)
    expect(queue.allChunks[0]).toMatchObject({
      status: 'ready',
      durationSec: 4,
    })
  })

  it('prefetches a bounded read-ahead window', async () => {
    const fetched: number[] = []
    const queue = new TtsNativeQueue([chunk(0), chunk(1), chunk(2), chunk(3)], async (item) => {
      fetched.push(item.index)
      return result()
    })
    const ctrl = new AbortController()

    queue.prefetchFrom(1, 2, ctrl.signal)
    await Promise.all([
      queue.ensure(1, ctrl.signal, true),
      queue.ensure(2, ctrl.signal, true),
      queue.ensure(3, ctrl.signal, true),
    ])

    expect(fetched).toEqual([1, 2, 3])
    expect(queue.allChunks[0].status).toBe('idle')
  })

  it('blocks native handoff until enough contiguous audio is ready', async () => {
    const queue = new TtsNativeQueue([chunk(0), chunk(1), chunk(2)], async () => result(3))
    const ctrl = new AbortController()

    expect(queue.shouldStartNativeFrom(0)).toBe(false)
    await queue.ensure(0, ctrl.signal)
    expect(queue.shouldStartNativeFrom(0)).toBe(false)
    await queue.ensure(1, ctrl.signal)
    expect(queue.shouldStartNativeFrom(0)).toBe(true)
  })

  it('allows handoff with one long buffered chunk', async () => {
    const queue = new TtsNativeQueue([chunk(0), chunk(1)], async () => result(9))
    const ctrl = new AbortController()

    await queue.ensure(0, ctrl.signal)

    expect(queue.readyRunFrom(0)).toEqual({ count: 1, seconds: 9 })
    expect(queue.shouldStartNativeFrom(0)).toBe(true)
  })

  it('returns failed background fetches to idle instead of poisoning the queue', async () => {
    const queue = new TtsNativeQueue([chunk(0)], async () => null)
    const ctrl = new AbortController()

    await queue.ensure(0, ctrl.signal, true)

    expect(queue.allChunks[0].status).toBe('idle')
  })
})

