/**
 * Google Dictionary-style card: word, phonetic, POS, definition, example.
 * No inflection headers, synonyms, or related-term extras.
 */

import type { DictionaryOrigin, DictionaryResponse } from './dictionaryCache'
import { polishGloss } from './dictionaryGloss'
import {
  collectRankedSenses,
  isInflectionHeader,
  isNicheDomainDefinition,
} from './dictionaryLookup'
import { isGrammaticalFormDefinition } from './dictionaryMorphology'

export interface DictionaryCardSense {
  definition: string
  example: string | null
}

export interface DictionaryCardGroup {
  partOfSpeech: string
  senses: DictionaryCardSense[]
}

export interface DictionaryCard {
  term: string
  displayTerm: string
  pronunciation: string | null
  groups: DictionaryCardGroup[]
  origin: DictionaryOrigin | null
}

const POS_ALIASES: Record<string, string> = {
  n: 'noun',
  noun: 'noun',
  'n-count': 'noun',
  'n-var': 'noun',
  'n-uncount': 'noun',
  'plural noun': 'noun',
  v: 'verb',
  verb: 'verb',
  'v-t': 'verb',
  'v-i': 'verb',
  adj: 'adjective',
  adjective: 'adjective',
  adv: 'adverb',
  adverb: 'adverb',
  prep: 'preposition',
  preposition: 'preposition',
  conj: 'conjunction',
  conjunction: 'conjunction',
  pron: 'pronoun',
  pronoun: 'pronoun',
  det: 'determiner',
  determiner: 'determiner',
  interjection: 'interjection',
  exclamation: 'exclamation',
  auxiliary: 'verb',
}

const MAX_POS_GROUPS = 3
const MAX_SENSES_PER_POS = 1

export function canonicalPartOfSpeech(raw: string | null | undefined): string {
  const key = (raw ?? '').trim().toLowerCase()
  if (!key) return ''
  if (POS_ALIASES[key]) return POS_ALIASES[key]
  const first = key.split(/[\s,/]+/)[0] ?? ''
  return POS_ALIASES[first] || first
}

export function displayHeadword(term: string, hyphenation?: string | null) {
  const raw = (hyphenation || '').trim()
  if (!raw) return term
  const dotted = raw
    .replace(/·/g, '|')
    .split(/[|‧•-]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .join('·')
  return dotted || term
}

export function formatPhonetic(raw: string | null | undefined): string | null {
  if (!raw) return null
  let text = raw.trim()
  if (!text) return null
  text = text.replace(/^\[/, '/').replace(/\]$/, '/')
  if (!text.startsWith('/')) text = `/${text}`
  if (!text.endsWith('/')) text = `${text}/`
  return text
}

function cleanDefinition(text: string): string {
  return polishGloss(text)
}

function pickExample(examples: string[], term: string): string | null {
  const cleaned = examples
    .map((ex) => ex.trim().replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/g, ''))
    .filter(Boolean)
  if (cleaned.length === 0) return null
  try {
    const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
    return cleaned.find((ex) => re.test(ex)) ?? cleaned[0]
  } catch {
    return cleaned[0]
  }
}

export function buildDictionaryCard(
  payload: DictionaryResponse | null | undefined,
  options?: {
    maxPos?: number
    maxSensesPerPos?: number
    queriedTerm?: string | null
    context?: string | null
  },
): DictionaryCard | null {
  if (!payload) return null
  const rankedAll = collectRankedSenses(payload, {
    preferPos: payload.preferPos,
    context: options?.context,
  }).filter((sense) => {
    if (isInflectionHeader(sense.definition)) return false
    if (isGrammaticalFormDefinition(sense.definition)) return false
    return true
  })
  const everyday = rankedAll.filter((sense) => !isNicheDomainDefinition(sense.definition))
  const ranked = everyday.length > 0 ? everyday : rankedAll
  if (ranked.length === 0) return null

  const queried = (options?.queriedTerm || payload.queriedTerm || payload.term || '').trim()
  const term = (payload.term || queried || '').trim()
  const maxPos = options?.maxPos ?? MAX_POS_GROUPS
  const maxSenses = options?.maxSensesPerPos ?? MAX_SENSES_PER_POS
  const groups: DictionaryCardGroup[] = []
  const seen = new Set<string>()
  const extraExamples = ranked.flatMap((sense) => sense.examples)

  for (const sense of ranked) {
    const pos = canonicalPartOfSpeech(sense.partOfSpeech) || 'word'
    let group = groups.find((g) => g.partOfSpeech === pos)
    if (!group) {
      if (groups.length >= maxPos) continue
      group = { partOfSpeech: pos, senses: [] }
      groups.push(group)
    }
    if (group.senses.length >= maxSenses) continue
    const definition = cleanDefinition(sense.definition)
    if (!definition) continue
    const key = `${pos}:${definition.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    group.senses.push({
      definition,
      example: pickExample([...sense.examples, ...extraExamples], queried || term),
    })
  }

  const nonempty = groups.filter((g) => g.senses.length > 0)
  if (nonempty.length === 0) return null

  const headword = queried || term || 'word'
  const sameLemma = headword.toLowerCase() === term.toLowerCase()
  const origin = payload.origin && payload.origin.term.toLowerCase() !== headword.toLowerCase()
    ? payload.origin
    : null

  return {
    term: headword,
    displayTerm: sameLemma ? displayHeadword(headword, payload.hyphenation) : headword,
    pronunciation: formatPhonetic(payload.pronunciation),
    groups: nonempty,
    origin,
  }
}

export { isInflectionHeader }
