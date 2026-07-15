import { describe, expect, it } from 'vitest'
import {
  formatStudyDefinition,
  isFabricatedContextSentence,
  isNicheDomainDefinition,
  isRealBookSentence,
  pickBestDefinition,
  shouldRefreshDefinition,
} from './dictionaryLookup'
import type { DictionaryResponse } from './dictionaryCache'

/** Mirrors Free Dictionary's order for "verbal" (grammar noun first). */
const VERBAL_PAYLOAD: DictionaryResponse = {
  term: 'verbal',
  available: true,
  pronunciation: "/ˈtʃeɪndʒɪŋ/",
  entries: [
    {
      partOfSpeech: 'noun',
      definitions: [
        {
          definition:
            '(grammar) A verb form which does not function as a predicate, or a word derived from a verb. In English, infinitives, participles and gerunds are verbals.',
        },
        { definition: 'A confession given to police.' },
      ],
    },
    {
      partOfSpeech: 'verb',
      definitions: [
        { definition: 'To induce into fabricating a confession.' },
      ],
    },
    {
      partOfSpeech: 'adjective',
      definitions: [
        { definition: 'Of or relating to words.' },
        { definition: 'Concerned with the words, rather than the substance of a text.' },
        { definition: 'Consisting of words only.' },
        {
          definition: 'Expressly spoken rather than written; oral.',
          examples: ['a verbal contract'],
        },
      ],
    },
  ],
}

describe('pickBestDefinition', () => {
  it('prefers everyday adjective sense of verbal over grammar noun', () => {
    const hit = pickBestDefinition(VERBAL_PAYLOAD)
    expect(hit).not.toBeNull()
    expect(hit!.definition.toLowerCase()).toMatch(/relating to words|spoken rather than written|words only|concerned with the words/)
    expect(hit!.definition.toLowerCase()).not.toMatch(/predicate|gerund|participle/)
    expect(hit!.partOfSpeech).toMatch(/adjective/i)
  })

  it('uses book context to prefer spoken/oral sense when relevant', () => {
    const hit = pickBestDefinition(VERBAL_PAYLOAD, {
      context: 'She made a verbal promise to tell the whole story out loud.',
    })
    expect(hit).not.toBeNull()
    expect(hit!.definition.toLowerCase()).toMatch(/spoken|oral|relating to words|words/)
    expect(isNicheDomainDefinition(hit!.definition)).toBe(false)
  })

  it('still avoids grammar sense even with empty context', () => {
    const hit = pickBestDefinition(VERBAL_PAYLOAD, { context: '' })
    expect(isNicheDomainDefinition(hit!.definition)).toBe(false)
  })

  it('returns null for empty payload', () => {
    expect(pickBestDefinition(null)).toBeNull()
    expect(pickBestDefinition({ term: 'x', available: false, entries: [] })).toBeNull()
  })
})

describe('isNicheDomainDefinition', () => {
  it('flags grammar-tagged glosses', () => {
    expect(isNicheDomainDefinition('(grammar) A verb form which does not function as a predicate.')).toBe(true)
  })

  it('allows everyday glosses', () => {
    expect(isNicheDomainDefinition('Of or relating to words.')).toBe(false)
    expect(isNicheDomainDefinition('Expressly spoken rather than written; oral.')).toBe(false)
  })
})

describe('shouldRefreshDefinition', () => {
  it('refreshes niche and empty defs', () => {
    expect(shouldRefreshDefinition('(grammar) A verb form which does not function as a predicate.', 'verbal')).toBe(true)
    expect(shouldRefreshDefinition('verbal', 'verbal')).toBe(true)
    expect(shouldRefreshDefinition('Saved from your reading.', 'verbal')).toBe(true)
  })

  it('keeps good reading defs', () => {
    expect(shouldRefreshDefinition('Of or relating to words.', 'verbal')).toBe(false)
  })
})

describe('isFabricatedContextSentence', () => {
  it('detects the old template (including cloze-blanked form)', () => {
    expect(isFabricatedContextSentence(
      'In the story, the idea of “verbal” comes up — (grammar) A verb form…',
      'verbal',
      '(grammar) A verb form',
    )).toBe(true)
    expect(isFabricatedContextSentence(
      'In the story, the idea of " " comes up — (grammar) A verb form which does not function as a predicate.',
      'verbal',
      '(grammar) A verb form which does not function as a predicate.',
    )).toBe(true)
  })

  it('allows real book sentences', () => {
    expect(isFabricatedContextSentence(
      'He preferred a verbal agreement over a written contract.',
      'verbal',
      'spoken rather than written',
    )).toBe(false)
  })
})

describe('isRealBookSentence', () => {
  it('rejects the shared template and accepts a unique book line', () => {
    expect(isRealBookSentence(
      'In the story, the idea of “changing” comes up — To become something different.',
      'changing',
      'To become something different.',
    )).toBe(false)
    expect(isRealBookSentence(
      'The tadpole changed into a frog. Stock prices are constantly changing.',
      'changing',
      'To become something different.',
    )).toBe(true)
  })
})

describe('formatStudyDefinition', () => {
  it('capitalizes plain glosses', () => {
    expect(formatStudyDefinition('of or relating to words.')).toBe('Of or relating to words.')
  })
})
