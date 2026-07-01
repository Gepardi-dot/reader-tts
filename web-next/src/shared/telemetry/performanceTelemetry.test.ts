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
