import { describe, expect, it } from 'vitest'
import {
  derivedRootCandidates,
  extractFormOfLemmaFromHtml,
  extractFormOfLemmaFromText,
  inflectionLemmaCandidates,
  isGrammaticalFormDefinition,
  morphKindForTerm,
} from './dictionaryMorphology'

describe('isGrammaticalFormDefinition', () => {
  it('detects Wiktionary form-of glosses', () => {
    expect(isGrammaticalFormDefinition(
      'third-person singular simple present indicative of inspire',
    )).toBe(true)
    expect(isGrammaticalFormDefinition('present participle and gerund of change')).toBe(true)
    expect(isGrammaticalFormDefinition('Fill someone with the urge to do something.')).toBe(false)
  })
})

describe('extractFormOfLemma', () => {
  it('reads the lemma from HTML and from stripped text', () => {
    const html = '<span class="form-of-definition">third-person singular of <span class="form-of-definition-link"><a href="/wiki/inspire#English" title="inspire">inspire</a></span></span>'
    expect(extractFormOfLemmaFromHtml(html)).toBe('inspire')
    expect(extractFormOfLemmaFromText('present participle and gerund of change')).toBe('change')
  })
})

describe('candidates', () => {
  it('stems inflections and derived adverbs', () => {
    expect(inflectionLemmaCandidates('inspires')).toContain('inspire')
    expect(inflectionLemmaCandidates('changing')).toContain('change')
    expect(derivedRootCandidates('brilliantly')).toContain('brilliant')
    expect(morphKindForTerm('inspires')).toBe('inflection')
    expect(morphKindForTerm('brilliantly')).toBe('derivation')
  })
})
