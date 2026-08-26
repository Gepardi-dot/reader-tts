import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PAGE_TURN_COMMIT_PX,
  PAGE_TURN_COMMIT_RATIO,
  PAGE_TURN_MIN_FLICK_PX,
  PAGE_TURN_VELOCITY_PX_MS,
  classifyPaginatedSwipe,
  isFinePointerClick,
  lockPageTurnAxis,
  pageRestY,
  pageTurnDurationMs,
  pageTurnGutterDir,
  prefersReducedMotion,
  resistPageTurnOffset,
  rubberBandOffset,
  shouldCommitPageTurn,
  shouldTrackPageTurnPointer,
} from './pageTurn'

describe('rubberBandOffset', () => {
  it('returns 0 for empty input', () => {
    expect(rubberBandOffset(0, 400)).toBe(0)
    expect(rubberBandOffset(80, 0)).toBe(0)
  })

  it('is weaker than the raw pull and keeps sign', () => {
    expect(rubberBandOffset(120, 400)).toBeGreaterThan(0)
    expect(rubberBandOffset(120, 400)).toBeLessThan(120)
    expect(rubberBandOffset(-120, 400)).toBeLessThan(0)
    expect(rubberBandOffset(-120, 400)).toBeGreaterThan(-120)
  })
})

describe('resistPageTurnOffset', () => {
  it('leaves mid-book drags untouched', () => {
    expect(resistPageTurnOffset(-40, 360, true, true)).toBe(-40)
    expect(resistPageTurnOffset(40, 360, true, true)).toBe(40)
  })

  it('rubber-bands only past the first or last page', () => {
    expect(resistPageTurnOffset(80, 360, false, true)).toBeLessThan(80)
    expect(resistPageTurnOffset(-80, 360, true, false)).toBeGreaterThan(-80)
    expect(resistPageTurnOffset(-80, 360, false, true)).toBe(-80)
  })
})

describe('lockPageTurnAxis', () => {
  it('waits until the finger has moved enough', () => {
    expect(lockPageTurnAxis(4, 3)).toBeNull()
  })

  it('locks to the dominant axis', () => {
    expect(lockPageTurnAxis(-20, 4)).toBe('x')
    expect(lockPageTurnAxis(3, -24)).toBe('y')
  })
})

describe('shouldCommitPageTurn', () => {
  const base = { size: 400, canPrev: true, canNext: true, velocity: 0 }

  it('commits a short swipe past the fine threshold', () => {
    const threshold = Math.max(PAGE_TURN_COMMIT_PX, base.size * PAGE_TURN_COMMIT_RATIO)
    expect(shouldCommitPageTurn({ ...base, offset: -threshold })).toBe(1)
    expect(shouldCommitPageTurn({ ...base, offset: threshold })).toBe(-1)
  })

  it('ignores tiny movement without a flick', () => {
    expect(shouldCommitPageTurn({ ...base, offset: -10, velocity: 0 })).toBe(0)
  })

  it('commits a light flick even below the distance threshold', () => {
    expect(shouldCommitPageTurn({
      ...base,
      offset: -PAGE_TURN_MIN_FLICK_PX,
      velocity: -PAGE_TURN_VELOCITY_PX_MS,
    })).toBe(1)
    expect(shouldCommitPageTurn({
      ...base,
      offset: PAGE_TURN_MIN_FLICK_PX,
      velocity: PAGE_TURN_VELOCITY_PX_MS,
    })).toBe(-1)
  })

  it('does not turn past the ends', () => {
    expect(shouldCommitPageTurn({
      ...base,
      offset: -80,
      canNext: false,
    })).toBe(0)
    expect(shouldCommitPageTurn({
      ...base,
      offset: 80,
      canPrev: false,
    })).toBe(0)
  })
})

describe('pageTurnDurationMs', () => {
  it('stays in a short iOS-like window', () => {
    const slow = pageTurnDurationMs(400, 0)
    const flick = pageTurnDurationMs(400, 1.2)
    expect(slow).toBeGreaterThanOrEqual(300)
    expect(slow).toBeLessThanOrEqual(520)
    expect(flick).toBeLessThan(slow)
    expect(flick).toBeGreaterThanOrEqual(260)
  })
})

describe('pageTurnGutterDir', () => {
  it('turns only from the empty sides beside the written column', () => {
    expect(pageTurnGutterDir(40, 200, 800)).toBe(-1)
    expect(pageTurnGutterDir(199, 200, 800)).toBe(-1)
    expect(pageTurnGutterDir(200, 200, 800)).toBe(0)
    expect(pageTurnGutterDir(500, 200, 800)).toBe(0)
    expect(pageTurnGutterDir(800, 200, 800)).toBe(0)
    expect(pageTurnGutterDir(801, 200, 800)).toBe(1)
    expect(pageTurnGutterDir(980, 200, 800)).toBe(1)
  })

  it('does not turn when the column fills the viewport', () => {
    expect(pageTurnGutterDir(10, 0, 1000)).toBe(0)
    expect(pageTurnGutterDir(990, 0, 1000)).toBe(0)
  })

  it('ignores an empty column rect', () => {
    expect(pageTurnGutterDir(100, 0, 0)).toBe(0)
    expect(pageTurnGutterDir(100, 400, 400)).toBe(0)
  })
})

describe('isFinePointerClick', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('treats mouse and pen as desktop clicks', () => {
    expect(isFinePointerClick({ pointerType: 'mouse' })).toBe(true)
    expect(isFinePointerClick({ pointerType: 'pen' })).toBe(true)
    expect(isFinePointerClick({ pointerType: 'touch' })).toBe(false)
  })

  it('falls back to hover + fine pointer media when type is missing', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('hover: hover') && query.includes('pointer: fine'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }))
    expect(isFinePointerClick({})).toBe(true)
  })
})

describe('shouldTrackPageTurnPointer', () => {
  it('tracks touch swipes and ignores mouse clicks', () => {
    expect(shouldTrackPageTurnPointer({ pointerType: 'touch' })).toBe(true)
    expect(shouldTrackPageTurnPointer({ pointerType: 'mouse' })).toBe(false)
    expect(shouldTrackPageTurnPointer({ pointerType: 'pen' })).toBe(false)
  })
})

describe('pageRestY', () => {
  it('shifts the page so its first line sits at the top', () => {
    expect(pageRestY(0)).toBe(0)
    expect(pageRestY(500)).toBe(-500)
  })
})

describe('prefersReducedMotion', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads the system media query', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('prefers-reduced-motion: reduce'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }))
    expect(prefersReducedMotion()).toBe(true)
  })
})

describe('classifyPaginatedSwipe', () => {
  it('waits for the axis lock', () => {
    expect(classifyPaginatedSwipe({
      startedOnText: true, dx: 4, dy: 2, dtMs: 40, vx: 0.1,
    })).toBe('undecided')
  })

  it('turns the page on a left swipe, including on text', () => {
    expect(classifyPaginatedSwipe({
      startedOnText: true, dx: -28, dy: 3, dtMs: 90, vx: -0.4,
    })).toBe('page')
    expect(classifyPaginatedSwipe({
      startedOnText: true, dx: -36, dy: 2, dtMs: 260, vx: -0.1,
    })).toBe('page')
  })

  it('turns previous from a quick right flick on text', () => {
    expect(classifyPaginatedSwipe({
      startedOnText: true, dx: 36, dy: 2, dtMs: 80, vx: 0.45,
    })).toBe('page')
  })

  it('highlights an intentional LTR drag on text', () => {
    expect(classifyPaginatedSwipe({
      startedOnText: true, dx: 32, dy: 4, dtMs: 240, vx: 0.12,
    })).toBe('select')
  })

  it('does not treat a short LTR swipe on text as a highlight', () => {
    expect(classifyPaginatedSwipe({
      startedOnText: true, dx: 20, dy: 2, dtMs: 80, vx: 0.22,
    })).toBe('undecided')
    expect(classifyPaginatedSwipe({
      startedOnText: true, dx: 28, dy: 2, dtMs: 100, vx: 0.25, phase: 'end',
    })).toBe('page')
  })

  it('turns previous from a right swipe that missed the words', () => {
    expect(classifyPaginatedSwipe({
      startedOnText: false, dx: 28, dy: 3, dtMs: 240, vx: 0.1,
    })).toBe('page')
  })

  it('keeps vertical swipes as page turns', () => {
    expect(classifyPaginatedSwipe({
      startedOnText: true, dx: 3, dy: -28, dtMs: 90, vx: 0, 
    })).toBe('page')
  })

  it('treats a short LTR press on a word as a tap', () => {
    expect(classifyPaginatedSwipe({
      startedOnText: true, dx: 10, dy: 1, dtMs: 80, vx: 0.12, phase: 'end',
    })).toBe('undecided')
  })
})
