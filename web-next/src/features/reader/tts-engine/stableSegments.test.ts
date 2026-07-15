import { describe, expect, it } from 'vitest'
import {
  buildStableSegments,
  findSegmentIndexAt,
  segmentId,
} from './stableSegments'

describe('buildStableSegments', () => {
  it('splits on sentence boundaries into stable ranges', () => {
    const text = [
      'Hello world, this is a longer first sentence for the segmenter.',
      'This is a second sentence that should land in another segment.',
      'And a third one keeps the map multi-part for continuous playback.',
      'A fourth sentence ensures we exceed the single-segment target length.',
    ].join(' ')
    const segments = buildStableSegments(text)
    expect(segments.length).toBeGreaterThanOrEqual(2)
    expect(segments[0]!.start).toBe(0)
    expect(segments[0]!.text).toContain('Hello world')
    // Stable ids are pure functions of offsets
    expect(segments[0]!.id).toBe(segmentId(segments[0]!.start, segments[0]!.end))
    // Cover full text without gaps in coverage order
    expect(segments[0]!.start).toBeLessThan(segments[0]!.end)
    for (let i = 1; i < segments.length; i += 1) {
      expect(segments[i]!.start).toBeGreaterThanOrEqual(segments[i - 1]!.end)
    }
  })

  it('is deterministic for the same text', () => {
    const text = 'Alpha beta gamma. Delta epsilon zeta. Eta theta iota.'
    const a = buildStableSegments(text)
    const b = buildStableSegments(text)
    expect(a.map((s) => s.id)).toEqual(b.map((s) => s.id))
  })

  it('finds the segment containing a tap offset', () => {
    const text = 'First sentence here. Second sentence lives later. Third ends.'
    const segments = buildStableSegments(text)
    const mid = text.indexOf('Second')
    const idx = findSegmentIndexAt(segments, mid)
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(segments[idx]!.text).toContain('Second')
  })
})
