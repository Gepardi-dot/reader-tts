export interface CachedAudioEntry {
  cacheKey: string
  cacheVersion: number
  blob: Blob
  cues: unknown[]
  duration: number | null
  contentType: string
  createdAt: number
  lastAccessedAt: number
  byteLength: number
}

interface StoredAudioEntry extends CachedAudioEntry {
  id: string
  userId: string
}

const DB_NAME = 'storybook-reader-audio-cache'
const DB_VERSION = 1
const STORE_NAME = 'audio'
const USER_INDEX = 'userId'
const SOFT_CAP_BYTES = 200 * 1024 * 1024

let dbPromise: Promise<IDBDatabase> | null = null
let activeUserId: string | null = null
let persistRequested = false

function idbAvailable() {
  return typeof indexedDB !== 'undefined'
}

function entryId(userId: string, cacheKey: string) {
  return `${userId}:${cacheKey}`
}

function openDb() {
  if (!idbAvailable()) return Promise.reject(new Error('IndexedDB is unavailable.'))
  if (dbPromise) return dbPromise

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onerror = () => reject(req.error ?? new Error('Failed to open audio cache.'))
    req.onsuccess = () => resolve(req.result)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' })
        store.createIndex(USER_INDEX, USER_INDEX, { unique: false })
        store.createIndex('lastAccessedAt', 'lastAccessedAt', { unique: false })
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
    tx.onerror = () => reject(tx.error ?? new Error('Audio cache transaction failed.'))
    tx.onabort = () => reject(tx.error ?? new Error('Audio cache transaction aborted.'))
  }))
}

async function requestPersistentStorage() {
  if (persistRequested) return
  persistRequested = true
  try {
    await navigator.storage?.persist?.()
  } catch {
    // Best effort only.
  }
}

async function recordsForUser(userId: string) {
  const result = await withStore<StoredAudioEntry[]>('readonly', (store) =>
    store.index(USER_INDEX).getAll(userId),
  )
  return result ?? []
}

async function enforceSoftCap(userId: string) {
  let entries = await recordsForUser(userId)
  let total = entries.reduce((sum, entry) => sum + (entry.byteLength || entry.blob.size || 0), 0)

  try {
    const estimate = await navigator.storage?.estimate?.()
    const quota = estimate?.quota ?? 0
    const usage = estimate?.usage ?? 0
    if (quota && usage / quota > 0.85) {
      total = Math.max(total, SOFT_CAP_BYTES + 1)
    }
  } catch {
    // Quota estimates are advisory; keep the local byte cap as the source of truth.
  }

  if (total <= SOFT_CAP_BYTES) return

  entries = entries.sort((a, b) => a.lastAccessedAt - b.lastAccessedAt)
  await withStore('readwrite', (store) => {
    for (const entry of entries) {
      if (total <= SOFT_CAP_BYTES) break
      total -= entry.byteLength || entry.blob.size || 0
      store.delete(entry.id)
    }
  })
}

export function getAudioCacheUserId() {
  return activeUserId
}

export async function setAudioCacheUserId(userId: string | null) {
  const previous = activeUserId
  activeUserId = userId
  if (previous && previous !== userId) {
    await clearAudioCacheForUser(previous)
  }
}

export async function getCachedAudio(cacheKey: string, cacheVersion: number) {
  const userId = activeUserId
  if (!userId || !idbAvailable()) return null

  const id = entryId(userId, cacheKey)
  const record = await withStore<StoredAudioEntry>('readwrite', (store) => store.get(id))
  if (!record) return null
  if (record.cacheVersion !== cacheVersion) {
    await withStore('readwrite', (store) => { store.delete(id) })
    return null
  }

  record.lastAccessedAt = Date.now()
  await withStore('readwrite', (store) => { store.put(record) })
  return record
}

export async function putCachedAudio(entry: {
  cacheKey: string
  cacheVersion: number
  blob: Blob
  cues: unknown[]
  duration: number | null
  contentType: string
  byteLength?: number | null
}) {
  const userId = activeUserId
  if (!userId || !idbAvailable()) return

  await requestPersistentStorage()
  const now = Date.now()
  const blob = entry.contentType && entry.blob.type !== entry.contentType
    ? entry.blob.slice(0, entry.blob.size, entry.contentType)
    : entry.blob

  const record: StoredAudioEntry = {
    id: entryId(userId, entry.cacheKey),
    userId,
    cacheKey: entry.cacheKey,
    cacheVersion: entry.cacheVersion,
    blob,
    cues: entry.cues,
    duration: entry.duration,
    contentType: entry.contentType,
    createdAt: now,
    lastAccessedAt: now,
    byteLength: entry.byteLength ?? blob.size,
  }

  await withStore('readwrite', (store) => { store.put(record) })
  await enforceSoftCap(userId)
}

export async function clearAudioCacheForUser(userId: string) {
  if (!userId || !idbAvailable()) return
  const entries = await recordsForUser(userId)
  await withStore('readwrite', (store) => {
    for (const entry of entries) store.delete(entry.id)
  })
}

export async function clearAllAudioCache() {
  if (!idbAvailable()) return
  await withStore('readwrite', (store) => { store.clear() })
}
