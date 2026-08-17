import { describe, expect, it } from 'vitest'
import { expandToReadingPhrase } from './readingPhrase'

describe('expandToReadingPhrase', () => {
  it('expands a mid-sentence cue to the full sentence', () => {
    const text =
      'Hello there. Whether you are a designer, it is likely you have been in a meeting. Next.'
    const cue = text.indexOf('designer')
    const range = expandToReadingPhrase(cue, cue + 'designer'.length, text)
    expect(text.slice(range.start, range.end)).toBe(
      'Whether you are a designer, it is likely you have been in a meeting.',
    )
  })

  it('stops at paragraph breaks', () => {
    const text = 'First line stays here.\nSecond line is another thought.'
    const cue = text.indexOf('Second')
    const range = expandToReadingPhrase(cue, cue + 6, text)
    expect(text.slice(range.start, range.end)).toBe('Second line is another thought.')
  })

  it('includes trailing quotes after the period', () => {
    const text = 'She said "design has come up explicitly or otherwise." Done.'
    const cue = text.indexOf('design')
    const range = expandToReadingPhrase(cue, cue + 6, text)
    expect(text.slice(range.start, range.end)).toContain('otherwise."')
  })

  it('handles empty text without throwing', () => {
    expect(expandToReadingPhrase(2, 5, '')).toEqual({ start: 2, end: 5 })
  })
})
