import { describe, expect, it } from 'vitest'
import { bookPageTotal, pagesForOffset, progressPercent } from './readingProgress'

describe('progressPercent', () => {
  it('follows the character, not a made-up page scale', () => {
    expect(progressPercent({ textStart: 0, textLength: 10_000, pageNumber: 40, totalPages: 100 })).toBe(0)
    expect(progressPercent({ textStart: 2500, textLength: 10_000 })).toBe(25)
    expect(progressPercent({ textStart: 9999, textLength: 10_000 })).toBe(100)
  })

  it('falls back to page counts when the character was not stored', () => {
    expect(progressPercent({ pageNumber: 1, totalPages: 400 })).toBe(0)
    expect(progressPercent({ pageNumber: 200, totalPages: 400 })).toBe(50)
    expect(progressPercent(null)).toBe(0)
  })
})

describe('pagesForOffset', () => {
  it('sets the book page from the same place as the percent', () => {
    expect(pagesForOffset(0, 80_000, 400)).toEqual({ pageNumber: 1, totalPages: 400 })
    expect(pagesForOffset(40_000, 80_000, 400)).toEqual({ pageNumber: 200, totalPages: 400 })
    expect(pagesForOffset(79_999, 80_000, 400)).toEqual({ pageNumber: 400, totalPages: 400 })
    expect(bookPageTotal(1000, 0)).toBe(1)
    expect(bookPageTotal(1000, 457)).toBe(457)
  })
})
