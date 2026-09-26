import { describe, expect, it } from 'vitest'
import type { DictionaryResponse } from './dictionaryCache'
import { isQualityDictionaryPayload } from './dictionaryCache'
import { isInflectionHeader } from './dictionaryLookup'
import {
  buildDictionaryCard,
  canonicalPartOfSpeech,
  formatPhonetic,
} from './dictionaryPresentation'

const JEALOUSY: DictionaryResponse = {
  term: 'jealousy',
  available: true,
  source: 'online',
  pronunciation: '/ˈdʒɛləsi/',
  entries: [
    {
      partOfSpeech: 'noun',
      definitions: [
        {
          definition: 'noun: jealousy; plural noun: jealousies',
          examples: [],
        },
        {
          definition: 'the state or feeling of being jealous.',
          examples: ['a sharp pang of jealousy', 'He was sick with jealousy.'],
        },
        {
          definition: '(archaic) A close concern for someone or something, solicitude, vigilance.',
          examples: [],
        },
      ],
    },
  ],
}

const WORDNET_BOOK: DictionaryResponse = {
  term: 'book',
  available: true,
  pronunciation: null,
  source: 'seed',
  entries: [
    {
      partOfSpeech: 'noun',
      definitions: [
        {
          definition: 'a written work or composition that has been published (printed on pages bound together)',
          examples: ['I am reading a good book on economics'],
        },
      ],
    },
  ],
}

describe('isInflectionHeader', () => {
  it('flags Google-style inflection lines', () => {
    expect(isInflectionHeader('noun: jealousy; plural noun: jealousies')).toBe(true)
    expect(isInflectionHeader('verb: run; 3rd person present: runs')).toBe(true)
    expect(isInflectionHeader('the state or feeling of being jealous.')).toBe(false)
  })
})

describe('formatPhonetic', () => {
  it('wraps IPA in slashes', () => {
    expect(formatPhonetic('ˈdʒɛləsi')).toBe('/ˈdʒɛləsi/')
    expect(formatPhonetic('/ˈdʒɛləsi/')).toBe('/ˈdʒɛləsi/')
    expect(formatPhonetic('[ˈdʒɛləsi]')).toBe('/ˈdʒɛləsi/')
  })
})

describe('canonicalPartOfSpeech', () => {
  it('maps dictionary codes to lowercase labels', () => {
    expect(canonicalPartOfSpeech('N-COUNT')).toBe('noun')
    expect(canonicalPartOfSpeech('Verb')).toBe('verb')
    expect(canonicalPartOfSpeech('adj')).toBe('adjective')
  })
})

describe('buildDictionaryCard', () => {
  it('shows word, phonetic, pos, definition, and example without inflection extras', () => {
    const card = buildDictionaryCard(JEALOUSY)
    expect(card).not.toBeNull()
    expect(card!.term).toBe('jealousy')
    expect(card!.displayTerm).toBe('jealousy')
    expect(card!.pronunciation).toBe('/ˈdʒɛləsi/')
    expect(card!.groups).toHaveLength(1)
    expect(card!.groups[0]!.partOfSpeech).toBe('noun')
    expect(card!.groups[0]!.senses).toHaveLength(1)
    expect(card!.groups[0]!.senses[0]!.definition).toBe('The state or feeling of being jealous.')
    expect(card!.groups[0]!.senses[0]!.example).toBe('a sharp pang of jealousy')
    expect(JSON.stringify(card)).not.toMatch(/plural noun/)
    expect(JSON.stringify(card)).not.toMatch(/synonym/i)
  })

  it('matches the Google Dictionary card for a Wiktionary jealousy payload', () => {
    const card = buildDictionaryCard({
      term: 'jealousy',
      available: true,
      source: 'online',
      pronunciation: '/ˈd͡ʒɛl.ə.si/',
      hyphenation: 'jeal·ous·y',
      entries: [{
        partOfSpeech: 'Noun',
        definitions: [
          {
            definition: 'A state of being jealous; a jealous attitude.',
            examples: ['a man of many jealousies', 'She was mad with jealousy.'],
          },
          {
            definition: 'A close concern for someone or something, solicitude, vigilance.',
            examples: [],
          },
        ],
      }],
    })
    expect(card!.displayTerm).toBe('jeal·ous·y')
    expect(card!.pronunciation).toBe('/ˈd͡ʒɛl.ə.si/')
    expect(card!.groups).toEqual([{
      partOfSpeech: 'noun',
      senses: [{
        definition: 'A state of being jealous; a jealous attitude.',
        example: 'She was mad with jealousy.',
      }],
    }])
  })

  it('renders Wiktionary hyphenation with middle dots', () => {
    const card = buildDictionaryCard({
      ...JEALOUSY,
      hyphenation: 'jeal|ous|y',
    })
    expect(card!.displayTerm).toBe('jeal·ous·y')
    expect(card!.term).toBe('jealousy')
  })

  it('prefers an example that contains the headword', () => {
    const payload: DictionaryResponse = {
      term: 'change',
      available: true,
      source: 'online',
      pronunciation: '/tʃeɪndʒ/',
      entries: [{
        partOfSpeech: 'verb',
        definitions: [{
          definition: 'make or become different.',
          examples: ['The weather shifted overnight.', 'She wanted to change her name.'],
        }],
      }],
    }
    const card = buildDictionaryCard(payload)
    expect(card!.groups[0]!.senses[0]!.example).toBe('She wanted to change her name.')
  })

  it('does not show grammatical form-of lines as the meaning', () => {
    const card = buildDictionaryCard({
      term: 'inspire',
      queriedTerm: 'inspires',
      available: true,
      source: 'online',
      pronunciation: '/ɪnˈspaɪə/',
      preferPos: 'verb',
      entries: [{
        partOfSpeech: 'verb',
        definitions: [
          { definition: 'third-person singular simple present indicative of inspire' },
          {
            definition: 'To fill with what animates, enlivens or exalts.',
            examples: [
              'The captain’s speech was aimed to inspire her team to victory.',
              'a changing world',
            ],
          },
        ],
      }],
    }, { queriedTerm: 'inspires' })
    expect(card!.term).toBe('inspires')
    expect(card!.groups[0]!.partOfSpeech).toBe('verb')
    expect(card!.groups[0]!.senses[0]!.definition).toMatch(/animates|enlivens|exalts/)
    expect(card!.groups[0]!.senses[0]!.definition).not.toMatch(/third-person/)
    expect(card!.groups[0]!.senses[0]!.example).toBeTruthy()
    expect(card!.origin).toBeNull()
  })

  it('keeps a selected-word example when the lemma was resolved', () => {
    const card = buildDictionaryCard({
      term: 'change',
      queriedTerm: 'changing',
      available: true,
      source: 'online',
      preferPos: 'verb',
      entries: [{
        partOfSpeech: 'verb',
        definitions: [{
          definition: 'Make or become different.',
          examples: ['a changing world', 'She wanted to change her name.'],
        }],
      }, {
        partOfSpeech: 'noun',
        definitions: [{ definition: 'Change; alteration.' }],
      }],
    }, { queriedTerm: 'changing' })
    expect(card!.displayTerm).toBe('changing')
    expect(card!.groups[0]!.partOfSpeech).toBe('verb')
    expect(card!.groups[0]!.senses[0]!.example).toBe('a changing world')
  })

  it('does not show the rare fugue sense of comes when the verb meaning is present', () => {
    const card = buildDictionaryCard({
      term: 'come',
      queriedTerm: 'comes',
      available: true,
      source: 'online',
      preferPos: 'verb',
      entries: [
        {
          partOfSpeech: 'noun',
          definitions: [{ definition: 'The answer to the theme, or dux, in a fugue.' }],
        },
        {
          partOfSpeech: 'verb',
          definitions: [{ definition: 'To move toward the speaker or a place.' }],
        },
      ],
    }, { queriedTerm: 'comes', maxPos: 1 })
    expect(card!.groups[0]!.partOfSpeech).toBe('verb')
    expect(card!.groups[0]!.senses[0]!.definition).toMatch(/move toward/i)
  })

  it('uses the surrounding sentence to pick the sense', () => {
    const card = buildDictionaryCard({
      term: 'bank',
      available: true,
      source: 'online',
      glossVersion: 2,
      entries: [{
        partOfSpeech: 'noun',
        definitions: [
          { definition: 'A business that keeps and lends money.' },
          { definition: 'The land alongside a river or lake.' },
        ],
      }],
    }, { context: 'We sat on the bank and watched the river.', maxPos: 1 })
    expect(card!.groups).toHaveLength(1)
    expect(card!.groups[0]!.senses[0]!.definition).toMatch(/river|lake/i)
  })

  it('attaches the root word for derived adverbs', () => {
    const card = buildDictionaryCard({
      term: 'brilliantly',
      available: true,
      source: 'online',
      entries: [{
        partOfSpeech: 'adverb',
        definitions: [{ definition: 'In a brilliant manner; with brilliance.' }],
      }],
      origin: {
        term: 'brilliant',
        partOfSpeech: 'adjective',
        definition: 'Exceptionally clever or talented.',
      },
    }, { queriedTerm: 'brilliantly' })
    expect(card!.origin?.term).toBe('brilliant')
    expect(card!.origin?.definition).toMatch(/clever|talented/i)
    expect(card!.groups[0]!.partOfSpeech).toBe('adverb')
  })
})

describe('isQualityDictionaryPayload', () => {
  it('treats Wiktionary/IPA payloads as quality and WordNet seed as not', () => {
    expect(isQualityDictionaryPayload(JEALOUSY)).toBe(true)
    expect(isQualityDictionaryPayload(WORDNET_BOOK)).toBe(false)
  })
})
