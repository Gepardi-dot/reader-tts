import { describe, expect, it } from 'vitest'
import {
  canonicalIsbn,
  extractIsbnsFromText,
  looksLikeAuthorName,
  looksLikeBookTitle,
} from './bookIdentifiers'

describe('canonicalIsbn', () => {
  it('accepts a hyphenated ISBN-13', () => {
    expect(canonicalIsbn('978-0-14-118263-6')).toBe('9780141182636')
  })

  it('converts a valid ISBN-10 to ISBN-13', () => {
    expect(canonicalIsbn('0141182636')).toBe('9780141182636')
  })

  it('rejects a number that is not an ISBN', () => {
    expect(canonicalIsbn('1234567890')).toBeNull()
  })
})

describe('extractIsbnsFromText', () => {
  it('finds an ISBN-13 on a copyright page', () => {
    expect(extractIsbnsFromText('First published 2000\nISBN 978-0-14-312774-1\nPrinted in the USA'))
      .toEqual(['9780143127741'])
  })

  it('finds a labeled ISBN-10', () => {
    expect(extractIsbnsFromText('ISBN-10: 0-14-118263-6')).toEqual(['9780141182636'])
  })

  it('pulls an ISBN-13 out of a filename', () => {
    expect(extractIsbnsFromText('The_Odyssey_9780140268867.pdf')).toEqual(['9780140268867'])
  })

  it('ignores unlabeled 10-digit numbers', () => {
    expect(extractIsbnsFromText('Call 4155551212 for details')).toEqual([])
  })
})

describe('looksLikeBookTitle', () => {
  it('accepts real titles and rejects export leftovers', () => {
    expect(looksLikeBookTitle('The Art of Seduction')).toBe(true)
    expect(looksLikeBookTitle('Microsoft Word - Document1')).toBe(false)
    expect(looksLikeBookTitle('scan.pdf')).toBe(false)
  })
})

describe('looksLikeAuthorName', () => {
  it('rejects empty and unknown authors', () => {
    expect(looksLikeAuthorName('Robert Greene')).toBe(true)
    expect(looksLikeAuthorName('Unknown')).toBe(false)
  })
})
