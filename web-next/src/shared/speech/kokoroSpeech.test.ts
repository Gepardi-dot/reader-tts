import { describe, expect, it } from 'vitest'
import { prepareKokoroSpeech, yearWords } from './kokoroSpeech'

describe('prepareKokoroSpeech', () => {
  it('says a year as a year, not digit by digit', () => {
    expect(yearWords(1984)).toBe('nineteen eighty-four')
    expect(yearWords(1906)).toBe('nineteen oh six')
    expect(yearWords(2005)).toBe('two thousand five')
    expect(yearWords(2024)).toBe('twenty twenty-four')
    expect(yearWords(1066)).toBe('ten sixty-six')
    expect(prepareKokoroSpeech('In 1984 the war ended.')).toBe('In nineteen eighty-four the war ended.')
  })

  it('keeps a comma-grouped count as a count', () => {
    expect(prepareKokoroSpeech('They paid $1,984.')).toBe(
      'They paid one thousand nine hundred eighty-four dollars.',
    )
  })

  it('reads ordinals, clocks, percents, and year spans', () => {
    expect(prepareKokoroSpeech('On the 21st, at 3:05, about 12% remained.')).toBe(
      "On the twenty-first, at three oh five, about twelve percent remained.",
    )
    expect(prepareKokoroSpeech('From 1914-1918.')).toBe('From nineteen fourteen to nineteen eighteen.')
    expect(prepareKokoroSpeech('the 1980s')).toBe('the nineteen eighties')
  })

  it('pauses at a paragraph and expands titles', () => {
    expect(prepareKokoroSpeech('Dr. Smith left.\n\nShe waited.')).toBe(
      'Doctor Smith left. — She waited.',
    )
  })

  it('leaves an ordinary sentence untouched', () => {
    const text = 'She opened the door.'
    expect(prepareKokoroSpeech(text)).toBe(text)
    expect(prepareKokoroSpeech(prepareKokoroSpeech('In 1984 he left.\n\nThen he sat.'))).toBe(
      'In nineteen eighty-four he left. — Then he sat.',
    )
  })
})
