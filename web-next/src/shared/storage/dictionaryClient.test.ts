import { describe, expect, it } from 'vitest'
import {
  dictionaryLookupVariants,
  extractWiktionaryPronunciation,
  normalizeDictionaryPayload,
  normalizeLookupWord,
  normalizeWiktionaryPayload,
  stripDictionaryHtml,
} from './dictionaryClient'

describe('normalizeLookupWord', () => {
  it('strips wrapping punctuation', () => {
    expect(normalizeLookupWord('“Jealousy.”')).toBe('jealousy')
    expect(normalizeLookupWord('(book)')).toBe('book')
  })
})

describe('dictionaryLookupVariants', () => {
  it('tries the lemma for inflected forms', () => {
    expect(dictionaryLookupVariants('jealousies')).toContain('jealousy')
    expect(dictionaryLookupVariants('books')).toContain('book')
  })
})

describe('normalizeDictionaryPayload', () => {
  it('reads IPA from phonetics and drops synonym extras', () => {
    const payload = normalizeDictionaryPayload([{
      word: 'jealousy',
      phonetic: '',
      phonetics: [
        { text: '/ˈdʒɛləsi/', audio: 'https://api.dictionaryapi.dev/media/pronunciations/en/jealousy-us.mp3' },
      ],
      meanings: [{
        partOfSpeech: 'noun',
        synonyms: ['envy', 'resentment'],
        definitions: [{
          definition: 'the state or feeling of being jealous.',
          example: 'a sharp pang of jealousy',
          synonyms: ['envy'],
        }],
      }],
    }], 'jealousy')

    expect(payload).not.toBeNull()
    expect(payload!.term).toBe('jealousy')
    expect(payload!.pronunciation).toBe('/ˈdʒɛləsi/')
    expect(payload!.source).toBe('online')
    expect(payload!.entries?.[0]?.definitions?.[0]?.synonyms).toEqual([])
    expect(payload!.entries?.[0]?.definitions?.[0]?.examples).toEqual(['a sharp pang of jealousy'])
  })
})

describe('Wiktionary normalize', () => {
  it('strips markup and keeps a real gloss plus example', () => {
    const payload = normalizeWiktionaryPayload({
      en: [{
        partOfSpeech: 'Noun',
        definitions: [{
          definition: 'A state of being <a href="/wiki/jealous">jealous</a>; a jealous attitude.',
          examples: ['She was mad with <b>jealousy</b>.'],
        }],
      }],
    }, 'jealousy')
    expect(payload?.entries?.[0]?.partOfSpeech).toBe('Noun')
    expect(payload?.entries?.[0]?.definitions?.[0]?.definition).toBe(
      'A state of being jealous; a jealous attitude.',
    )
    expect(payload?.entries?.[0]?.definitions?.[0]?.examples).toEqual(['She was mad with jealousy.'])
    expect(payload?.source).toBe('online')
  })

  it('reads IPA and hyphenation from wikitext', () => {
    const pron = extractWiktionaryPronunciation(`
==English==
===Pronunciation===
* {{IPA|en|/ˈd͡ʒɛl.ə.si/}}
* {{hyphenation|en|jeal|ous|y}}
`)
    expect(pron.pronunciation).toBe('/ˈd͡ʒɛl.ə.si/')
    expect(pron.hyphenation).toBe('jeal·ous·y')
  })

  it('drops empty HTML labels', () => {
    expect(stripDictionaryHtml('<span class="usage-label-sense"></span> A state of being jealous.')).toBe(
      'A state of being jealous.',
    )
  })
})
