/**
 * One dictionary voice for Define.
 * Free Dictionary wins when it has a real gloss. Wiktionary only fills gaps.
 * Every gloss that reaches the card is short, capitalized, and finished.
 */

import { extractFormOfLemmaFromText, isGrammaticalFormDefinition } from './dictionaryMorphology'

export const DICTIONARY_GLOSS_VERSION = 3

export interface GlossDefinition {
  definition: string
  examples?: string[]
  synonyms?: string[]
  formOf?: string | null
}

export interface GlossEntry {
  partOfSpeech?: string
  definitions?: GlossDefinition[]
}

export interface GlossPayload {
  term: string
  available: boolean
  message?: string | null
  pronunciation?: string | null
  hyphenation?: string | null
  entries?: GlossEntry[]
  relatedTerms?: string[]
  source?: 'seed' | 'online' | 'gemini' | 'local' | 'none' | null
  glossVersion?: number
  queriedTerm?: string | null
  preferPos?: string | null
}

export function polishGloss(text: string): string {
  let gloss = text.replace(/\s+/g, ' ').trim()
  gloss = gloss.replace(/^\([^)]{1,48}\)\s*/, '').trim()
  if (!gloss) return ''
  if (gloss.length > 140) {
    const cut = gloss.search(/[.!?](?=\s+[A-Z])/)
    if (cut >= 24) gloss = gloss.slice(0, cut + 1)
    else gloss = gloss.slice(0, 138).replace(/\s+\S*$/, '').replace(/[,:;]\s*$/, '')
  }
  gloss = gloss.charAt(0).toUpperCase() + gloss.slice(1)
  if (!/[.!?…]$/.test(gloss)) gloss += '.'
  return gloss
}

export function isUsableGloss(text: string | null | undefined, formOf?: string | null): boolean {
  if (formOf?.trim()) return false
  const gloss = (text ?? '').trim()
  if (gloss.length < 12) return false
  if (isGrammaticalFormDefinition(gloss)) return false
  return true
}

export function hasRealGloss(payload: { entries?: GlossEntry[] } | null | undefined): boolean {
  for (const entry of payload?.entries ?? []) {
    for (const def of entry.definitions ?? []) {
      if (isUsableGloss(def.definition, def.formOf)) return true
    }
  }
  return false
}

const LEADING_SPECIALIST_LABEL =
  /^\s*\((?:archaic|obsolete|rare|dated|historical|dialect|music|musical|law|legal|medicine|medical|grammar|linguistics|heraldry|nautical|botany|zoology|anatomy)\)/i

const SPECIALIST_WORD =
  /\b(?:fugue|dux|heraldry|blazon|phoneme|morpheme|accusative|nominative|genitive|dative|vocative|subjunctive|counterpoint|taxonomy)\b/i

/** A rare technical sense, not the meaning a reader needs for an ordinary word. */
export function isSpecialistGloss(text: string | null | undefined): boolean {
  const gloss = (text ?? '').trim()
  if (!gloss) return false
  if (LEADING_SPECIALIST_LABEL.test(gloss)) return true
  if (SPECIALIST_WORD.test(gloss)) return true
  return false
}

export function canonicalGlossPos(raw: string | null | undefined): string {
  const key = (raw ?? '').trim().toLowerCase().split(/[\s,/]+/)[0] ?? ''
  const aliases: Record<string, string> = {
    n: 'noun',
    v: 'verb',
    adj: 'adjective',
    adv: 'adverb',
  }
  return aliases[key] || key
}

export type AuthoritativeReading =
  | { kind: 'sense'; partOfSpeech: string; definition: string; examples: string[]; everyday: boolean }
  | { kind: 'inflection'; lemma: string; partOfSpeech: string }

interface ListedSense {
  partOfSpeech: string
  definition: string
  examples: string[]
  everyday: boolean
  inflection: { lemma: string; partOfSpeech: string } | null
}

function inflectionOf(def: GlossDefinition, partOfSpeech: string): { lemma: string; partOfSpeech: string } | null {
  const pos = canonicalGlossPos(partOfSpeech) || 'verb'
  const linked = (def.formOf || '').trim().toLowerCase()
  if (linked) return { lemma: linked, partOfSpeech: pos }
  const text = def.definition || ''
  if (!isGrammaticalFormDefinition(text)) return null
  if (!/\b(third[- ]person|first[- ]person|second[- ]person|plural|past tense|present tense|participle|gerund|indicative|infinitive)\b/i.test(text)) {
    return null
  }
  const lemma = extractFormOfLemmaFromText(text)
  if (!lemma) return null
  return { lemma, partOfSpeech: pos }
}

/**
 * Dictionary order, not a score.
 * An ordinary sense wins. A line that only says "form of come" sends us to that base word.
 * A rare sense such as the fugue noun "comes" is used only when the word has no ordinary meaning
 * and is not an inflection.
 */
export function authoritativeReading(
  payload: { entries?: GlossEntry[] } | null | undefined,
  preferPos?: string | null,
): AuthoritativeReading | null {
  const listed: ListedSense[] = []
  for (const entry of payload?.entries ?? []) {
    const pos = canonicalGlossPos(entry.partOfSpeech)
    for (const def of entry.definitions ?? []) {
      const definition = (def.definition || '').trim()
      if (!definition) continue
      const inflection = inflectionOf(def, pos)
      const everyday = !inflection && isUsableGloss(definition, def.formOf) && !isSpecialistGloss(definition)
      if (!everyday && !inflection && !isUsableGloss(definition, def.formOf)) continue
      listed.push({
        partOfSpeech: pos,
        definition,
        examples: (def.examples ?? []).map((example) => example.trim()).filter(Boolean),
        everyday,
        inflection,
      })
    }
  }

  const wanted = canonicalGlossPos(preferPos)
  const everyday = listed.filter((sense) => sense.everyday)
  const everydayPool = wanted ? everyday.filter((sense) => sense.partOfSpeech === wanted) : everyday
  const chosenEveryday = (everydayPool.length ? everydayPool : everyday)[0]
  if (chosenEveryday) {
    return {
      kind: 'sense',
      partOfSpeech: chosenEveryday.partOfSpeech || 'word',
      definition: chosenEveryday.definition,
      examples: chosenEveryday.examples,
      everyday: true,
    }
  }

  const inflections = listed
    .map((sense) => sense.inflection)
    .filter((item): item is { lemma: string; partOfSpeech: string } => Boolean(item))
  const inflectionPool = wanted ? inflections.filter((item) => item.partOfSpeech === wanted) : inflections
  const inflection = (inflectionPool.length ? inflectionPool : inflections)[0]
  if (inflection) return { kind: 'inflection', ...inflection }

  const fallback = listed.find((sense) => isUsableGloss(sense.definition))
  if (!fallback) return null
  return {
    kind: 'sense',
    partOfSpeech: fallback.partOfSpeech || 'word',
    definition: fallback.definition,
    examples: fallback.examples,
    everyday: false,
  }
}

/** Same wording every time: keep Free Dictionary when it has a real sense. */
export function chooseGlossSource<T extends { entries?: GlossEntry[] } | null>(
  free: T,
  wiki: T,
): T | null {
  if (hasRealGloss(free)) return free
  if (hasRealGloss(wiki)) return wiki
  return free ?? wiki ?? null
}

export function lemmaCandidates(term: string): string[] {
  const base = term.trim().toLowerCase()
  if (!base) return []
  const out: string[] = []
  const push = (value: string) => {
    const next = value.trim().toLowerCase()
    if (next.length >= 3 && next !== base && !out.includes(next)) out.push(next)
  }
  if (base.endsWith("'s")) push(base.slice(0, -2))
  if (base.endsWith('ies') && base.length > 4) push(`${base.slice(0, -3)}y`)
  if (base.endsWith('ves') && base.length > 4) {
    push(`${base.slice(0, -3)}f`)
    push(`${base.slice(0, -3)}fe`)
  }
  if (base.endsWith('ing') && base.length > 5) {
    if (base.length > 6 && base[base.length - 4] === base[base.length - 5]) push(base.slice(0, -4))
    push(`${base.slice(0, -3)}e`)
    push(base.slice(0, -3))
  }
  if (base.endsWith('ed') && base.length > 4) {
    if (base.length > 5 && base[base.length - 3] === base[base.length - 4]) push(base.slice(0, -3))
    else push(base.slice(0, -1))
    push(base.slice(0, -2))
  }
  if (/(ches|shes|sses|xes|zes|oes)$/.test(base) && base.length > 4) push(base.slice(0, -2))
  else if (base.endsWith('es') && base.length > 4) push(base.slice(0, -1))
  if (base.endsWith('s') && !base.endsWith('ss') && base.length > 3) push(base.slice(0, -1))
  return out.slice(0, 3)
}

/** -ing/-ed are verbs. A trailing s is not — plurals were being defined as verbs. */
export function preferredGlossPos(term: string): string | null {
  const base = term.trim().toLowerCase()
  if (base.endsWith('ly') && base.length > 5) return 'adverb'
  if (/(ing|ed)$/.test(base) && base.length > 5) return 'verb'
  return null
}

export function settleGlossPayload<T extends GlossPayload>(payload: T): T & { glossVersion?: number } {
  const entries: GlossEntry[] = []
  for (const entry of payload.entries ?? []) {
    const definitions: GlossDefinition[] = []
    for (const def of entry.definitions ?? []) {
      if (!isUsableGloss(def.definition, def.formOf)) continue
      const definition = polishGloss(def.definition)
      if (!isUsableGloss(definition)) continue
      definitions.push({
        definition,
        examples: (def.examples ?? []).map((example) => example.trim()).filter(Boolean).slice(0, 2),
        synonyms: [],
        formOf: null,
      })
      if (definitions.length >= 3) break
    }
    if (definitions.length === 0) continue
    entries.push({ partOfSpeech: entry.partOfSpeech, definitions })
    if (entries.length >= 4) break
  }
  return {
    ...payload,
    available: entries.length > 0,
    message: entries.length > 0 ? null : (payload.message ?? 'No definition found.'),
    entries,
    relatedTerms: [],
    glossVersion: entries.length > 0 ? DICTIONARY_GLOSS_VERSION : payload.glossVersion,
  }
}
