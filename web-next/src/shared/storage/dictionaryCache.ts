export interface DictionaryDefinition {
  definition: string
  examples?: string[]
  synonyms?: string[]
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

let dbPromise: Promise<IDBDatabase> | null = null
let seedPromise: Promise<DictionarySeed | null> | null = null
let activeUserId: string | null = null

function normalizeTerm(term: string) {
  return term.trim().toLowerCase()
}

function hasDefinitions(payload: DictionaryResponse | null) {
  return Boolean(payload?.entries?.some((entry) => (entry.definitions?.length ?? 0) > 0))
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

async function loadSeed() {
  if (seedPromise) return seedPromise
  seedPromise = fetch('/dictionary-seed.json')
    .then((response) => response.ok ? response.json() as Promise<DictionarySeed> : null)
    .catch(() => null)
  return seedPromise
}

async function recordsForUser(userId: string) {
  const result = await withStore<StoredDictionaryEntry[]>('readonly', (store) =>
    store.index(USER_INDEX).getAll(userId),
  )
  return result ?? []
}

export async function lookupStaticDictionary(term: string) {
  const seed = await loadSeed()
  return seed?.terms[normalizeTerm(term)] ?? null
}

export async function getCachedDictionary(term: string) {
  const userId = activeUserId
  if (!userId || !idbAvailable()) return null

  const id = entryId(userId, term)
  const record = await withStore<StoredDictionaryEntry>('readwrite', (store) => store.get(id))
  if (!record) return null

  record.lastAccessedAt = Date.now()
  await withStore('readwrite', (store) => { store.put(record) })
  return record.payload
}

export async function putCachedDictionary(term: string, payload: DictionaryResponse) {
  const userId = activeUserId
  if (!userId || !idbAvailable() || !hasDefinitions(payload)) return

  const normalized = normalizeTerm(term)
  const now = Date.now()
  const record: StoredDictionaryEntry = {
    id: entryId(userId, normalized),
    userId,
    term: normalized,
    payload,
    createdAt: now,
    lastAccessedAt: now,
  }
  await withStore('readwrite', (store) => { store.put(record) })
}

export async function clearDictionaryCacheForUser(userId: string) {
  if (!userId || !idbAvailable()) return
  const entries = await recordsForUser(userId)
  await withStore('readwrite', (store) => {
    for (const entry of entries) store.delete(entry.id)
  })
}

export async function setDictionaryCacheUserId(userId: string | null) {
  const previous = activeUserId
  activeUserId = userId
  if (previous && previous !== userId) {
    await clearDictionaryCacheForUser(previous)
  }
}
