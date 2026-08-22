import { describe, expect, it } from 'vitest'
import { runWhenWindowLoaded } from './clientRecovery'

describe('runWhenWindowLoaded', () => {
  it('runs immediately when the document is already complete', () => {
    let ran = 0
    let loadBound = 0
    runWhenWindowLoaded(
      () => {
        ran += 1
      },
      { readyState: 'complete' },
      () => {
        loadBound += 1
      },
    )
    expect(ran).toBe(1)
    expect(loadBound).toBe(0)
  })

  it('waits for load when the document is still loading', () => {
    let ran = 0
    const captured: { fn?: () => void } = {}
    runWhenWindowLoaded(
      () => {
        ran += 1
      },
      { readyState: 'interactive' },
      (fn) => {
        captured.fn = fn
      },
    )
    expect(ran).toBe(0)
    expect(captured.fn).toBeTypeOf('function')
    captured.fn?.()
    expect(ran).toBe(1)
  })
})
