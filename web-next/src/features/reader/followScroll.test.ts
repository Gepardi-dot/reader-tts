import { describe, expect, it } from 'vitest'
import {
  followScrollSettled,
  stepFollowScrollSpring,
} from './followScroll'

describe('followScrollSpring', () => {
  it('closes most of the gap within a reading-page settle time', () => {
    let state = { y: 0, v: 0 }
    const target = 220
    for (let i = 0; i < 24; i += 1) {
      state = stepFollowScrollSpring(state, target, 1 / 60)
    }
    expect(state.y).toBeGreaterThan(200)
    expect(Math.abs(state.y - target)).toBeLessThan(20)
  })

  it('lands without a visible bounce past the target', () => {
    let state = { y: 80, v: 0 }
    const target = 320
    let maxY = state.y
    for (let i = 0; i < 90; i += 1) {
      state = stepFollowScrollSpring(state, target, 1 / 60)
      maxY = Math.max(maxY, state.y)
    }
    expect(maxY).toBeLessThan(target + 8)
    expect(followScrollSettled(state, target)).toBe(true)
  })

  it('keeps velocity when the target moves so a retarget does not hitch', () => {
    let state = { y: 0, v: 0 }
    for (let i = 0; i < 8; i += 1) {
      state = stepFollowScrollSpring(state, 180, 1 / 60)
    }
    const vBefore = state.v
    state = stepFollowScrollSpring(state, 210, 1 / 60)
    expect(vBefore).toBeGreaterThan(0)
    expect(state.v).toBeGreaterThan(0)
    expect(state.y).toBeGreaterThan(0)
  })
})
