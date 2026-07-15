import { describe, expect, it, vi } from 'vitest'
import { BufferPool, type ChunkLoader } from './bufferPool'
import type { TtsAudioChunk } from './types'

function makeChunk(index: number, text = `chunk ${index}`): TtsAudioChunk {
  return {
    id: `c-${index}`,
    index,
    start: index * 10,
    end: index * 10 + text.length,
    text,
    status: 'idle',
    url: null,
    buffer: null,
    cues: [],
    durationSec: null,
  }
}

function fakeBuffer(duration: number): AudioBuffer {
  return { duration, length: 100 } as AudioBuffer
}

describe('BufferPool', () => {
  it('streams frames before the loader promise settles', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const loader: ChunkLoader = async (_chunk, _signal, { onFrame }) => {
      onFrame({
        url: null,
        buffer: fakeBuffer(0.2),
        cues: [],
        durationSec: 0.2,
        cacheHit: false,
        cacheStorage: 'generated',
      })
      onFrame({
        url: null,
        buffer: fakeBuffer(0.3),
        cues: [],
        durationSec: 0.3,
        cacheHit: false,
        cacheStorage: 'generated',
      })
      await gate
    }

    const pool = new BufferPool([makeChunk(0)], loader)
    const frames: number[] = []
    pool.onFrame((_index, frame) => {
      frames.push(frame.buffer.duration)
    })

    const pending = pool.ensure(0, new AbortController().signal, false)
    expect(frames).toEqual([0.2, 0.3])
    expect(pool.allChunks[0]?.status).toBe('fetching')
    expect(pool.allChunks[0]?.durationSec).toBeCloseTo(0.5)

    release()
    await pending
    expect(pool.allChunks[0]?.status).toBe('ready')
  })

  it('dedupes concurrent ensure calls for the same index', async () => {
    const loader = vi.fn<ChunkLoader>(async (_chunk, _signal, { onFrame }) => {
      onFrame({
        url: null,
        buffer: fakeBuffer(1),
        cues: [],
        durationSec: 1,
      })
    })

    const pool = new BufferPool([makeChunk(0)], loader)
    const signal = new AbortController().signal
    await Promise.all([
      pool.ensure(0, signal, false),
      pool.ensure(0, signal, false),
    ])

    expect(loader).toHaveBeenCalledTimes(1)
    expect(pool.allChunks[0]?.status).toBe('ready')
  })

  it('prefetches subsequent chunks sequentially', async () => {
    const order: number[] = []
    const loader: ChunkLoader = async (chunk, _signal, { onFrame }) => {
      order.push(chunk.index)
      onFrame({
        url: null,
        buffer: fakeBuffer(0.5),
        cues: [],
        durationSec: 0.5,
      })
    }

    const pool = new BufferPool(
      [makeChunk(0), makeChunk(1), makeChunk(2)],
      loader,
    )
    await pool.prefetchFrom(1, 2, new AbortController().signal)
    expect(order).toEqual([1, 2])
    expect(pool.allChunks[1]?.status).toBe('ready')
    expect(pool.allChunks[2]?.status).toBe('ready')
  })
})
