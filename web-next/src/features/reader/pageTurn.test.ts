import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PAGE_TURN_COMMIT_PX,
  PAGE_TURN_COMMIT_RATIO,
  PAGE_TURN_MIN_FLICK_PX,
  PAGE_TURN_VELOCITY_PX_MS,
  isFinePointerClick,
  lockPageTurnAxis,
  pageRestY,
  pageTurnClickDir,
  pageTurnDurationMs,
  prefersReducedMotion,
  resistPageTurnOffset,
  rubberBandOffset,
  shouldCommitPageTurn,
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

describe('pageTurnClickDir', () => {
  it('turns back on the left half and forward on the right half', () => {
    expect(pageTurnClickDir(0, 1000)).toBe(-1)
    expect(pageTurnClickDir(499, 1000)).toBe(-1)
    expect(pageTurnClickDir(500, 1000)).toBe(1)
    expect(pageTurnClickDir(999, 1000)).toBe(1)
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
