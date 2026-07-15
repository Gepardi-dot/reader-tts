/**
 * Shared word → definition lookup for vocabulary cards / practice backfill.
 * Local seed/IDB first, then Free Dictionary API.
 */

import {
  ensureDictionarySeed,
  hasDictionaryDefinitions,
  putCachedDictionary,
  resolveLocalDictionary,
  type DictionaryResponse,
} from './dictionaryCache'

export interface WordDefinitionHit {
  term: string
  definition: string
  pronunciation: string | null
  example: string | null
  partOfSpeech: string | null
  source: 'local' | 'online'
}

function firstDefinition(payload: DictionaryResponse | null | undefined): WordDefinitionHit | null {
  if (!payload?.entries?.length) return null
  for (const entry of payload.entries) {
    for (const def of entry.definitions ?? []) {
      const text = def.definition?.trim()
      if (!text || text.length < 8) continue
      // Reject headword-only garbage
      if (text.toLowerCase() === (payload.term ?? '').toLowerCase()) continue
      if (text.split(/\s+/).length < 2) continue
      return {
        term: (payload.term ?? '').trim() || text,
        definition: text,
        pronunciation: payload.pronunciation ?? null,
        example: def.examples?.find((ex) => ex.trim())?.trim() ?? null,
        partOfSpeech: entry.partOfSpeech ?? null,
        source: 'local',
      }
    }
  }
  return null
}

async function fetchFreeDictionary(term: string): Promise<DictionaryResponse | null> {
  try {
    const r = await fetch(
      `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(term)}`,
      { signal: AbortSignal.timeout(5000) },
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
      entries: (fe.meanings ?? []).slice(0, 4).map((m) => ({
        partOfSpeech: m.partOfSpeech,
        definitions: (m.definitions ?? []).slice(0, 3).map((d) => ({
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

/** Resolve a usable multi-word definition for a headword. */
export async function lookupWordDefinition(term: string): Promise<WordDefinitionHit | null> {
  const normalized = term.trim().toLowerCase()
  if (!normalized) return null

  await ensureDictionarySeed().catch(() => {})

  const local = await resolveLocalDictionary(normalized)
  let hit = firstDefinition(local)
  if (hit) return { ...hit, source: 'local' }

  const free = await fetchFreeDictionary(normalized)
  if (hasDictionaryDefinitions(free)) {
    void putCachedDictionary(normalized, free as DictionaryResponse)
  }
  hit = firstDefinition(free)
  if (hit) return { ...hit, source: 'online' }

  return null
}
