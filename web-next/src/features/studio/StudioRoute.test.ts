import { describe, expect, it } from 'vitest'
import { isVocabWord, isPlaceholderDefinition } from './StudioRoute'

describe('isVocabWord', () => {
  it('accepts a single lowercase word', () => {
    expect(isVocabWord('charisma')).toBe(true)
    expect(isVocabWord('marrow')).toBe(true)
  })

  it('accepts a single hyphenated word', () => {
    expect(isVocabWord('self-aware')).toBe(true)
  })

  it('trims whitespace and accepts a single word', () => {
    expect(isVocabWord('  noteworthy  ')).toBe(true)
    expect(isVocabWord('\tcharisma\n')).toBe(true)
  })

  it('rejects multi-word phrases (the bug we are guarding against)', () => {
    expect(isVocabWord('but never before have I seen its marrow')).toBe(false)
    expect(isVocabWord('go through (mental or physical states or experiences)')).toBe(false)
    expect(isVocabWord('saved from reading')).toBe(false)
    expect(isVocabWord('two words')).toBe(false)
  })

  it('rejects empty / whitespace / punctuation-only strings', () => {
    expect(isVocabWord('')).toBe(false)
    expect(isVocabWord('   ')).toBe(false)
    expect(isVocabWord('---')).toBe(false)
    expect(isVocabWord('123')).toBe(false)
    expect(isVocabWord('!!!')).toBe(false)
  })

  it('handles non-string defensively', () => {
    expect(isVocabWord(undefined as unknown as string)).toBe(false)
    expect(isVocabWord(null as unknown as string)).toBe(false)
  })

  it('accepts unicode words (non-ASCII letters)', () => {
    expect(isVocabWord('résumé')).toBe(true)
    expect(isVocabWord('über')).toBe(true)
    expect(isVocabWord('café')).toBe(true)
  })

  it('correctly filters a mixed list of saved notes', () => {
    const notes = [
      'charisma',
      'but never before have I seen its marrow',
      'marrow',
      'saved from reading',
      'self-aware',
      '',
      '   ',
    ]
    const filtered = notes.filter(isVocabWord)
    expect(filtered).toEqual(['charisma', 'marrow', 'self-aware'])
  })
})

describe('isPlaceholderDefinition', () => {
  it('flags the empty / null / undefined cases', () => {
    expect(isPlaceholderDefinition(null)).toBe(true)
    expect(isPlaceholderDefinition(undefined)).toBe(true)
    expect(isPlaceholderDefinition('')).toBe(true)
    expect(isPlaceholderDefinition('   ')).toBe(true)
    expect(isPlaceholderDefinition('a')).toBe(true)  // too short
  })

  it('flags the canonical fallback strings (the actual bug)', () => {
    expect(isPlaceholderDefinition('Saved from your reading.')).toBe(true)
    expect(isPlaceholderDefinition('saved from your reading')).toBe(true)
    expect(isPlaceholderDefinition('Saved from reading')).toBe(true)
    expect(isPlaceholderDefinition('Definition unavailable')).toBe(true)
    expect(isPlaceholderDefinition('A word from your reading')).toBe(true)
  })

  it('flags "see X" cross-references that lexicographers omit', () => {
    expect(isPlaceholderDefinition('see also: charisma')).toBe(true)
  })

  it('accepts real definitions', () => {
    expect(isPlaceholderDefinition('A magnetic charm or appeal that inspires devotion in others.')).toBe(false)
    expect(isPlaceholderDefinition('the inner core of a bone')).toBe(false)
    expect(isPlaceholderDefinition('(adjective) worth telling as a story; memorable')).toBe(false)
    expect(isPlaceholderDefinition('go through (mental or physical states or experiences)')).toBe(false)
  })

  it('handles whitespace defensively', () => {
    expect(isPlaceholderDefinition('  Saved from your reading.  ')).toBe(true)
    expect(isPlaceholderDefinition('  the inner core of a bone  ')).toBe(false)
  })
})
