import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AUDIO_CONTEXT_START_LEAD_SEC } from '../audioPlayback'
import { AudioClock, pcmToAudioBuffer } from './audioClock'

class FakeAudioBufferSource {
  buffer: AudioBuffer | null = null
  playbackRate = { value: 1 }
  onended: (() => void) | null = null
  readonly starts: Array<{ when: number; offset?: number }> = []
  readonly connect = vi.fn()
  readonly disconnect = vi.fn()
  readonly start = vi.fn((when?: number, offset?: number) => {
    this.starts.push({ when: when ?? 0, offset })
  })
  readonly stop = vi.fn()
}

class FakeAudioContext {
  state: AudioContextState = 'running'
  currentTime = 10
  destination = {}
  readonly sources: FakeAudioBufferSource[] = []
  readonly resume = vi.fn(async () => {
    this.state = 'running'
  })
  readonly suspend = vi.fn(async () => {
    this.state = 'suspended'
  })
  readonly close = vi.fn(async () => {
    this.state = 'closed'
  })
  createBuffer = vi.fn((channels: number, length: number, sampleRate: number) => {
    const data = new Float32Array(length)
    return {
      duration: length / sampleRate,
      length,
      sampleRate,
      numberOfChannels: channels,
      copyToChannel: (src: Float32Array) => {
        data.set(src.subarray(0, length))
      },
      getChannelData: () => data,
    } as unknown as AudioBuffer
  })

  createBufferSource() {
    const source = new FakeAudioBufferSource()
    this.sources.push(source)
    return source as unknown as AudioBufferSourceNode
  }
}

let contexts: FakeAudioContext[]

beforeEach(() => {
  contexts = []
  vi.stubGlobal('AudioContext', class extends FakeAudioContext {
    constructor() {
      super()
      contexts.push(this)
    }
  })
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function audioBuffer(duration: number) {
  return { duration, length: Math.round(duration * 24_000) } as AudioBuffer
}

describe('AudioClock', () => {
  it('appends units onto a continuous timeline without restart', () => {
    const clock = new AudioClock()
    const first = clock.append(audioBuffer(1), { chunkIndex: 0 })
    const second = clock.append(audioBuffer(2), { chunkIndex: 1 })

    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(contexts[0]?.sources).toHaveLength(2)

    const start0 = contexts[0]!.sources[0].starts[0].when
    const start1 = contexts[0]!.sources[1].starts[0].when
    expect(start0).toBeGreaterThanOrEqual(10 + AUDIO_CONTEXT_START_LEAD_SEC - 0.0001)
    expect(start1).toBeGreaterThanOrEqual((first?.endAt ?? 0) - 0.0001)
    expect(second?.startAt).toBe(first?.endAt)
  })

  it('reports underrun when the timeline drains while more audio is expected', () => {
    const clock = new AudioClock()
    const underrun = vi.fn()
    clock.setHandlers({ onUnderrun: underrun })
    clock.setExpectMore(true)

    const unit = clock.append(audioBuffer(0.5), { chunkIndex: 2 })
    expect(unit).not.toBeNull()
    contexts[0]!.sources[0].onended?.()

    expect(underrun).toHaveBeenCalledWith(3)
  })

  it('reports ended when the timeline drains and no more audio is expected', () => {
    const clock = new AudioClock()
    const ended = vi.fn()
    clock.setHandlers({ onEnded: ended })
    clock.setExpectMore(false)

    clock.append(audioBuffer(0.5), { chunkIndex: 0 })
    contexts[0]!.sources[0].onended?.()

    expect(ended).toHaveBeenCalledTimes(1)
  })

  it('ends when expectMore flips false after an empty underrun', () => {
    const clock = new AudioClock()
    const ended = vi.fn()
    clock.setHandlers({ onEnded: ended })
    clock.setExpectMore(true)

    clock.append(audioBuffer(0.5), { chunkIndex: 0 })
    contexts[0]!.sources[0].onended?.()
    expect(ended).not.toHaveBeenCalled()

    clock.setExpectMore(false)
    expect(ended).toHaveBeenCalledTimes(1)
  })
})

describe('pcmToAudioBuffer', () => {
  it('copies mono PCM into an AudioBuffer', () => {
    const ctx = new AudioContext() as unknown as AudioContext
    const pcm = new Float32Array([0.1, -0.2, 0.3])
    const buffer = pcmToAudioBuffer(ctx, pcm, 24_000)
    expect(buffer.duration).toBeCloseTo(3 / 24_000, 6)
    expect(buffer.length).toBe(3)
  })
})
