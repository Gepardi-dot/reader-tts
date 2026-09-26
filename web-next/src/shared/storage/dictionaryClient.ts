/**
 * Define resolve: settled cache, then one worker lookup.
 * The worker picks a single dictionary voice and follows inflections.
 * The browser does not call Wiktionary or Free Dictionary — those fail under COEP.
 */

import { request } from '@/shared/api/client'
import {
  ensureDictionarySeed,
  getCachedDictionary,
  hasDictionaryDefinitions,
  isQualityDictionaryPayload,
  lookupStaticDictionarySync,
  putCachedDictionary,
  resolveLocalDictionary,
  type DictionaryResponse,
} from './dictionaryCache'
import { DICTIONARY_GLOSS_VERSION, settleGlossPayload } from './dictionaryGloss'
import {
  extractFormOfLemmaFromHtml,
  extractFormOfLemmaFromText,
  inflectionLemmaCandidates,
  isGrammaticalFormDefinition,
  preferredPosForTerm,
} from './dictionaryMorphology'

export const DICTIONARY_STALE_TIME_MS = 30 * 60_000
export const DICTIONARY_GC_TIME_MS = 60 * 60_000

export function normalizeLookupWord(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/^[\s"'“”‘’([{«]+/u, '')
    .replace(/[\s"'“”‘’)}\],.;:!?»]+$/gu, '')
    .replace(/[’']/g, "'")
}

export function dictionaryLookupVariants(term: string): string[] {
  const base = normalizeLookupWord(term)
  if (!base) return []
  const out: string[] = [base]
  const push = (v: string) => {
    const t = normalizeLookupWord(v)
    if (t && t.length >= 2 && !out.includes(t)) out.push(t)
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
  if (base.endsWith('ly') && base.length > 4) push(base.slice(0, -2))
  return out
}

export function dictionaryQueryKey(word: string) {
  return ['dictionary', normalizeLookupWord(word)] as const
}

export function dictionaryQueryOptions(word: string) {
  const term = normalizeLookupWord(word)
  return {
    queryKey: dictionaryQueryKey(term),
    queryFn: () => fetchClientDictionary(term),
    staleTime: DICTIONARY_STALE_TIME_MS,
    gcTime: DICTIONARY_GC_TIME_MS,
    retry: 1,
    retryDelay: 400,
  }
}

interface FreeDef {
  definition?: string
  example?: string
  synonyms?: string[]
}
interface FreeMeaning {
  partOfSpeech?: string
  definitions?: FreeDef[]
  synonyms?: string[]
}
interface FreePhonetic {
  text?: string
  audio?: string
}
interface FreeEntry {
  word?: string
  phonetic?: string
  phonetics?: FreePhonetic[]
  meanings?: FreeMeaning[]
}

function pickPhonetic(entry: FreeEntry): string | null {
  const listed = entry.phonetics ?? []
  const us = listed.find((p) => /us\.mp3|-us\b/i.test(p.audio ?? ''))
  const text =
    entry.phonetic
    || us?.text
    || listed.find((p) => p.text?.trim())?.text
    || null
  return text?.trim() || null
}

export function normalizeDictionaryPayload(raw: unknown, fallbackTerm: string): DictionaryResponse | null {
  if (!raw || typeof raw !== 'object') return null

  const asDict = raw as DictionaryResponse
  if (Array.isArray(asDict.entries)) {
    if (!hasDictionaryDefinitions(asDict)) return null
    return {
      ...asDict,
      term: asDict.term || fallbackTerm,
      available: true,
      message: null,
      pronunciation: asDict.pronunciation ?? null,
      relatedTerms: asDict.relatedTerms ?? [],
      source: asDict.source ?? 'online',
    }
  }

  const rows = Array.isArray(raw) ? raw as FreeEntry[] : [raw as FreeEntry]
  const fe = rows[0]
  if (!fe?.meanings?.length) return null

  const payload: DictionaryResponse = {
    term: fe.word || fallbackTerm,
    available: true,
    message: null,
    pronunciation: pickPhonetic(fe),
    entries: fe.meanings.slice(0, 6).map((m) => ({
      partOfSpeech: m.partOfSpeech,
      definitions: (m.definitions ?? []).slice(0, 5).map((d) => ({
        definition: d.definition ?? '',
        examples: d.example ? [d.example] : [],
        synonyms: [],
      })),
    })),
    relatedTerms: [],
    source: 'online',
  }
  return hasDictionaryDefinitions(payload) ? payload : null
}

export function stripDictionaryHtml(html: string) {
  return html
    .replace(/<span[^>]*usage-label[^>]*>[\s\S]*?<\/span>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim()
}

export function extractWiktionaryPronunciation(wikitext: string): {
  pronunciation: string | null
  hyphenation: string | null
} {
  const englishIdx = wikitext.indexOf('==English==')
  const chunk = (englishIdx >= 0 ? wikitext.slice(englishIdx) : wikitext).slice(0, 4500)
  const ipa = chunk.match(/\{\{IPA\|en\|\/([^}|]+)\/[^}]*\}\}/)?.[1]
    ?? chunk.match(/\{\{IPA\|\/([^}|]+)\/\|lang=en\}\}/)?.[1]
  const hyph = chunk.match(/\{\{hyphenation\|en\|([^}]+)\}\}/)?.[1]
  return {
    pronunciation: ipa ? `/${ipa.replace(/\\/g, '')}/` : null,
    hyphenation: hyph ? hyph.replace(/\|/g, '·') : null,
  }
}

export function normalizeWiktionaryPayload(raw: unknown, term: string): DictionaryResponse | null {
  if (!raw || typeof raw !== 'object') return null
  const english = (raw as Record<string, unknown>).en
  if (!Array.isArray(english) || english.length === 0) return null

  const entries = english.slice(0, 6).map((row) => {
    const item = row as Record<string, unknown>
    const defs = Array.isArray(item.definitions) ? item.definitions as Array<Record<string, unknown>> : []
    return {
      partOfSpeech: String(item.partOfSpeech ?? '').trim(),
      definitions: defs.slice(0, 5).map((def) => {
        const html = String(def.definition ?? '')
        const examplesRaw = Array.isArray(def.examples) ? def.examples : []
        const parsed = Array.isArray(def.parsedExamples)
          ? (def.parsedExamples as Array<Record<string, unknown>>).map((ex) => String(ex.example ?? ''))
          : []
        const examples = [...examplesRaw.map(String), ...parsed]
          .map(stripDictionaryHtml)
          .filter(Boolean)
        const definition = stripDictionaryHtml(html)
        return {
          definition,
          examples: [...new Set(examples)].slice(0, 2),
          synonyms: [] as string[],
          formOf: extractFormOfLemmaFromHtml(html) || extractFormOfLemmaFromText(definition),
        }
      }).filter((def) => def.definition.length >= 8),
    }
  }).filter((entry) => entry.definitions.length > 0)

  if (entries.length === 0) return null
  return {
    term,
    available: true,
    message: null,
    pronunciation: null,
    hyphenation: null,
    entries,
    relatedTerms: [],
    source: 'online',
  }
}

function emptyDictionary(term: string): DictionaryResponse {
  return {
    term,
    available: false,
    message: 'No definition found.',
    pronunciation: null,
    entries: [],
    relatedTerms: [],
    source: null,
  }
}

async function fetchBackendDictionary(term: string): Promise<DictionaryResponse | null> {
  try {
    const raw = await request<DictionaryResponse>(
      `/api/dictionary/lookup?term=${encodeURIComponent(term)}`,
      { signal: AbortSignal.timeout(8000) },
    )
    const normalized = normalizeDictionaryPayload(raw, term)
    if (!normalized) return null
    const settled = settleGlossPayload(normalized)
    if (!isQualityDictionaryPayload(settled) || !hasDictionaryDefinitions(settled)) return null
    return settled
  } catch {
    return null
  }
}

function payloadIsMostlyGrammatical(payload: DictionaryResponse | null | undefined) {
  const defs = payload?.entries?.flatMap((entry) => entry.definitions ?? []) ?? []
  if (defs.length === 0) return false
  const real = defs.filter((def) => !isGrammaticalFormDefinition(def.definition))
  return real.length === 0
}

function isSettledDictionary(payload: DictionaryResponse | null | undefined) {
  return Boolean(
    payload
    && payload.glossVersion === DICTIONARY_GLOSS_VERSION
    && isQualityDictionaryPayload(payload)
    && !payloadIsMostlyGrammatical(payload),
  )
}

function stampQuery(payload: DictionaryResponse, query: string): DictionaryResponse {
  return {
    ...payload,
    queriedTerm: query,
    preferPos: payload.preferPos || preferredPosForTerm(query),
    available: true,
  }
}

function lookupCandidates(term: string) {
  return [term, ...inflectionLemmaCandidates(term)].slice(0, 4)
}

async function readSettledDictionary(primary: string): Promise<DictionaryResponse | null> {
  const cached = await getCachedDictionary(primary)
  if (isSettledDictionary(cached) && cached) return cached
  return null
}

async function readAnyLocalDictionary(primary: string): Promise<DictionaryResponse | null> {
  await ensureDictionarySeed().catch(() => {})
  for (const candidate of lookupCandidates(primary)) {
    const local = await resolveLocalDictionary(candidate)
    if (hasDictionaryDefinitions(local) && local && !payloadIsMostlyGrammatical(local)) return local
  }
  return null
}

/**
 * Settled memory/IDB, then one worker request.
 * Inflection follow-up happens inside that request, not as a second paint.
 */
export async function fetchClientDictionary(word: string): Promise<DictionaryResponse> {
  const primary = normalizeLookupWord(word) || word.trim().toLowerCase()
  if (!primary) return emptyDictionary(word)

  const settled = await readSettledDictionary(primary)
  if (settled) return stampQuery(settled, primary)

  const offline = typeof navigator !== 'undefined' && navigator.onLine === false
  if (offline) {
    const local = await readAnyLocalDictionary(primary)
    return local ? stampQuery(local, primary) : emptyDictionary(primary)
  }

  const network = await fetchBackendDictionary(primary)
  if (network && hasDictionaryDefinitions(network)) {
    const stamped = stampQuery(network, primary)
    void putCachedDictionary(primary, stamped)
    return stamped
  }

  const fallback = await readAnyLocalDictionary(primary)
  return fallback ? stampQuery(fallback, primary) : emptyDictionary(primary)
}

/** Sync placeholder when this session already settled the word. */
export function peekCachedDictionary(word: string): DictionaryResponse | null {
  const hit = lookupStaticDictionarySync(normalizeLookupWord(word))
  return isSettledDictionary(hit) ? hit : null
}
