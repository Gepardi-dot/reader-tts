import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AUDIO_CONTEXT_START_LEAD_SEC } from '../audioPlayback'
import { ClockedAudioSink } from './clockedAudioSink'
import type { TtsAudioChunk } from './types'

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
  return { duration } as AudioBuffer
}

function chunk(index: number, duration: number | null): TtsAudioChunk {
  return {
    id: `chunk-${index}`,
    index,
    start: index * 100,
    end: index * 100 + 100,
    text: `chunk ${index}`,
    status: duration == null ? 'idle' : 'ready',
    url: null,
    buffer: duration == null ? null : audioBuffer(duration),
    cues: [],
    durationSec: duration,
  }
}

describe('ClockedAudioSink', () => {
  it('appends newly-ready chunks to the active WebAudio run', () => {
    const sink = new ClockedAudioSink()
    const ctrl = new AbortController()
    const chunks = [chunk(0, 2), chunk(1, null)]

    const initialCount = sink.playReadyRun({
      chunks,
      startIndex: 0,
      rate: 1,
      signal: ctrl.signal,
      onChunkStart: vi.fn(),
      onProgress: vi.fn(),
      onRunDrained: vi.fn(),
    })
    chunks[1] = chunk(1, 3)
    const appendedCount = sink.extendReadyRun(chunks)

    const [firstSource, secondSource] = contexts[0].sources
    expect(initialCount).toBe(1)
    expect(appendedCount).toBe(1)
    expect(contexts[0].sources).toHaveLength(2)
    expect(firstSource.starts[0].when).toBeCloseTo(10 + AUDIO_CONTEXT_START_LEAD_SEC)
    expect(secondSource.starts[0].when).toBeCloseTo(10 + AUDIO_CONTEXT_START_LEAD_SEC + 2)
  })

  it('drains only when the latest appended source ends', () => {
    const sink = new ClockedAudioSink()
    const ctrl = new AbortController()
    const chunks = [chunk(0, 2), chunk(1, null)]
    const onRunDrained = vi.fn()

    sink.playReadyRun({
      chunks,
      startIndex: 0,
      rate: 1,
      signal: ctrl.signal,
      onChunkStart: vi.fn(),
      onProgress: vi.fn(),
      onRunDrained,
    })
    chunks[1] = chunk(1, 3)
    sink.extendReadyRun(chunks)

    const [firstSource, secondSource] = contexts[0].sources
    firstSource.onended?.()
    expect(onRunDrained).not.toHaveBeenCalled()

    secondSource.onended?.()
    expect(onRunDrained).toHaveBeenCalledWith(2)
  })

  it('uses updated playback rate for appended chunks', () => {
    const sink = new ClockedAudioSink()
    const ctrl = new AbortController()
    const chunks = [chunk(0, 2), chunk(1, null)]

    sink.playReadyRun({
      chunks,
      startIndex: 0,
      rate: 1,
      signal: ctrl.signal,
      onChunkStart: vi.fn(),
      onProgress: vi.fn(),
      onRunDrained: vi.fn(),
    })
    sink.setRate(1.5)
    chunks[1] = chunk(1, 3)
    sink.extendReadyRun(chunks)

    const [firstSource, secondSource] = contexts[0].sources
    expect(firstSource.playbackRate.value).toBe(1.5)
    expect(secondSource.playbackRate.value).toBe(1.5)
  })
})
