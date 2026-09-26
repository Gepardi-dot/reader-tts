/**
 * Inflection vs derivation for reader dictionary cards.
 * "inspires" is a form of "inspire"; "brilliantly" is derived from "brilliant".
 */

export function isGrammaticalFormDefinition(text: string | null | undefined): boolean {
  if (!text) return false
  const t = text.trim()
  if (!t) return false
  if (/\b(third[- ]person|3rd[- ]person|first[- ]person|second[- ]person)\b/i.test(t) && /\bof\b/i.test(t)) {
    return true
  }
  if (/\b(present|past)\s+(participle|tense)\b/i.test(t) && /\bof\b/i.test(t)) return true
  if (/\b(gerund|plural|singular|indicative|subjunctive|imperative|infinitive|inflection)\b[\s\S]{0,80}\bof\b/i.test(t)) {
    return true
  }
  if (/^(inflection|conjugated form|verb form|plural form|adverbial form)\s+of\b/i.test(t)) return true
  if (/\bform of\b/i.test(t)) return true
  return false
}

export function extractFormOfLemmaFromHtml(html: string): string | null {
  if (!html || !/form-of-definition/i.test(html)) return null
  const titled = html.match(/form-of-definition-link[\s\S]{0,400}?title="([^"#]+)/i)?.[1]
  const href = html.match(/form-of-definition-link[\s\S]{0,400}?href="\/wiki\/([^"#]+)/i)?.[1]
  return normalizeLemma(titled || href)
}

export function extractFormOfLemmaFromText(text: string): string | null {
  if (!isGrammaticalFormDefinition(text)) return null
  const match = text.match(
    /\bof\s+(?:the\s+(?:verb|noun|adjective|adverb)\s+)?["'“”]?([a-z][a-z'-]{1,40})["'“”]?\s*\.?$/i,
  )
  return normalizeLemma(match?.[1])
}

function normalizeLemma(raw: string | null | undefined): string | null {
  if (!raw) return null
  let value = raw
  try {
    value = decodeURIComponent(value)
  } catch {
    // keep raw
  }
  value = value.replace(/_/g, ' ').split('#')[0]?.trim().toLowerCase() ?? ''
  value = value.replace(/[’']/g, "'")
  if (!/^[a-z][a-z'-]{1,40}$/.test(value)) return null
  return value
}

export function inflectionLemmaCandidates(term: string): string[] {
  const base = term.trim().toLowerCase()
  if (!base) return []
  const out: string[] = []
  const push = (v: string) => {
    const t = v.trim().toLowerCase()
    if (t && t.length >= 2 && t !== base && !out.includes(t)) out.push(t)
  }
  if (base.endsWith("'s")) push(base.slice(0, -2))
  if (base.endsWith('ies') && base.length > 4) push(`${base.slice(0, -3)}y`)
  if (base.endsWith('ves') && base.length > 4) push(`${base.slice(0, -3)}f`)
  if (base.endsWith('ing') && base.length > 5) {
    push(base.slice(0, -3))
    push(`${base.slice(0, -3)}e`)
  }
  if (base.endsWith('ed') && base.length > 4) {
    push(base.slice(0, -2))
    push(base.slice(0, -1))
  }
  if (base.endsWith('es') && base.length > 3) push(base.slice(0, -2))
  if (base.endsWith('s') && !base.endsWith('ss') && base.length > 3) push(base.slice(0, -1))
  return out
}

export function derivedRootCandidates(term: string): string[] {
  const base = term.trim().toLowerCase()
  if (!base) return []
  const out: string[] = []
  const push = (v: string) => {
    const t = v.trim().toLowerCase()
    if (t && t.length >= 3 && t !== base && !out.includes(t)) out.push(t)
  }
  if (base.endsWith('ily') && base.length > 5) push(`${base.slice(0, -3)}y`)
  if (base.endsWith('bly') && base.length > 5) push(`${base.slice(0, -3)}le`)
  if (base.endsWith('ly') && base.length > 5) {
    push(base.slice(0, -2))
    push(`${base.slice(0, -2)}e`)
  }
  if (base.endsWith('iness') && base.length > 7) push(`${base.slice(0, -5)}y`)
  if (base.endsWith('ness') && base.length > 6) push(base.slice(0, -4))
  return out
}

export function preferredPosForTerm(term: string): string | null {
  const base = term.trim().toLowerCase()
  if (base.endsWith('ly') && base.length > 5) return 'adverb'
  if (/(ing|ed)$/.test(base) && base.length > 5) return 'verb'
  if (base.endsWith('ness') && base.length > 6) return 'noun'
  return null
}

export type MorphKind = 'inflection' | 'derivation' | null

export function morphKindForTerm(term: string): MorphKind {
  const base = term.trim().toLowerCase()
  if (base.endsWith('ly') && base.length > 5) return 'derivation'
  if (base.endsWith('ness') && base.length > 6) return 'derivation'
  if (inflectionLemmaCandidates(base).length > 0) return 'inflection'
  return null
}
