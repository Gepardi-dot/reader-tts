import { describe, expect, it } from 'vitest'
import {
  applyReaderScrollerStyle,
  assignLineStartOffsets,
  clampPageIndex,
  clampReadOffset,
  clipRangeToPage,
  clipRectsToBounds,
  clientRectsToLocal,
  normalizeReaderLayout,
  pageBreaksFromLineBoxes,
  pageClipRange,
  pageIndexForOffset,
  pageIndexForY,
  pagedLayoutCacheKeyEqual,
  pagedParagraphWindow,
  pageTopFromInnerScroll,
  paginatedTextViewHeight,
  readerScrollerStyle,
  snapPageToLines,
  resolveLayoutSwitchOffset,
  scrollDeltaToPinRect,
  scrollPctFromOffset,
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

describe('paginated page height', () => {
  it('reserves the progress pill, not continuous end-padding', () => {
    expect(paginatedTextViewHeight(800, 72, 96)).toBe(632)
    expect(paginatedTextViewHeight(800, 72, 144)).toBe(584)
  })

  it('clips a page to the last line that fully fits', () => {
    const lines = [
      { top: 0, bottom: 20 },
      { top: 24, bottom: 44 },
      { top: 48, bottom: 90 },
    ]
    expect(snapPageToLines(lines, 0, 80)).toEqual({ top: 0, bottom: 48 })
  })

  it('does not use viewport height as the clip when that would cut a line', () => {
    expect(snapPageToLines(
      [{ top: 100, bottom: 118 }, { top: 122, bottom: 140 }, { top: 144, bottom: 200 }],
      110,
      50,
    )).toEqual({ top: 100, bottom: 144 })
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

  it('starts a wrapped-paragraph page at the first character on that page', () => {
    const pages = pageBreaksFromLineBoxes(
      [
        { top: 0, bottom: 20, startOffset: 0 },
        { top: 24, bottom: 44, startOffset: 40 },
        { top: 200, bottom: 220, startOffset: 80 },
        { top: 224, bottom: 244, startOffset: 120 },
        { top: 400, bottom: 420, startOffset: 160 },
      ],
      180,
    )
    expect(pages.map((page) => page.startOffset)).toEqual([0, 80, 160])
    expect(pageIndexForOffset(pages, 79)).toBe(0)
    expect(pageIndexForOffset(pages, 80)).toBe(1)
    expect(pageIndexForOffset(pages, 159)).toBe(1)
    expect(pageIndexForOffset(pages, 160)).toBe(2)
  })
})

describe('assignLineStartOffsets', () => {
  it('keeps a single line at the paragraph start', () => {
    expect(assignLineStartOffsets([{ top: 0 }], 100, 50, () => 0)).toEqual([100])
  })

  it('gives later wrapped lines their own source offsets', () => {
    const charTop = (offset: number) => Math.floor(offset / 10) * 20
    expect(
      assignLineStartOffsets([{ top: 0 }, { top: 20 }, { top: 40 }], 500, 30, charTop),
    ).toEqual([500, 510, 520])
  })

  it('does not map every wrapped line to the paragraph start', () => {
    const charTop = (offset: number) => Math.floor(offset / 8) * 22
    const offsets = assignLineStartOffsets([{ top: 0 }, { top: 22 }, { top: 44 }], 0, 24, charTop)
    expect(offsets[0]).toBe(0)
    expect(offsets[1]).toBe(8)
    expect(offsets[2]).toBe(16)
    const pages = pageBreaksFromLineBoxes(
      [
        { top: 0, bottom: 20, startOffset: offsets[0]! },
        { top: 22, bottom: 42, startOffset: offsets[1]! },
        { top: 200, bottom: 220, startOffset: offsets[2]! },
      ],
      180,
    )
    expect(pageIndexForOffset(pages, 0)).toBe(0)
    expect(pageIndexForOffset(pages, 8)).toBe(0)
    expect(pageIndexForOffset(pages, 16)).toBe(1)
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

  it('stays on the spoken page of a wrapping paragraph when line offsets increase', () => {
    const wrapping = [{ startOffset: 0 }, { startOffset: 400 }, { startOffset: 800 }]
    expect(pageIndexForOffset(wrapping, 399)).toBe(0)
    expect(pageIndexForOffset(wrapping, 400)).toBe(1)
    expect(pageIndexForOffset(wrapping, 799)).toBe(1)
    expect(pageIndexForOffset(wrapping, 800)).toBe(2)
  })

  it('skips ahead when wrapped pages reuse the paragraph start', () => {
    expect(
      pageIndexForOffset([{ startOffset: 0 }, { startOffset: 0 }, { startOffset: 0 }], 10),
    ).toBe(2)
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

describe('layout switch offset', () => {
  it('clamps a source offset into the book', () => {
    expect(clampReadOffset(-4, 900)).toBe(0)
    expect(clampReadOffset(440.9, 900)).toBe(440)
    expect(clampReadOffset(1200, 900)).toBe(899)
    expect(clampReadOffset(12, 0)).toBe(0)
  })

  it('does not treat scroll percent as interchangeable with character offset', () => {
    expect(scrollPctFromOffset(900, 1800)).toBe(0.5)
    expect(scrollPctFromOffset(0, 1800)).toBe(0)
    expect(scrollPctFromOffset(1800, 1800)).toBe(1)
  })

  it('keeps the spoken character when playback is still following', () => {
    expect(resolveLayoutSwitchOffset({
      spokenStart: 1240,
      viewportOffset: 80,
      textLength: 5000,
      followPlayback: true,
    })).toBe(1240)
  })

  it('keeps the on-screen character when follow is paused or audio is idle', () => {
    expect(resolveLayoutSwitchOffset({
      spokenStart: 1240,
      viewportOffset: 80,
      textLength: 5000,
      followPlayback: false,
    })).toBe(80)
    expect(resolveLayoutSwitchOffset({
      spokenStart: null,
      viewportOffset: 80,
      textLength: 5000,
      followPlayback: true,
    })).toBe(80)
  })

  it('pins a line to the reading band instead of using document percent', () => {
    expect(scrollDeltaToPinRect(420, 88)).toBe(332)
    expect(scrollDeltaToPinRect(90, 88)).toBe(0)
  })

  it('reuses last paginated breaks when type and viewport have not changed', () => {
    const key = {
      viewH: 640,
      fontSize: 17,
      lineHeight: 1.8,
      width: 'balanced',
      font: 'serif',
      bionic: false,
      align: 'left',
      textLength: 12_000,
    }
    expect(pagedLayoutCacheKeyEqual(key, { ...key, viewH: 641 })).toBe(true)
    expect(pagedLayoutCacheKeyEqual(key, { ...key, fontSize: 18 })).toBe(false)
    expect(pagedLayoutCacheKeyEqual(key, null)).toBe(false)
  })

  it('lays out only the current page and its neighbors', () => {
    const pages = [{ startOffset: 0 }, { startOffset: 400 }, { startOffset: 800 }, { startOffset: 1200 }]
    expect(pagedParagraphWindow({ pages, offset: 850, textLength: 2000 })).toEqual({
      start: 400,
      end: 2000,
    })
    expect(pagedParagraphWindow({ pages, offset: 400, textLength: 2000 })).toEqual({
      start: 0,
      end: 1200,
    })
  })

  it('falls back to a short window around the offset when pages are not ready', () => {
    expect(pagedParagraphWindow({ pages: [], offset: 2000, textLength: 9000 })).toEqual({
      start: 1800,
      end: 6500,
    })
  })

  it('converts continuous scroll into a paginated page top without a jump', () => {
    expect(pageTopFromInnerScroll(72, 72)).toBe(0)
    expect(pageTopFromInnerScroll(2072, 72)).toBe(2000)
    expect(pageTopFromInnerScroll(10, 72)).toBe(0)
  })
})
