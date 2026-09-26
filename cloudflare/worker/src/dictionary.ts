/**
 * Define lookup. An ordinary sense wins. An inflection is defined from its base word,
 * so "comes" is the verb "come" and not the rare fugue noun.
 */

import {
  authoritativeReading,
  isSpecialistGloss,
  isUsableGloss,
  polishGloss,
  preferredGlossPos,
  settleGlossPayload,
  type GlossPayload,
} from '../../../web-next/src/shared/storage/dictionaryGloss'
import {
  extractFormOfLemmaFromHtml,
  extractFormOfLemmaFromText,
} from '../../../web-next/src/shared/storage/dictionaryMorphology'

const WIKTIONARY_UA = 'HiggsRead/1.0 (https://higgsread.com; dictionary lookup)'
const FREE_TIMEOUT_MS = 1600
const WIKI_TIMEOUT_MS = 2000
const GEMINI_TIMEOUT_MS = 2200

export function normalizeDictionaryTerm(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '')
    .replace(/[’']/g, "'")
}

function textOf(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function miss(term: string): GlossPayload {
  return {
    term: term || '',
    available: false,
    message: 'No definition found.',
    pronunciation: null,
    hyphenation: null,
    entries: [],
    relatedTerms: [],
    source: 'none',
  }
}

function stripHtml(html: string) {
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

export function payloadFromFreeDictionary(raw: unknown, term: string): GlossPayload | null {
  const rows = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? [raw] : [])
  const first = rows[0] as Record<string, unknown> | undefined
  if (!first) return null
  const meanings = Array.isArray(first.meanings) ? first.meanings as Array<Record<string, unknown>> : []
  const phonetics = Array.isArray(first.phonetics) ? first.phonetics as Array<Record<string, unknown>> : []
  const usPhonetic = phonetics.find((row) => /-us\./i.test(textOf(row.audio)))
  const pronunciation = textOf(first.phonetic)
    || textOf(usPhonetic?.text)
    || phonetics.map((row) => textOf(row.text)).find(Boolean)
    || null
  const entries = meanings.slice(0, 4).map((meaning) => {
    const defs = Array.isArray(meaning.definitions) ? meaning.definitions as Array<Record<string, unknown>> : []
    return {
      partOfSpeech: textOf(meaning.partOfSpeech),
      definitions: defs.slice(0, 4).map((def) => ({
        definition: textOf(def.definition),
        examples: textOf(def.example) ? [textOf(def.example)] : [],
        synonyms: [] as string[],
        formOf: null,
      })).filter((def) => def.definition),
    }
  }).filter((entry) => entry.definitions.length > 0)
  if (entries.length === 0) return null
  return {
    term: textOf(first.word) || term,
    available: true,
    message: null,
    pronunciation,
    hyphenation: null,
    entries,
    relatedTerms: [],
    source: 'online',
  }
}

export function payloadFromWiktionary(raw: unknown, term: string): GlossPayload | null {
  if (!raw || typeof raw !== 'object') return null
  const english = (raw as Record<string, unknown>).en
  if (!Array.isArray(english) || english.length === 0) return null
  const entries = english.slice(0, 4).map((row) => {
    const item = row as Record<string, unknown>
    const defs = Array.isArray(item.definitions) ? item.definitions as Array<Record<string, unknown>> : []
    return {
      partOfSpeech: textOf(item.partOfSpeech),
      definitions: defs.slice(0, 4).map((def) => {
        const html = textOf(def.definition)
        const examplesRaw = Array.isArray(def.examples) ? def.examples.map(String) : []
        const parsed = Array.isArray(def.parsedExamples)
          ? (def.parsedExamples as Array<Record<string, unknown>>).map((ex) => textOf(ex.example))
          : []
        const definition = stripHtml(html)
        const formOf = extractFormOfLemmaFromHtml(html) || extractFormOfLemmaFromText(definition)
        return {
          definition,
          examples: [...new Set([...examplesRaw, ...parsed].map(stripHtml).filter(Boolean))].slice(0, 2),
          synonyms: [] as string[],
          formOf,
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

async function fetchJson(url: string, timeoutMs: number, headers?: HeadersInit) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers })
    if (!response.ok) return null
    return await response.json().catch(() => null)
  } catch {
    return null
  }
}

function mergePayloads(free: GlossPayload | null, wiki: GlossPayload | null, term: string): GlossPayload | null {
  if (!free && !wiki) return null
  return {
    term: free?.term || wiki?.term || term,
    available: true,
    message: null,
    pronunciation: free?.pronunciation || wiki?.pronunciation || null,
    hyphenation: free?.hyphenation || wiki?.hyphenation || null,
    entries: [...(free?.entries ?? []), ...(wiki?.entries ?? [])],
    relatedTerms: [],
    source: 'online',
  }
}

async function fetchDictionaryPair(term: string): Promise<GlossPayload | null> {
  const freePromise = fetchJson(
    `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(term)}`,
    FREE_TIMEOUT_MS,
  ).then((raw) => payloadFromFreeDictionary(raw, term))
  const wikiPromise = fetchJson(
    `https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(term)}`,
    WIKI_TIMEOUT_MS,
    {
      Accept: 'application/json',
      'User-Agent': WIKTIONARY_UA,
      'Api-User-Agent': WIKTIONARY_UA,
    },
  ).then((raw) => payloadFromWiktionary(raw, term))
  const [free, wiki] = await Promise.all([freePromise, wikiPromise])
  return mergePayloads(free, wiki, term)
}

function payloadFromReading(
  surface: string,
  source: GlossPayload,
  reading: { partOfSpeech: string; definition: string; examples: string[] },
): GlossPayload {
  return settleGlossPayload({
    term: source.term || surface,
    available: true,
    message: null,
    pronunciation: source.pronunciation ?? null,
    hyphenation: source.hyphenation ?? null,
    entries: [{
      partOfSpeech: reading.partOfSpeech,
      definitions: [{
        definition: reading.definition,
        examples: reading.examples.slice(0, 1),
        synonyms: [],
        formOf: null,
      }],
    }],
    relatedTerms: [],
    source: 'online',
    queriedTerm: surface,
    preferPos: reading.partOfSpeech,
  })
}

function payloadFromGeminiText(text: string, term: string): GlossPayload | null {
  const pos = text.match(/^POS:\s*(.+)$/im)?.[1]?.trim() || ''
  const def = text.match(/^DEF:\s*(.+)$/im)?.[1]?.trim() || ''
  const example = text.match(/^EX:\s*(.+)$/im)?.[1]?.trim() || ''
  const polished = polishGloss(def)
  if (!def || /^none$/i.test(def) || !isUsableGloss(polished) || isSpecialistGloss(polished)) return null
  return settleGlossPayload({
    term,
    available: true,
    message: null,
    pronunciation: null,
    hyphenation: null,
    entries: [{
      partOfSpeech: pos && !/^none$/i.test(pos) ? pos : 'word',
      definitions: [{
        definition: polished,
        examples: example && !/^none$/i.test(example) ? [example] : [],
        synonyms: [],
        formOf: null,
      }],
    }],
    relatedTerms: [],
    source: 'gemini',
    queriedTerm: term,
    preferPos: preferredGlossPos(term),
  })
}

async function withTimeout<T>(work: Promise<T | null>, timeoutMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function meaningOfLemma(surface: string, lemma: string, partOfSpeech: string): Promise<GlossPayload | null> {
  if (!lemma || lemma === surface) return null
  const payload = await fetchDictionaryPair(lemma)
  const reading = authoritativeReading(payload, partOfSpeech)
  if (!payload || reading?.kind !== 'sense') return null
  return payloadFromReading(surface, payload, reading)
}

export async function resolveDictionary(
  rawTerm: string,
  options: {
    generate?: (system: string, prompt: string) => Promise<string | null>
  } = {},
): Promise<GlossPayload> {
  const term = normalizeDictionaryTerm(rawTerm)
  if (!term) return miss(rawTerm)

  const surface = await fetchDictionaryPair(term)
  const reading = authoritativeReading(surface)
  if (surface && reading?.kind === 'sense' && reading.everyday) {
    return payloadFromReading(term, surface, reading)
  }
  if (reading?.kind === 'inflection') {
    const followed = await meaningOfLemma(term, reading.lemma, reading.partOfSpeech)
    if (followed?.available) return followed
  }
  if (surface && reading?.kind === 'sense') {
    return payloadFromReading(term, surface, reading)
  }

  if (options.generate) {
    const system = [
      'You write the ordinary English meaning a reader needs.',
      'Do not answer with a rare technical, musical, legal, or archaic sense when a common meaning exists.',
      'Reply with exactly these lines and nothing else:',
      'POS: noun or verb or adjective or adverb',
      'DEF: one clear meaning, 8 to 22 words',
      'EX: one short example sentence that uses the word',
    ].join('\n')
    const text = await withTimeout(
      options.generate(system, `Define the English word: ${term}`),
      GEMINI_TIMEOUT_MS,
    ).catch(() => null)
    if (text) {
      const gemini = payloadFromGeminiText(text, term)
      if (gemini?.available) return gemini
    }
  }

  return miss(term)
}
