import { describe, expect, it } from 'vitest'
import { FirstAudioGate } from './sessionTelemetry'

describe('tts v2 session telemetry', () => {
  it('reports first audio once for the active session', () => {
    const gate = new FirstAudioGate()

    expect(gate.shouldReport(1, 1)).toBe(true)
    expect(gate.shouldReport(1, 1)).toBe(false)
    expect(gate.shouldReport(2, 1)).toBe(false)
    expect(gate.shouldReport(2, 2)).toBe(true)
  })

  it('can reset when playback stops before a new session starts', () => {
    const gate = new FirstAudioGate()

    expect(gate.shouldReport(1, 1)).toBe(true)
    gate.reset()

    expect(gate.shouldReport(1, 1)).toBe(true)
  })
})
