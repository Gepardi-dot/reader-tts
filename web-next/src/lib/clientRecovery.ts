/**
 * Client recovery + service worker registration.
 *
 * Permanent policy (must match public/sw.js):
 * - SW may cache cross-origin models/covers only
 * - SW must never control HTML / JS / /api (same-origin)
 * - On protocol upgrade, purge legacy shell caches once and reload
 */

import { clearAuth } from '@/lib/auth'

/** Bump when SW policy changes; triggers one automatic migration reload. */
export const CLIENT_SW_PROTOCOL = 'models-covers-only-v1'

const PROTOCOL_KEY = 'reader-tts-sw-protocol'
const MODEL_CACHE_PREFIXES = ['kokoro-model-', 'book-covers-']

export async function clearServiceWorkerCaches(options?: {
  /** Keep large model/cover caches (default true). */
  keepModels?: boolean
}): Promise<void> {
  if (typeof caches === 'undefined') return
  const keepModels = options?.keepModels !== false
  const keys = await caches.keys()
  await Promise.all(
    keys.map((key) => {
      if (keepModels && MODEL_CACHE_PREFIXES.some((p) => key.startsWith(p))) {
        return Promise.resolve(false)
      }
      return caches.delete(key)
    }),
  )
}

export async function unregisterServiceWorkers(): Promise<void> {
  if (!('serviceWorker' in navigator)) return
  const regs = await navigator.serviceWorker.getRegistrations()
  await Promise.all(regs.map((reg) => reg.unregister()))
}

/**
 * Full repair: auth + non-model caches + unregister SW + hard reload.
 * Used by the login "Fix stuck browser" control.
 */
export async function recoverStuckClient(options?: { reload?: boolean }): Promise<void> {
  const shouldReload = options?.reload !== false
  try {
    clearAuth()
  } catch { /* ignore */ }
  try {
    window.localStorage.removeItem('storybook-qcache-v1')
  } catch { /* ignore */ }
  try {
    // Full cache wipe including models — user asked for a clean slate
    await clearServiceWorkerCaches({ keepModels: false })
  } catch { /* ignore */ }
  try {
    await unregisterServiceWorkers()
  } catch { /* ignore */ }
  try {
    window.localStorage.setItem(PROTOCOL_KEY, CLIENT_SW_PROTOCOL)
  } catch { /* ignore */ }
  if (shouldReload && typeof window !== 'undefined') {
    const url = new URL(window.location.href)
    url.searchParams.set('_recovered', String(Date.now()))
    window.location.replace(url.toString())
  }
}

/**
 * One-time migration when CLIENT_SW_PROTOCOL changes: drop legacy shell
 * caches that used to pin index.html, then reload once.
 */
async function migrateClientProtocolIfNeeded(): Promise<boolean> {
  let previous = ''
  try {
    previous = window.localStorage.getItem(PROTOCOL_KEY) || ''
  } catch {
    previous = ''
  }
  if (previous === CLIENT_SW_PROTOCOL) return false

  try {
    // Always purge non-model caches (storybook-shell-*, providers, etc.)
    await clearServiceWorkerCaches({ keepModels: true })
  } catch { /* ignore */ }

  try {
    window.localStorage.setItem(PROTOCOL_KEY, CLIENT_SW_PROTOCOL)
  } catch { /* ignore */ }

  // First-ever visitor: no previous protocol — still purge shells but skip
  // forced reload (nothing to recover).
  if (!previous) return false

  // Returning client from an older SW policy — force a clean document load.
  return true
}

/**
 * Register SW for model/cover caching only. Updates aggressively; reloads when
 * a new worker takes control so open tabs leave a stale document.
 */
export function registerServiceWorkerWithUpdate(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return

  // Run migration ASAP (not only after load) so shell caches die before
  // the SPA continues using a broken environment.
  void (async () => {
    try {
      const needsReload = await migrateClientProtocolIfNeeded()
      if (needsReload) {
        const url = new URL(window.location.href)
        // Avoid loop if something sets protocol but reload fails halfway
        if (!url.searchParams.has('_sw_migrated')) {
          url.searchParams.set('_sw_migrated', '1')
          window.location.replace(url.toString())
          return
        }
      }
      // Clean migration query flag
      if (window.location.search.includes('_sw_migrated=')) {
        const url = new URL(window.location.href)
        url.searchParams.delete('_sw_migrated')
        url.searchParams.delete('_recovered')
        window.history.replaceState({}, '', url.pathname + url.search + url.hash)
      }
    } catch { /* ignore */ }

    window.addEventListener('load', () => {
      void (async () => {
        try {
          const reg = await navigator.serviceWorker.register('/sw.js', {
            // Default scope: entire origin, but fetch handler ignores same-origin.
            updateViaCache: 'none',
          })
          await reg.update().catch(() => undefined)

          if (reg.waiting) {
            reg.waiting.postMessage({ type: 'SKIP_WAITING' })
            reg.waiting.postMessage({ type: 'PURGE_NON_MODEL_CACHES' })
          }

          reg.addEventListener('updatefound', () => {
            const worker = reg.installing
            if (!worker) return
            worker.addEventListener('statechange', () => {
              if (worker.state === 'installed' && navigator.serviceWorker.controller) {
                worker.postMessage({ type: 'SKIP_WAITING' })
                worker.postMessage({ type: 'PURGE_NON_MODEL_CACHES' })
              }
            })
          })

          let refreshing = false
          navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (refreshing) return
            refreshing = true
            window.location.reload()
          })

          // Periodic update checks (tab left open across deploys)
          window.setInterval(() => {
            reg.update().catch(() => undefined)
          }, 60 * 60 * 1000)
        } catch {
          // SW is optional — auth and reading must work without it
        }
      })()
    })
  })()
}
