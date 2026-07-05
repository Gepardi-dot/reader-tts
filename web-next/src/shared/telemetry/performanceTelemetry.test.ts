import { afterEach, describe, expect, it } from 'vitest'
import {
  elapsedMs,
  flushPerformanceTelemetry,
  normalizePerformanceTelemetryEvent,
  pendingPerformanceTelemetryCount,
  queuePerformanceTelemetry,
  resetPerformanceTelemetryForTests,
  setPerformanceTelemetrySenderForTests,
} from './performanceTelemetry'

afterEach(() => {
  resetPerformanceTelemetryForTests()
})

describe('performance telemetry normalization', () => {
  it('keeps compact valid telemetry fields', () => {
    expect(normalizePerformanceTelemetryEvent({
      eventName: 'tts.first_audio',
      bookId: 'book-1',
      provider: 'google',
      durationMs: 14.6,
      cacheHit: true,
      cacheStorage: 'r2',
      metadata: {
        chunkIndex: 2,
        mode: 'native',
        invalid: Number.NaN,
      },
    })).toEqual({
      eventName: 'tts.first_audio',
      bookId: 'book-1',
      provider: 'google',
      durationMs: 15,
      cacheHit: true,
      cacheStorage: 'r2',
      metadata: {
        chunkIndex: 2,
        mode: 'native',
        invalid: null,
      },
    })
  })

  it('keeps TTS v2 diagnostic metadata used by the summary endpoint', () => {
    expect(normalizePerformanceTelemetryEvent({
      eventName: 'tts.first_audio_v2',
      provider: 'google',
      durationMs: 62,
      metadata: {
        lane: 'fallback',
        reason: 'tap',
        chunkIndex: 0,
        chunkChars: 160,
      },
    })).toEqual({
      eventName: 'tts.first_audio_v2',
      provider: 'google',
      durationMs: 62,
      metadata: {
        lane: 'fallback',
        reason: 'tap',
        chunkIndex: 0,
        chunkChars: 160,
      },
    })

    expect(normalizePerformanceTelemetryEvent({
      eventName: 'tts.native_handoff_v2',
      provider: 'google',
      durationMs: 42,
      cacheHit: false,
      cacheStorage: 'generated',
      metadata: {
        reason: 'tap',
        chunkIndex: 1,
        chunkChars: 420,
        readyChunks: 2,
        bufferedSeconds: 8.4,
        chunkStatus: 'fetching',
        browserFallback: true,
        kokoroModelReady: false,
      },
    })).toEqual({
      eventName: 'tts.native_handoff_v2',
      provider: 'google',
      durationMs: 42,
      cacheHit: false,
      cacheStorage: 'generated',
      metadata: {
        reason: 'tap',
        chunkIndex: 1,
        chunkChars: 420,
        readyChunks: 2,
        bufferedSeconds: 8.4,
        chunkStatus: 'fetching',
        browserFallback: true,
        kokoroModelReady: false,
      },
    })
  })

  it('rejects invalid event names', () => {
    expect(normalizePerformanceTelemetryEvent({ eventName: '../bad' })).toBeNull()
  })

  it('computes non-negative elapsed milliseconds', () => {
    expect(elapsedMs(10.2, 18.8)).toBe(9)
    expect(elapsedMs(20, 10)).toBe(0)
  })
})

describe('performance telemetry queue', () => {
  it('flushes queued events in small batches', async () => {
    const sent: unknown[] = []
    setPerformanceTelemetrySenderForTests(async (events) => {
      sent.push(events)
    })

    queuePerformanceTelemetry({ eventName: 'tts.play_start', provider: 'browser' })
    queuePerformanceTelemetry({ eventName: 'tts.first_audio', provider: 'browser', durationMs: 12 })

    expect(pendingPerformanceTelemetryCount()).toBe(2)
    await flushPerformanceTelemetry()

    expect(pendingPerformanceTelemetryCount()).toBe(0)
    expect(sent).toEqual([[
      { eventName: 'tts.play_start', provider: 'browser' },
      { eventName: 'tts.first_audio', provider: 'browser', durationMs: 12 },
    ]])
  })

  it('drops failed sends without rethrowing', async () => {
    setPerformanceTelemetrySenderForTests(async () => {
      throw new Error('offline')
    })

    queuePerformanceTelemetry({ eventName: 'tts.first_audio', durationMs: 30 })
    await expect(flushPerformanceTelemetry()).resolves.toBeUndefined()
    expect(pendingPerformanceTelemetryCount()).toBe(0)
  })
})
