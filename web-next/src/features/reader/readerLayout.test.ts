import { describe, expect, it } from 'vitest'
import {
  clampPageIndex,
  normalizeReaderLayout,
  pageBreaksFromLineBoxes,
  pageIndexForOffset,
  pageIndexForY,
} from './readerLayout'

describe('normalizeReaderLayout', () => {
  it('defaults unknown values to continuous', () => {
    expect(normalizeReaderLayout(undefined)).toBe('continuous')
    expect(normalizeReaderLayout('scroll')).toBe('continuous')
    expect(normalizeReaderLayout('flip')).toBe('continuous')
  })

  it('accepts paginated', () => {
    expect(normalizeReaderLayout('paginated')).toBe('paginated')
  })
})

describe('pageBreaksFromLineBoxes', () => {
  it('returns a single empty page when there are no lines', () => {
    expect(pageBreaksFromLineBoxes([], 400)).toEqual([{ top: 0, startOffset: 0 }])
  })

  it('keeps a short chapter on one page', () => {
    const pages = pageBreaksFromLineBoxes([
      { top: 0, bottom: 20, startOffset: 0 },
      { top: 24, bottom: 44, startOffset: 40 },
      { top: 48, bottom: 68, startOffset: 80 },
    ], 400)
    expect(pages).toEqual([{ top: 0, startOffset: 0 }])
  })

  it('starts the next page at the first line that no longer fits', () => {
    const pages = pageBreaksFromLineBoxes([
      { top: 0, bottom: 90, startOffset: 0 },
      { top: 100, bottom: 190, startOffset: 200 },
      { top: 200, bottom: 290, startOffset: 400 },
      { top: 300, bottom: 390, startOffset: 600 },
    ], 200)
    expect(pages).toEqual([
      { top: 0, startOffset: 0 },
      { top: 200, startOffset: 400 },
    ])
  })

  it('advances a line taller than the viewport on its own page', () => {
    const pages = pageBreaksFromLineBoxes([
      { top: 0, bottom: 500, startOffset: 0 },
      { top: 520, bottom: 540, startOffset: 80 },
    ], 200)
    expect(pages).toEqual([
      { top: 0, startOffset: 0 },
      { top: 520, startOffset: 80 },
    ])
  })
})

describe('page lookup', () => {
  const pages = [
    { top: 0, startOffset: 0 },
    { top: 400, startOffset: 900 },
    { top: 800, startOffset: 1800 },
  ]

  it('maps a spoken Y into the page that contains it', () => {
    expect(pageIndexForY(pages, -10)).toBe(0)
    expect(pageIndexForY(pages, 0)).toBe(0)
    expect(pageIndexForY(pages, 399)).toBe(0)
    expect(pageIndexForY(pages, 400)).toBe(1)
    expect(pageIndexForY(pages, 900)).toBe(2)
  })

  it('maps a source offset to the last page that has started', () => {
    expect(pageIndexForOffset(pages, 0)).toBe(0)
    expect(pageIndexForOffset(pages, 899)).toBe(0)
    expect(pageIndexForOffset(pages, 900)).toBe(1)
    expect(pageIndexForOffset(pages, 2500)).toBe(2)
  })

  it('clamps page turns to the book', () => {
    expect(clampPageIndex(-1, 12)).toBe(0)
    expect(clampPageIndex(3, 12)).toBe(3)
    expect(clampPageIndex(40, 12)).toBe(11)
    expect(clampPageIndex(2, 0)).toBe(0)
  })
})
