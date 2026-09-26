/**
 * Instant dictionary lookups: memory → seed JSON → IndexedDB → (caller network).
 *
 * Define should never wait on a cold network if the term is in the static seed
 * or was looked up before this session.
 */

export interface DictionaryDefinition {
  definition: string
  examples?: string[]
  synonyms?: string[]
  /** Lemma when this gloss is a grammatical form-of line ("inspires" → "inspire"). */
  formOf?: string | null
}

export interface DictionaryEntry {
  partOfSpeech?: string
  definitions?: DictionaryDefinition[]
}

export interface DictionaryResponse {
  term: string
  available: boolean
  message?: string | null
  pronunciation?: string | null
  entries?: DictionaryEntry[]
  relatedTerms?: string[]
  /** `online` / `gemini` beat the WordNet seed for learner-quality glosses. */
  source?: 'seed' | 'online' | 'gemini' | 'local' | null
  /** Syllable form like `jeal·ous·y` when the source provides hyphenation. */
  hyphenation?: string | null
  /** Word the reader actually selected, when the payload was resolved to a lemma. */
  queriedTerm?: string | null
  /** POS to prefer when ranking (e.g. verb for -ing forms). */
  preferPos?: string | null
  /** Root word for derived forms (brilliantly → brilliant). */
  origin?: DictionaryOrigin | null
  /** 2 = one-source settled gloss. Older cached payloads are fetched again. */
  glossVersion?: number
}

export interface DictionaryOrigin {
  term: string
  pronunciation?: string | null
  partOfSpeech?: string | null
  definition: string
  example?: string | null
}

interface DictionarySeed {
  version: number
  terms: Record<string, DictionaryResponse>
}

interface StoredDictionaryEntry {
  id: string
  userId: string
  term: string
  payload: DictionaryResponse
  createdAt: number
  lastAccessedAt: number
}

const DB_NAME = 'storybook-reader-dictionary-cache'
const DB_VERSION = 1
const STORE_NAME = 'entries'
const USER_INDEX = 'userId'
const MEMORY_CAP = 256
/** Shared IDB namespace so lookups work even before auth hydrates. */
const LOCAL_USER_ID = 'local'

let dbPromise: Promise<IDBDatabase> | null = null
let seedPromise: Promise<Map<string, DictionaryResponse> | null> | null = null
let seedMap: Map<string, DictionaryResponse> | null = null
let activeUserId: string | null = LOCAL_USER_ID
const memory = new Map<string, DictionaryResponse>()

function normalizeTerm(term: string) {
  return term.trim().toLowerCase()
}

export function hasDictionaryDefinitions(payload: DictionaryResponse | null | undefined) {
  return Boolean(payload?.entries?.some((entry) => (entry.definitions?.length ?? 0) > 0))
}

function longestDefinitionLength(payload: DictionaryResponse) {
  let max = 0
  for (const entry of payload.entries ?? []) {
    for (const def of entry.definitions ?? []) {
      const n = def.definition?.trim().length ?? 0
      if (n > max) max = n
    }
  }
  return max
}

/** True when the payload looks like a real dictionary, not a WordNet stub. */
export function isQualityDictionaryPayload(payload: DictionaryResponse | null | undefined) {
  if (!payload || !hasDictionaryDefinitions(payload)) return false
  const longest = longestDefinitionLength(payload)
  if (payload.source === 'online' || payload.source === 'gemini') return longest >= 12
  if (longest < 20) return false
  const phon = payload.pronunciation ?? ''
  return phon.includes('/') || phon.includes('[') || /[ˈˌəɪæʌθʃʒŋ]/.test(phon)
}

function idbAvailable() {
  return typeof indexedDB !== 'undefined'
}

function entryId(userId: string, term: string) {
  return `${userId}:${normalizeTerm(term)}`
}

function openDb() {
  if (!idbAvailable()) return Promise.reject(new Error('IndexedDB is unavailable.'))
  if (dbPromise) return dbPromise

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onerror = () => reject(req.error ?? new Error('Failed to open dictionary cache.'))
    req.onsuccess = () => resolve(req.result)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' })
        store.createIndex(USER_INDEX, USER_INDEX, { unique: false })
      }
    }
  })

  return dbPromise
}

function withStore<T>(
  mode: IDBTransactionMode,
  callback: (store: IDBObjectStore) => IDBRequest<T> | void,
) {
  return openDb().then((db) => new Promise<T | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode)
    const store = tx.objectStore(STORE_NAME)
    const req = callback(store)
    tx.oncomplete = () => resolve(req ? req.result : undefined)
    tx.onerror = () => reject(tx.error ?? new Error('Dictionary cache transaction failed.'))
    tx.onabort = () => reject(tx.error ?? new Error('Dictionary cache transaction aborted.'))
  }))
}

function remember(term: string, payload: DictionaryResponse) {
  const key = normalizeTerm(term)
  if (memory.has(key)) memory.delete(key)
  memory.set(key, payload)
  while (memory.size > MEMORY_CAP) {
    const oldest = memory.keys().next().value
    if (oldest == null) break
    memory.delete(oldest)
  }
}

/**
 * Start loading the static seed into memory ASAP (call from app boot).
 * Subsequent lookups of seeded terms are sync O(1).
 */
export function ensureDictionarySeed(): Promise<Map<string, DictionaryResponse> | null> {
  if (seedMap) return Promise.resolve(seedMap)
  if (seedPromise) return seedPromise

  seedPromise = fetch('/dictionary-seed.json')
    .then((response) => (response.ok ? response.json() as Promise<DictionarySeed> : null))
    .then((seed) => {
      if (!seed?.terms) {
        seedMap = new Map()
        return seedMap
      }
      seedMap = new Map(
        Object.entries(seed.terms).map(([k, v]) => [normalizeTerm(k), v]),
      )
      // Promote seed into memory, but never clobber a better cached lookup.
      for (const [k, v] of seedMap) {
        if (!hasDictionaryDefinitions(v)) continue
        const existing = memory.get(k)
        if (existing && isQualityDictionaryPayload(existing)) continue
        remember(k, v)
      }
      return seedMap
    })
    .catch(() => {
      seedMap = new Map()
      return seedMap
    })

  return seedPromise
}

/** Sync hit after seed has loaded; null if seed still loading or term missing. */
export function lookupStaticDictionarySync(term: string): DictionaryResponse | null {
  const key = normalizeTerm(term)
  const mem = memory.get(key)
  if (mem) return mem
  return seedMap?.get(key) ?? null
}

export async function lookupStaticDictionary(term: string) {
  const key = normalizeTerm(term)
  const mem = memory.get(key)
  if (mem) return mem
  const map = await ensureDictionarySeed()
  const hit = map?.get(key) ?? null
  if (hit && hasDictionaryDefinitions(hit)) remember(key, hit)
  return hit
}

export async function getCachedDictionary(term: string) {
  const key = normalizeTerm(term)
  const mem = memory.get(key)
  if (mem && isQualityDictionaryPayload(mem)) return mem

  if (!idbAvailable()) return mem ?? null
  const userId = activeUserId ?? LOCAL_USER_ID

  try {
    const id = entryId(userId, key)
    const record = await withStore<StoredDictionaryEntry>('readwrite', (store) => store.get(id))
    if (!record?.payload) {
      // Also try legacy per-user rows if user id changed.
      if (userId !== LOCAL_USER_ID) {
        const local = await withStore<StoredDictionaryEntry>('readonly', (store) =>
          store.get(entryId(LOCAL_USER_ID, key)),
        )
        if (local?.payload) {
          remember(key, local.payload)
          return local.payload
        }
      }
      return mem ?? null
    }

    remember(key, record.payload)
    return record.payload
  } catch {
    return mem ?? null
  }
}

export async function putCachedDictionary(term: string, payload: DictionaryResponse) {
  if (!isQualityDictionaryPayload(payload)) return
  const normalized = normalizeTerm(term)
  remember(normalized, payload)

  if (!idbAvailable()) return
  const userId = activeUserId ?? LOCAL_USER_ID
  const now = Date.now()
  const record: StoredDictionaryEntry = {
    id: entryId(userId, normalized),
    userId,
    term: normalized,
    payload,
    createdAt: now,
    lastAccessedAt: now,
  }
  try {
    await withStore('readwrite', (store) => {
      store.put(record)
    })
  } catch {
    // non-fatal
  }
}

/**
 * Resolve a term from local sources only (no network).
 * Order: memory → seed → IndexedDB.
 */
export async function resolveLocalDictionary(term: string): Promise<DictionaryResponse | null> {
  const key = normalizeTerm(term)
  if (!key) return null

  const cached = await getCachedDictionary(key)
  if (hasDictionaryDefinitions(cached) && isQualityDictionaryPayload(cached)) return cached

  const seeded = await lookupStaticDictionary(key)
  if (hasDictionaryDefinitions(seeded) && isQualityDictionaryPayload(seeded)) return seeded

  if (hasDictionaryDefinitions(cached)) return cached
  if (hasDictionaryDefinitions(seeded)) return seeded
  return cached ?? seeded ?? null
}

export async function clearDictionaryCacheForUser(userId: string) {
  if (!userId || !idbAvailable()) return
  try {
    const result = await withStore<StoredDictionaryEntry[]>('readonly', (store) =>
      store.index(USER_INDEX).getAll(userId),
    )
    const entries = result ?? []
    await withStore('readwrite', (store) => {
      for (const entry of entries) store.delete(entry.id)
    })
  } catch {
    // ignore
  }
}

export async function setDictionaryCacheUserId(userId: string | null) {
  // Keep LOCAL_USER_ID as fallback so Define works before/without auth.
  activeUserId = userId?.trim() || LOCAL_USER_ID
}

/** Prefetch a term into memory/IDB for instant Define open. */
export async function warmDictionaryTerm(term: string) {
  const key = normalizeTerm(term)
  if (!key || key.includes(' ')) return null
  await ensureDictionarySeed()
  return resolveLocalDictionary(key)
}
