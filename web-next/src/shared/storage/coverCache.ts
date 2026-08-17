const DB_NAME = 'higgsread-book-covers'
const DB_VERSION = 1
const STORE_NAME = 'covers'

interface CoverRecord {
  bookId: string
  blob?: Blob
  empty?: boolean
  updatedAt: number
}

let dbPromise: Promise<IDBDatabase> | null = null

function idbAvailable() {
  return typeof indexedDB !== 'undefined'
}

function openDb() {
  if (!idbAvailable()) return Promise.reject(new Error('IndexedDB is unavailable.'))
  if (dbPromise) return dbPromise

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onerror = () => reject(req.error ?? new Error('Failed to open cover cache.'))
    req.onsuccess = () => resolve(req.result)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'bookId' })
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
    tx.onerror = () => reject(tx.error ?? new Error('Cover cache transaction failed.'))
    tx.onabort = () => reject(tx.error ?? new Error('Cover cache transaction aborted.'))
  }))
}

export async function getStoredCover(bookId: string): Promise<CoverRecord | null> {
  if (!idbAvailable()) return null
  try {
    const row = await withStore<CoverRecord>('readonly', (store) => store.get(bookId))
    return row ?? null
  } catch {
    return null
  }
}

export async function putStoredCover(bookId: string, blob: Blob): Promise<void> {
  if (!idbAvailable()) return
  try {
    await withStore('readwrite', (store) => store.put({
      bookId,
      blob,
      empty: false,
      updatedAt: Date.now(),
    } satisfies CoverRecord))
  } catch {
    // Cover cache is cosmetic.
  }
}

export async function putEmptyCover(bookId: string): Promise<void> {
  if (!idbAvailable()) return
  try {
    await withStore('readwrite', (store) => store.put({
      bookId,
      empty: true,
      updatedAt: Date.now(),
    } satisfies CoverRecord))
  } catch {
    // Cover cache is cosmetic.
  }
}

export async function deleteStoredCover(bookId: string): Promise<void> {
  if (!idbAvailable()) return
  try {
    await withStore('readwrite', (store) => store.delete(bookId))
  } catch {
    // Cover cache is cosmetic.
  }
}
