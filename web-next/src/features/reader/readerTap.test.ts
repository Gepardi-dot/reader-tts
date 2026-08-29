import { describe, expect, it } from 'vitest'
import {
  READER_TAP_SLOP_PX,
  isReaderScrollGesture,
  isReaderTap,
  readerGestureDistance,
} from './readerTap'

describe('reader tap vs scroll', () => {
  it('treats tiny movement as a tap', () => {
    expect(isReaderTap(0, 0)).toBe(true)
    expect(isReaderTap(3, -4)).toBe(true)
    expect(isReaderTap(READER_TAP_SLOP_PX, 0)).toBe(true)
    expect(isReaderTap(READER_TAP_SLOP_PX + 1, 0)).toBe(false)
  })

  it('classifies vertical flicks as scroll even when they are slightly diagonal', () => {
    expect(isReaderScrollGesture(0, 20)).toBe(true)
    expect(isReaderScrollGesture(10, 24)).toBe(true)
    expect(isReaderScrollGesture(-12, -18)).toBe(true)
    expect(isReaderScrollGesture(4, 8)).toBe(false)
  })

  it('keeps horizontal sweeps as highlight, not scroll', () => {
    expect(isReaderScrollGesture(28, 8)).toBe(false)
    expect(isReaderScrollGesture(-30, 10)).toBe(false)
    expect(readerGestureDistance(30, 40)).toBe(50)
  })
})
