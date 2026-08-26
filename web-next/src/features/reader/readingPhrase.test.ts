import { describe, expect, it } from 'vitest'
import {
  expandToReadingPhrase,
  expandToReadingWindow,
  resolveReadingWindow,
} from './readingPhrase'

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

  it('continues a sentence across a wrapped line', () => {
    const text = 'First line continues\nhere to the end. Next sentence.'
    const range = expandToReadingPhrase(0, 5, text)
    expect(text.slice(range.start, range.end)).toBe(
      'First line continues\nhere to the end.',
    )
  })

  it('stops at a blank line', () => {
    const text = 'First paragraph sentence.\n\nSecond paragraph sentence.'
    const range = expandToReadingPhrase(0, 5, text)
    expect(text.slice(range.start, range.end)).toBe('First paragraph sentence.')
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

  it('keeps a long sentence intact instead of a short slice', () => {
    const long = `Word ${'lorem '.repeat(80)}ends here. Next is short.`
    const range = expandToReadingPhrase(0, 4, long)
    expect(range.end - range.start).toBeGreaterThan(320)
    expect(long.slice(range.start, range.end)).toContain('ends here.')
    expect(long.slice(range.start, range.end)).not.toContain('Next is short')
  })
})

describe('reading window', () => {
  const text = 'One is first. Two is second. Three is third. Four is next. Five ends.'

  it('covers about three sentences from the current one', () => {
    const cue = text.indexOf('Two')
    const range = expandToReadingWindow(cue, cue + 3, text)
    expect(text.slice(range.start, range.end)).toBe(
      'Two is second. Three is third. Four is next.',
    )
  })

  it('holds the same window until that span is finished', () => {
    const current = expandToReadingWindow(text.indexOf('Two'), text.indexOf('Two') + 3, text)
    expect(resolveReadingWindow(text.indexOf('Three'), text, current)).toEqual(current)
    expect(resolveReadingWindow(text.indexOf('Four'), text, current)).toEqual(current)
  })

  it('advances to the next three sentences after the window is spoken', () => {
    const current = expandToReadingWindow(text.indexOf('One'), text.indexOf('One') + 3, text)
    const next = resolveReadingWindow(text.indexOf('Four'), text, current)
    expect(text.slice(next.start, next.end)).toBe('Four is next. Five ends.')
  })

  it('does not cross a paragraph once a sentence is in the window', () => {
    const para = 'First stays. Second stays too.\n\nThird is later. Fourth follows.'
    const range = expandToReadingWindow(0, 1, para)
    expect(para.slice(range.start, range.end)).toBe('First stays. Second stays too.')
  })

  it('covers three sentences even when lines wrap', () => {
    const text = 'One is first.\nTwo is second. Three is third. Four is next.'
    const range = expandToReadingWindow(0, 1, text)
    expect(text.slice(range.start, range.end)).toBe(
      'One is first.\nTwo is second. Three is third.',
    )
  })
})
