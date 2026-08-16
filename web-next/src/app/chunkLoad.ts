/**
 * Handle failed dynamic imports after a deploy.
 *
 * Vite hashes route chunks (UploadRoute-XXXX.js). A tab that kept an old
 * main bundle will request hashes that no longer exist (404) →
 * "Failed to fetch dynamically imported module".
 *
 * Policy: one automatic full reload per session window, then surface a
 * friendly error with a manual reload button.
 */

const RELOAD_KEY = 'reader-tts-chunk-reload-at'
const RELOAD_COOLDOWN_MS = 15_000

export function isChunkLoadError(error: unknown): boolean {
  if (!error) return false
  const msg = error instanceof Error ? error.message : String(error)
  return (
    /Failed to fetch dynamically imported module/i.test(msg)
    || /error loading dynamically imported module/i.test(msg)
    || /Importing a module script failed/i.test(msg)
    || /Loading chunk [\d]+ failed/i.test(msg)
    || /ChunkLoadError/i.test(msg)
  )
}

/**
 * If this looks like a stale-chunk failure and we have not just reloaded,
 * hard-reload once so the browser picks up the new index.html + hashes.
 * Returns true if a reload was triggered (caller should stop).
 */
export function tryReloadForStaleChunk(error: unknown): boolean {
  if (typeof window === 'undefined') return false
  if (!isChunkLoadError(error)) return false

  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) || '0')
    if (Date.now() - last < RELOAD_COOLDOWN_MS) return false
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()))
  } catch {
    // sessionStorage blocked — still try reload once via location
  }

  // Cache-bust the document so intermediate caches cannot serve old HTML.
  const url = new URL(window.location.href)
  url.searchParams.set('_chunk', String(Date.now()))
  window.location.replace(url.toString())
  return true
}

/**
 * Wrap a React Router `lazy` import so deploy chunk misses auto-recover.
 *
 *   lazy: () => lazyRoute(() => import('./X').then(m => ({ Component: m.X })))
 */
export async function lazyRoute<T>(loader: () => Promise<T>): Promise<T> {
  try {
    const mod = await loader()
    // Successful navigation after a deploy — clear cooldown so future deploys
    // can auto-reload again.
    try {
      sessionStorage.removeItem(RELOAD_KEY)
    } catch { /* ignore */ }
    return mod
  } catch (error) {
    if (tryReloadForStaleChunk(error)) {
      // Hold the promise open while the page unloads.
      return new Promise<T>(() => {})
    }
    throw error
  }
}
