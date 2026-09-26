import { describe, expect, it } from 'vitest'
import {
  authoritativeReading,
  chooseGlossSource,
  lemmaCandidates,
  polishGloss,
  settleGlossPayload,
} from './dictionaryGloss'

describe('polishGloss', () => {
  it('makes short dictionary lines look the same', () => {
    expect(polishGloss('the state or feeling of being jealous.')).toBe(
      'The state or feeling of being jealous.',
    )
    expect(polishGloss('make or become different')).toBe('Make or become different.')
  })

  it('keeps the first sentence of a long gloss', () => {
    const long = 'A long explanation of the word that keeps going past the point where a reader needs it. The rest is encyclopedia prose about history and rare usages that should not lead the card.'
    expect(polishGloss(long)).toBe(
      'A long explanation of the word that keeps going past the point where a reader needs it.',
    )
  })
})

describe('chooseGlossSource', () => {
  it('keeps Free Dictionary when both sources have a real gloss', () => {
    const free = {
      entries: [{ definitions: [{ definition: 'A feeling of envy toward someone.' }] }],
    }
    const wiki = {
      entries: [{ definitions: [{ definition: 'Jealous resentment against a rival, or against the success or advantage of a rival.' }] }],
    }
    expect(chooseGlossSource(free, wiki)).toBe(free)
  })

  it('uses Wiktionary only when Free Dictionary has no real gloss', () => {
    const free = {
      entries: [{ definitions: [{ definition: 'Third-person singular simple present of inspire.' }] }],
    }
    const wiki = {
      entries: [{ definitions: [{ definition: 'To fill someone with the urge to do something.' }] }],
    }
    expect(chooseGlossSource(free, wiki)).toBe(wiki)
  })
})

describe('lemmaCandidates', () => {
  it('stems inflections without turning plurals into nonsense first', () => {
    expect(lemmaCandidates('inspires')[0]).toBe('inspire')
    expect(lemmaCandidates('running')[0]).toBe('run')
    expect(lemmaCandidates('loved')[0]).toBe('love')
    expect(lemmaCandidates('boxes')[0]).toBe('box')
    expect(lemmaCandidates('books')[0]).toBe('book')
  })
})

describe('authoritativeReading', () => {
  it('follows comes to the verb come and ignores the fugue noun', () => {
    const reading = authoritativeReading({
      entries: [
        {
          partOfSpeech: 'Verb',
          definitions: [{
            definition: 'third-person singular simple present indicative of come',
            formOf: 'come',
          }],
        },
        {
          partOfSpeech: 'Noun',
          definitions: [{
            definition: 'The answer to the theme, or dux, in a fugue.',
          }],
        },
      ],
    })
    expect(reading).toEqual({ kind: 'inflection', lemma: 'come', partOfSpeech: 'verb' })
  })

  it('keeps an ordinary noun when the word is not only an inflection', () => {
    const reading = authoritativeReading({
      entries: [
        {
          partOfSpeech: 'Noun',
          definitions: [{ definition: 'A structure with a roof and walls.' }],
        },
        {
          partOfSpeech: 'Verb',
          definitions: [{ definition: 'present participle of build', formOf: 'build' }],
        },
      ],
    })
    expect(reading).toMatchObject({
      kind: 'sense',
      partOfSpeech: 'noun',
      everyday: true,
    })
  })

  it('uses the verb sense of the base word when that part of speech is known', () => {
    const reading = authoritativeReading({
      entries: [
        {
          partOfSpeech: 'Noun',
          definitions: [{ definition: 'A change of position or location.' }],
        },
        {
          partOfSpeech: 'Verb',
          definitions: [{ definition: 'To move toward a person or place.' }],
        },
      ],
    }, 'verb')
    expect(reading).toMatchObject({
      kind: 'sense',
      partOfSpeech: 'verb',
      definition: 'To move toward a person or place.',
    })
  })
})

describe('settleGlossPayload', () => {
  it('drops form-of lines and stores one settled voice', () => {
    const settled = settleGlossPayload({
      term: 'inspire',
      available: true,
      entries: [{
        partOfSpeech: 'verb',
        definitions: [
          { definition: 'third-person singular simple present indicative of inspire' },
          { definition: 'to fill with the urge to do something bold' },
        ],
      }],
      source: 'online',
    })
    expect(settled.glossVersion).toBe(3)
    expect(settled.entries?.[0]?.definitions?.map((def) => def.definition)).toEqual([
      'To fill with the urge to do something bold.',
    ])
  })
})
