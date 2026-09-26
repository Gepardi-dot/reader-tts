/**
 * One dictionary voice for Define.
 * Free Dictionary wins when it has a real gloss. Wiktionary only fills gaps.
 * Every gloss that reaches the card is short, capitalized, and finished.
 */

import { isGrammaticalFormDefinition } from './dictionaryMorphology'

export const DICTIONARY_GLOSS_VERSION = 2

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
