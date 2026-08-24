import { describe, expect, it } from 'vitest'
import {
  applyReaderScrollerStyle,
  clampPageIndex,
  clipRangeToPage,
  clipRectsToBounds,
  clientRectsToLocal,
  normalizeReaderLayout,
  pageBreaksFromLineBoxes,
  pageClipRange,
  pageIndexForOffset,
  pageIndexForY,
  readerScrollerStyle,
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

describe('readerScrollerStyle', () => {
  it('keeps continuous vertically scrollable', () => {
    expect(readerScrollerStyle('continuous')).toEqual({
      overflowX: 'hidden',
      overflowY: 'auto',
      touchAction: 'pan-y',
    })
  })

  it('locks paginated to page-turn gestures', () => {
    expect(readerScrollerStyle('paginated')).toEqual({
      overflowX: 'hidden',
      overflowY: 'hidden',
      touchAction: 'none',
    })
  })

  it('clears a leaked overflow shorthand so continuous can scroll after the sheet closes', () => {
    const el = {
      style: {
        overflow: 'hidden',
        overflowX: 'hidden',
        overflowY: 'hidden',
        touchAction: 'none',
      },
    }
    applyReaderScrollerStyle(el, 'continuous')
    expect(el.style.overflow).toBe('')
    expect(el.style.overflowY).toBe('auto')
    expect(el.style.overflowX).toBe('hidden')
    expect(el.style.touchAction).toBe('pan-y')
  })
})

describe('pageBreaksFromLineBoxes', () => {
  it('returns a single empty page when there are no lines', () => {
    expect(pageBreaksFromLineBoxes([], 400)).toEqual([{ top: 0, bottom: 400, startOffset: 0 }])
  })

  it('keeps a short chapter on one page', () => {
    const pages = pageBreaksFromLineBoxes(
      [
        { top: 0, bottom: 20, startOffset: 0 },
        { top: 24, bottom: 44, startOffset: 40 },
        { top: 48, bottom: 68, startOffset: 80 },
      ],
      400,
    )
    expect(pages).toEqual([{ top: 0, bottom: 68, startOffset: 0 }])
  })

  it('starts the next page at the first line that no longer fits', () => {
    const pages = pageBreaksFromLineBoxes(
      [
        { top: 0, bottom: 90, startOffset: 0 },
        { top: 100, bottom: 190, startOffset: 200 },
        { top: 200, bottom: 290, startOffset: 400 },
        { top: 300, bottom: 390, startOffset: 600 },
      ],
      200,
    )
    expect(pages).toEqual([
      { top: 0, bottom: 200, startOffset: 0 },
      { top: 200, bottom: 390, startOffset: 400 },
    ])
  })

  it('advances a line taller than the viewport on its own page', () => {
    const pages = pageBreaksFromLineBoxes(
      [
        { top: 0, bottom: 500, startOffset: 0 },
        { top: 520, bottom: 540, startOffset: 80 },
      ],
      200,
    )
    expect(pages).toEqual([
      { top: 0, bottom: 520, startOffset: 0 },
      { top: 520, bottom: 540, startOffset: 80 },
    ])
  })
})

describe('page lookup', () => {
  const pages = [
    { top: 0, bottom: 400, startOffset: 0 },
    { top: 400, bottom: 800, startOffset: 900 },
    { top: 800, bottom: 1200, startOffset: 1800 },
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

describe('clipRangeToPage', () => {
  const pages = [
    { startOffset: 0 },
    { startOffset: 900 },
    { startOffset: 1800 },
  ]

  it('keeps a phrase that already sits on the page', () => {
    expect(clipRangeToPage(100, 200, pages, 0, 2500)).toEqual({ start: 100, end: 200 })
  })

  it('cuts a spanning phrase to the visible page so the mark is not clipped away', () => {
    expect(clipRangeToPage(800, 1000, pages, 0, 2500)).toEqual({ start: 800, end: 900 })
    expect(clipRangeToPage(800, 1000, pages, 1, 2500)).toEqual({ start: 900, end: 1000 })
  })

  it('returns null when the phrase is entirely on another page', () => {
    expect(clipRangeToPage(100, 200, pages, 1, 2500)).toBeNull()
  })
})

describe('clipRectsToBounds', () => {
  const bounds = { left: 100, top: 80, width: 400, height: 500 }

  it('keeps rects that already sit in the page frame', () => {
    expect(clipRectsToBounds(
      [{ left: 120, top: 100, width: 200, height: 20 }],
      bounds,
    )).toEqual([{ left: 120, top: 100, width: 200, height: 20 }])
  })

  it('crops a line that hangs off the page and drops ones fully outside', () => {
    expect(clipRectsToBounds(
      [
        { left: 80, top: 90, width: 80, height: 18 },
        { left: 120, top: 600, width: 200, height: 18 },
      ],
      bounds,
    )).toEqual([{ left: 100, top: 90, width: 60, height: 18 }])
  })
})

describe('clientRectsToLocal', () => {
  it('rewrites viewport boxes into the page inner', () => {
    expect(clientRectsToLocal(
      [{ left: 140, top: 220, width: 80, height: 18 }],
      { left: 100, top: 80 },
    )).toEqual([{ left: 40, top: 140, width: 80, height: 18 }])
  })
})

describe('pageClipRange', () => {
  const pages = [
    { top: 0, bottom: 400 },
    { top: 400, bottom: 720 },
    { top: 720, bottom: 880 },
  ]

  it('clips each page to the start of the next so later text stays hidden', () => {
    expect(pageClipRange(pages, 0, 500)).toEqual({ top: 0, bottom: 400 })
    expect(pageClipRange(pages, 1, 500)).toEqual({ top: 400, bottom: 720 })
  })

  it('uses the stored bottom for the last page', () => {
    expect(pageClipRange(pages, 2, 500)).toEqual({ top: 720, bottom: 880 })
  })
})
