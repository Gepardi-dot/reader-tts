/**
 * Shared word → definition lookup for vocabulary cards / practice backfill.
 *
 * Sense selection is ranked for *reading vocabulary*, not raw API order:
 * Free Dictionary often puts rare technical senses first (e.g. grammar
 * "verbal" before the everyday adjective). We score every sense and pick
 * the best fit for a general book-reader, optionally using surrounding
 * book context when available.
 */

import {
  ensureDictionarySeed,
  hasDictionaryDefinitions,
  putCachedDictionary,
  resolveLocalDictionary,
  type DictionaryDefinition,
  type DictionaryEntry,
  type DictionaryResponse,
} from './dictionaryCache'

export interface WordDefinitionHit {
  term: string
  definition: string
  pronunciation: string | null
  example: string | null
  partOfSpeech: string | null
  source: 'local' | 'online'
  /** Ranking score (higher = better). Useful for tests / debug. */
  score?: number
}

export interface LookupDefinitionOptions {
  /** Surrounding book sentence or selection context — biases sense choice. */
  context?: string | null
  /** Prefer this part of speech when scores are close (e.g. from UI). */
  preferPos?: string | null
}

interface RankedSense {
  definition: string
  example: string | null
  partOfSpeech: string | null
  score: number
  index: number
}

/** Domain tags Free Dict / glossaries put on specialized senses. */
const DOMAIN_TAG_RE =
  /^\s*\((grammar|linguistics|phonetics|law|legal|medicine|medical|obsolete|archaic|rare|slang|vulgar|informal|computing|computers?|mathematics|math|chemistry|biology|botany|zoology|anatomy|music|military|nautical|heraldry|philosophy|theology|rhetoric|logic|prosody|mining|heraldry)\)/i

const NICHE_BODY_RE =
  /\b(verb form|does not function as a predicate|participle|gerund|infinitive|predicate|accusative|nominative|dative|genitive|subjunctive|phoneme|morpheme|etymolog|confessions? given to police|fabricating a confession)\b/i

const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'to', 'in', 'for', 'on', 'at', 'by', 'with', 'from',
  'as', 'or', 'and', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'that',
  'this', 'these', 'those', 'it', 'its', 'into', 'than', 'then', 'so', 'if',
  'not', 'no', 'but', 'which', 'who', 'whom', 'what', 'when', 'where', 'how',
  'their', 'his', 'her', 'your', 'our', 'my', 'me', 'we', 'you', 'they', 'them',
  'do', 'does', 'did', 'done', 'have', 'has', 'had', 'will', 'would', 'can',
  'could', 'should', 'may', 'might', 'must', 'about', 'over', 'under', 'out',
  'up', 'down', 'more', 'most', 'other', 'some', 'such', 'only', 'own', 'same',
  'also', 'very', 'just', 'than', 'too', 'rather', 'one', 'two', 'used', 'use',
  'using', 'word', 'words', 'meaning', 'means', 'form', 'forms',
])

function normalizePos(pos: string | null | undefined): string {
  return (pos ?? '').trim().toLowerCase()
}

function contentTokens(text: string): Set<string> {
  const out = new Set<string>()
  for (const raw of text.toLowerCase().match(/[a-z']+/g) ?? []) {
    if (raw.length < 3 || STOPWORDS.has(raw)) continue
    out.add(raw)
  }
  return out
}

function overlapScore(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let n = 0
  for (const t of a) if (b.has(t)) n += 1
  return n
}

/**
 * True when a stored gloss is usable as text but looks like a niche/technical
 * sense that should be re-ranked against common reading senses.
 */
export function isNicheDomainDefinition(def: string | null | undefined): boolean {
  if (!def) return false
  const text = def.trim()
  if (!text) return false
  if (DOMAIN_TAG_RE.test(text)) return true
  if (NICHE_BODY_RE.test(text)) return true
  return false
}

/**
 * True when practice should re-fetch / re-rank the definition.
 * Covers empty placeholders *and* niche technical senses.
 */
export function shouldRefreshDefinition(
  def: string | null | undefined,
  headword?: string | null,
): boolean {
  // Lazy import pattern avoided — caller already has isUsableDefinition usually.
  if (!def || def.trim().length < 8) return true
  const trimmed = def.trim()
  if (headword && trimmed.toLowerCase() === headword.trim().toLowerCase()) return true
  if (isNicheDomainDefinition(trimmed)) return true
  // Fabricated / circular “definitions”
  if (/^saved from (your )?reading/i.test(trimmed)) return true
  if (/^definition unavailable/i.test(trimmed)) return true
  if (/^a word from your reading/i.test(trimmed)) return true
  return false
}

/**
 * Detect fake / non-book “context” lines that used to be generated for every card.
 * These are not unique book passages — they paste the dictionary gloss into a template.
 */
export function isFabricatedContextSentence(
  sentence: string | null | undefined,
  word?: string | null,
  definition?: string | null,
): boolean {
  if (!sentence) return true
  const s = sentence.trim()
  if (!s) return true

  // Historical templates (any position / curly quotes / blanked cloze form)
  if (/in the story,?\s+the idea of/i.test(s)) return true
  if (/as you read,?\s+notice how/i.test(s)) return true
  if (/comes up\s*[—–-]\s*\(/i.test(s)) return true
  if (/comes up\s*[—–-]\s*.{0,40}(grammar|linguistics|obsolete)/i.test(s)) return true

  // Definition dumped into the “quote”
  if (definition && definition.trim().length > 16) {
    const defCore = definition
      .replace(/^\([^)]+\)\s*/, '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ')
    const sNorm = s.toLowerCase().replace(/\s+/g, ' ')
    if (defCore.length > 20 && sNorm.includes(defCore.slice(0, Math.min(40, defCore.length)))) {
      return true
    }
    // High overlap between sentence and definition → not a real book line
    const defTokens = contentTokens(defCore)
    const sentTokens = contentTokens(sNorm)
    const ov = overlapScore(defTokens, sentTokens)
    if (defTokens.size >= 4 && ov >= Math.ceil(defTokens.size * 0.55)) return true
  }

  // Domain-tagged dictionary prose masquerading as a quote
  if (DOMAIN_TAG_RE.test(s) || /\(grammar\)|\(linguistics\)|\(obsolete\)/i.test(s)) return true
  if (NICHE_BODY_RE.test(s) && /verb form|predicate|gerund|participle/i.test(s)) return true

  if (word) {
    const w = word.trim().toLowerCase()
    if (s.toLowerCase() === w) return true
  }
  return false
}

/**
 * True when a sentence is a real-enough passage for cloze (contains the word,
 * not a fabricated template, not pure dictionary dump).
 */
export function isRealBookSentence(
  sentence: string | null | undefined,
  word: string,
  definition?: string | null,
): boolean {
  if (!sentence || isFabricatedContextSentence(sentence, word, definition)) return false
  const s = sentence.trim()
  if (s.length < 12) return false
  const head = word.trim()
  if (!head) return false
  try {
    return new RegExp(`\\b${head.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(s)
  } catch {
    return s.toLowerCase().includes(head.toLowerCase())
  }
}

function posPrior(pos: string | null, hasContext: boolean): number {
  const p = normalizePos(pos)
  // Everyday reading vocabulary: adjectives & verbs are common; technical nouns last.
  if (p === 'adjective' || p === 'adj') return hasContext ? 28 : 32
  if (p === 'adverb' || p === 'adv') return 26
  if (p === 'verb' || p === 'v') return 22
  if (p === 'noun' || p === 'n') return hasContext ? 16 : 12
  if (p === 'interjection') return 4
  if (p === 'pronoun' || p === 'preposition' || p === 'conjunction' || p === 'determiner') return 8
  return 10
}

function lengthScore(text: string): number {
  const n = text.length
  // Ideal learner gloss length
  if (n >= 28 && n <= 140) return 18
  if (n >= 18 && n <= 200) return 10
  if (n < 14) return -12
  if (n > 260) return -28
  if (n > 200) return -12
  return 0
}

function domainPenalty(text: string): number {
  let penalty = 0
  if (DOMAIN_TAG_RE.test(text)) penalty += 90
  if (NICHE_BODY_RE.test(text)) penalty += 70
  // Parenthetical domain tags mid-string
  if (/\((grammar|linguistics|law|medicine|obsolete|archaic|rare)\)/i.test(text)) penalty += 40
  // Very long multi-clause technical prose
  if ((text.match(/,/g) ?? []).length >= 4 && text.length > 160) penalty += 12
  return penalty
}

function scoreSense(input: {
  definition: string
  example: string | null
  partOfSpeech: string | null
  term: string
  contextTokens: Set<string>
  preferPos?: string | null
  index: number
}): number {
  const { definition, example, partOfSpeech, term, contextTokens, preferPos, index } = input
  const hasContext = contextTokens.size > 0
  let score = 100

  score += posPrior(partOfSpeech, hasContext)
  score += lengthScore(definition)
  score -= domainPenalty(definition)

  // Prefer earlier senses only lightly (API order is often wrong for reading).
  score -= Math.min(12, index * 2)

  if (preferPos && normalizePos(partOfSpeech) === normalizePos(preferPos)) {
    score += 14
  }

  // Headword echo only → useless
  if (definition.trim().toLowerCase() === term.toLowerCase()) score -= 100

  // Context match: boost senses whose wording (or example) overlaps the book passage
  if (hasContext) {
    const defTokens = contentTokens(definition)
    const exTokens = example ? contentTokens(example) : new Set<string>()
    const defOverlap = overlapScore(contextTokens, defTokens)
    const exOverlap = overlapScore(contextTokens, exTokens)
    score += Math.min(55, defOverlap * 12)
    score += Math.min(30, exOverlap * 14)

    // If context looks like narrative (not a grammar textbook), extra-penalize grammar senses
    const contextBlob = [...contextTokens].join(' ')
    const narrativeHint = /\b(said|says|story|told|tell|speak|spoke|voice|heard|listen|conversation|talk|words?|oral|written|contract|promise|agreement)\b/i.test(contextBlob)
      || contextTokens.size >= 6
    if (narrativeHint && DOMAIN_TAG_RE.test(definition)) {
      score -= 40
    }
  } else {
    // No context: strongly prefer everyday non-tagged senses
    if (!DOMAIN_TAG_RE.test(definition) && !NICHE_BODY_RE.test(definition)) {
      score += 20
    }
  }

  // Mild preference for definitions that start with plain English ("of or relating", "to …")
  if (/^(of|relating|to |the |a |an |expressed|spoken|written|having|showing|being|concerned)/i.test(definition)) {
    score += 8
  }

  return score
}

/**
 * Rank every sense in a dictionary payload and return the best for reading vocab.
 */
export function pickBestDefinition(
  payload: DictionaryResponse | null | undefined,
  options: LookupDefinitionOptions = {},
): WordDefinitionHit | null {
  if (!payload?.entries?.length) return null

  const term = (payload.term ?? '').trim()
  const contextTokens = contentTokens(options.context ?? '')
  const candidates: RankedSense[] = []
  let index = 0

  for (const entry of payload.entries as DictionaryEntry[]) {
    const pos = entry.partOfSpeech ?? null
    for (const def of entry.definitions ?? [] as DictionaryDefinition[]) {
      const text = def.definition?.trim()
      if (!text || text.length < 8) continue
      if (text.toLowerCase() === term.toLowerCase()) continue
      if (text.split(/\s+/).length < 2) continue

      const example = def.examples?.find((ex) => ex.trim())?.trim() ?? null
      const score = scoreSense({
        definition: text,
        example,
        partOfSpeech: pos,
        term,
        contextTokens,
        preferPos: options.preferPos,
        index,
      })
      candidates.push({
        definition: text,
        example,
        partOfSpeech: pos,
        score,
        index,
      })
      index += 1
    }
  }

  if (candidates.length === 0) return null

  candidates.sort((a, b) => b.score - a.score || a.index - b.index)
  const best = candidates[0]

  // Safety: if the winner is still heavily niche and a non-niche alternative exists, prefer it.
  if (isNicheDomainDefinition(best.definition)) {
    const better = candidates.find((c) => !isNicheDomainDefinition(c.definition))
    if (better && better.score >= best.score - 25) {
      return {
        term: term || better.definition,
        definition: better.definition,
        pronunciation: payload.pronunciation ?? null,
        example: better.example,
        partOfSpeech: better.partOfSpeech,
        source: 'local',
        score: better.score,
      }
    }
  }

  return {
    term: term || best.definition,
    definition: best.definition,
    pronunciation: payload.pronunciation ?? null,
    example: best.example,
    partOfSpeech: best.partOfSpeech,
    source: 'local',
    score: best.score,
  }
}

function lemmaVariants(term: string): string[] {
  const base = term.trim().toLowerCase().replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '')
  if (!base) return []
  const out: string[] = [base]
  const push = (v: string) => {
    const t = v.trim().toLowerCase()
    if (t && t.length >= 2 && !out.includes(t)) out.push(t)
  }
  if (base.endsWith("'s") || base.endsWith('’s')) push(base.slice(0, -2))
  if (base.endsWith('ies') && base.length > 4) push(`${base.slice(0, -3)}y`)
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
  if (base.endsWith('ly') && base.length > 4) push(base.slice(0, -2))
  return out
}

/**
 * Preferred path under COEP require-corp: same-origin Worker proxies Free Dictionary
 * (browser → dictionaryapi.dev often fails without CORP on that CDN).
 */
async function fetchWorkerDictionary(term: string): Promise<DictionaryResponse | null> {
  try {
    const { request } = await import('@/shared/api/client')
    const data = await request<DictionaryResponse>(
      `/api/dictionary/lookup?term=${encodeURIComponent(term)}`,
    )
    if (hasDictionaryDefinitions(data)) return data
    return null
  } catch {
    return null
  }
}

async function fetchFreeDictionary(term: string): Promise<DictionaryResponse | null> {
  try {
    const r = await fetch(
      `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(term)}`,
      { signal: AbortSignal.timeout(5000), mode: 'cors' },
    )
    if (!r.ok) return null
    const j = await r.json() as Array<{
      word?: string
      phonetic?: string
      meanings?: Array<{
        partOfSpeech?: string
        definitions?: Array<{ definition?: string; example?: string }>
        synonyms?: string[]
      }>
    }>
    const fe = j?.[0]
    if (!fe) return null
    return {
      term: fe.word || term,
      available: true,
      message: null,
      pronunciation: fe.phonetic ?? null,
      entries: (fe.meanings ?? []).slice(0, 8).map((m) => ({
        partOfSpeech: m.partOfSpeech,
        definitions: (m.definitions ?? []).slice(0, 6).map((d) => ({
          definition: d.definition ?? '',
          examples: d.example ? [d.example] : [],
          synonyms: (m.synonyms ?? []).slice(0, 6),
        })),
      })),
      relatedTerms: [],
    }
  } catch {
    return null
  }
}

/** Resolve a usable multi-word definition for a headword (ranked for reading). */
export async function lookupWordDefinition(
  term: string,
  options: LookupDefinitionOptions = {},
): Promise<WordDefinitionHit | null> {
  const variants = lemmaVariants(term)
  if (variants.length === 0) return null

  await ensureDictionarySeed().catch(() => {})

  for (const candidate of variants) {
    const local = await resolveLocalDictionary(candidate)
    const hit = pickBestDefinition(local, options)
    if (hit) return { ...hit, term: term.trim() || hit.term, source: 'local' }
  }

  // Worker proxy first (works with COEP / production Cloudflare host).
  for (const candidate of variants) {
    const viaWorker = await fetchWorkerDictionary(candidate)
    if (hasDictionaryDefinitions(viaWorker)) {
      void putCachedDictionary(candidate, viaWorker as DictionaryResponse)
      const hit = pickBestDefinition(viaWorker, options)
      if (hit) return { ...hit, term: term.trim() || hit.term, source: 'online' }
    }
  }

  // Direct Free Dictionary (may fail under COEP in production).
  for (const candidate of variants) {
    const free = await fetchFreeDictionary(candidate)
    if (hasDictionaryDefinitions(free)) {
      void putCachedDictionary(candidate, free as DictionaryResponse)
      const hit = pickBestDefinition(free, options)
      if (hit) return { ...hit, term: term.trim() || hit.term, source: 'online' }
    }
  }

  return null
}

/**
 * Format a definition for study cards: strip leading domain tags when we kept
 * a non-niche sense; keep tags only if they are essential.
 */
export function formatStudyDefinition(definition: string, partOfSpeech?: string | null): string {
  let text = definition.trim()
  // If we somehow still have a grammar tag but the body is the everyday sense, strip the tag.
  if (!isNicheDomainDefinition(text.replace(DOMAIN_TAG_RE, '').trim())) {
    text = text.replace(DOMAIN_TAG_RE, '').trim()
  }
  // Capitalize first letter for card polish
  if (text && /^[a-z]/.test(text)) {
    text = text.charAt(0).toUpperCase() + text.slice(1)
  }
  // Optional light POS prefix for disambiguation when useful
  const pos = normalizePos(partOfSpeech)
  if (pos && !DOMAIN_TAG_RE.test(definition) && text.length < 80) {
    // Don't force POS on every card — only when short gloss might be ambiguous
  }
  return text
}
