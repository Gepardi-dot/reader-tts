import { describe, expect, it } from 'vitest'
import { ACTIVE_USERS_FLOOR, displayedActiveUsers } from './activeUsers'

describe('displayedActiveUsers', () => {
  it('starts at the floor when real count matches the baseline', () => {
    expect(displayedActiveUsers(1, 1)).toBe(ACTIVE_USERS_FLOOR)
    expect(displayedActiveUsers(7, 7)).toBe(13)
  })

  it('counts each new real user after the baseline', () => {
    expect(displayedActiveUsers(2, 1)).toBe(14)
    expect(displayedActiveUsers(5, 1)).toBe(17)
  })

  it('never drops below the floor if accounts are deleted', () => {
    expect(displayedActiveUsers(0, 4)).toBe(13)
  })

  it('treats invalid counts as empty', () => {
    expect(displayedActiveUsers(Number.NaN, 1)).toBe(13)
  })
})
