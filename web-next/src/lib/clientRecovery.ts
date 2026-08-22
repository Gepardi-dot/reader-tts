/**
 * Client recovery + service worker registration.
 *
 * Permanent policy (must match public/sw.js):
 * - SW may cache cross-origin models/covers only
 * - SW must never control HTML / JS / /api (same-origin)
 * - On protocol upgrade, purge legacy shell caches once and reload
 */

import { clearAuth } from '@/lib/auth'
import { setSwUpdateAvailable, shouldDeferSwReload } from '@/lib/pwa'

/** Bump when SW policy changes; triggers one automatic migration reload. */
export const CLIENT_SW_PROTOCOL = 'models-covers-only-v1'

const PROTOCOL_KEY = 'reader-tts-sw-protocol'
const MODEL_CACHE_PREFIXES = ['kokoro-model-', 'book-covers-']
const UPDATE_INTERVAL_MS = 60 * 60 * 1000

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
 * Full repair: auth + caches + unregister SW + hard reload.
 * Used by the login "Fix stuck browser" control.
 */
export async function recoverStuckClient(options?: { reload?: boolean }): Promise<void> {
  const shouldReload = options?.reload !== false
  try {
    clearAuth({ keepLastEmail: true })
  } catch {
    /* ignore */
  }
  try {
    window.localStorage.removeItem('storybook-qcache-v1')
  } catch {
    /* ignore */
  }
  try {
    // Full cache wipe including models — intentional clean slate
    await clearServiceWorkerCaches({ keepModels: false })
  } catch {
    /* ignore */
  }
  try {
    await unregisterServiceWorkers()
  } catch {
    /* ignore */
  }
  try {
    window.localStorage.setItem(PROTOCOL_KEY, CLIENT_SW_PROTOCOL)
  } catch {
    /* ignore */
  }
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
    await clearServiceWorkerCaches({ keepModels: true })
  } catch {
    /* ignore */
  }

  try {
    window.localStorage.setItem(PROTOCOL_KEY, CLIENT_SW_PROTOCOL)
  } catch {
    /* ignore */
  }

  // First-ever visitor: purge shells but skip forced reload.
  if (!previous) return false
  return true
}

function stripMigrationParams() {
  if (
    !window.location.search.includes('_sw_migrated=') &&
    !window.location.search.includes('_recovered=')
  ) {
    return
  }
  const url = new URL(window.location.href)
  url.searchParams.delete('_sw_migrated')
  url.searchParams.delete('_recovered')
  window.history.replaceState({}, '', url.pathname + url.search + url.hash)
}

/**
 * Run `task` after `load`, or immediately if `load` already fired.
 *
 * Callers that `await` first must use this — `addEventListener('load')` after
 * an await never runs when the page is already complete, which left the sidecar
 * SW unregistered on first visits and blocked Chromium's install prompt.
 */
export function runWhenWindowLoaded(
  task: () => void,
  doc: { readyState: DocumentReadyState } = document,
  onLoad: (fn: () => void) => void = (fn) => window.addEventListener('load', fn, { once: true }),
): void {
  if (doc.readyState === 'complete') {
    task()
    return
  }
  onLoad(task)
}

/**
 * Register SW for model/cover caching only. Updates aggressively; reloads only
 * when an *existing* controlling worker is replaced (not on first install).
 *
 * Registered in production *and* local preview. The sidecar worker never
 * intercepts HTML/JS/CSS, so Vite HMR still reaches the page. Chromium on
 * Windows/macOS will not fire `beforeinstallprompt` without an active worker.
 */
export function registerServiceWorkerWithUpdate(): void {
  if (import.meta.env.MODE === 'test' || !('serviceWorker' in navigator)) return

  void (async () => {
    try {
      const needsReload = await migrateClientProtocolIfNeeded()
      if (needsReload) {
        const url = new URL(window.location.href)
        if (!url.searchParams.has('_sw_migrated')) {
          url.searchParams.set('_sw_migrated', '1')
          window.location.replace(url.toString())
          return
        }
      }
      stripMigrationParams()
    } catch {
      /* ignore */
    }

    runWhenWindowLoaded(() => {
      void (async () => {
        try {
          // Only reload when replacing an already-active controller (update path).
          // First install must not flash-reload the page.
          const hadController = Boolean(navigator.serviceWorker.controller)

          const reg = await navigator.serviceWorker.register('/sw.js', {
            scope: '/',
            updateViaCache: 'none',
          })
          await reg.update().catch(() => undefined)

          const activateWaiting = (worker: ServiceWorker | null | undefined) => {
            if (!worker) return
            worker.postMessage({ type: 'SKIP_WAITING' })
            worker.postMessage({ type: 'PURGE_NON_MODEL_CACHES' })
          }

          activateWaiting(reg.waiting)

          reg.addEventListener('updatefound', () => {
            const worker = reg.installing
            if (!worker) return
            worker.addEventListener('statechange', () => {
              if (worker.state === 'installed' && navigator.serviceWorker.controller) {
                activateWaiting(worker)
              }
            })
          })

          if (hadController) {
            let refreshing = false
            navigator.serviceWorker.addEventListener('controllerchange', () => {
              if (refreshing) return
              if (shouldDeferSwReload(window.location.pathname)) {
                setSwUpdateAvailable(true)
                return
              }
              refreshing = true
              window.location.reload()
            })
          }

          // Update checks while the tab stays open across deploys.
          // Pause when the tab is hidden to avoid background churn.
          let updateTimer: ReturnType<typeof setInterval> | null = null
          const startTimer = () => {
            if (updateTimer) return
            updateTimer = setInterval(() => {
              reg.update().catch(() => undefined)
            }, UPDATE_INTERVAL_MS)
          }
          const stopTimer = () => {
            if (!updateTimer) return
            clearInterval(updateTimer)
            updateTimer = null
          }
          const onVisibility = () => {
            if (document.visibilityState === 'visible') {
              reg.update().catch(() => undefined)
              startTimer()
            } else {
              stopTimer()
            }
          }
          document.addEventListener('visibilitychange', onVisibility)
          if (document.visibilityState === 'visible') startTimer()
        } catch {
          // SW is optional — auth and reading must work without it
        }
      })()
    })
  })()
}
