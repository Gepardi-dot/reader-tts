/**
 * Repair browsers stuck on a stale service-worker shell or broken auth state.
 * Common after Vercel deploys when an old SW cache-first'd index.html.
 */

import { clearAuth } from '@/lib/auth'

export async function clearServiceWorkerCaches(): Promise<void> {
  if (typeof caches !== 'undefined') {
    const keys = await caches.keys()
    await Promise.all(keys.map((key) => caches.delete(key)))
  }
}

export async function unregisterServiceWorkers(): Promise<void> {
  if (!('serviceWorker' in navigator)) return
  const regs = await navigator.serviceWorker.getRegistrations()
  await Promise.all(regs.map((reg) => reg.unregister()))
}

/**
 * Wipe auth + SW caches and hard-reload so the next load fetches a fresh
 * index.html and production JS (absolute Worker API origin).
 */
export async function recoverStuckClient(options?: { reload?: boolean }): Promise<void> {
  const shouldReload = options?.reload !== false
  try {
    clearAuth()
  } catch { /* ignore */ }
  try {
    // Drop offline query cache that may hold 401'd book lists
    window.localStorage.removeItem('storybook-qcache-v1')
  } catch { /* ignore */ }
  try {
    await clearServiceWorkerCaches()
  } catch { /* ignore */ }
  try {
    await unregisterServiceWorkers()
  } catch { /* ignore */ }
  if (shouldReload && typeof window !== 'undefined') {
    const url = new URL(window.location.href)
    url.searchParams.set('_recovered', String(Date.now()))
    window.location.replace(url.toString())
  }
}

/** One-shot flag so we don't loop reload on every visit. */
const RECOVERY_BUMP_KEY = 'reader-tts-sw-shell-v3'

/**
 * After deploy, force old SWs to update. If a new worker activates, reload once
 * so the browser drops the previous HTML/JS shell.
 */
export function registerServiceWorkerWithUpdate(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return

  window.addEventListener('load', () => {
    void (async () => {
      try {
        // First visit after shell-v3: purge ancient shell-v1 HTML caches once.
        if (!window.localStorage.getItem(RECOVERY_BUMP_KEY)) {
          window.localStorage.setItem(RECOVERY_BUMP_KEY, '1')
          const keys = await caches.keys()
          const stale = keys.filter((k) => k.startsWith('storybook-shell-') && k !== 'storybook-shell-v3')
          if (stale.length > 0) {
            await Promise.all(stale.map((k) => caches.delete(k)))
          }
        }

        const reg = await navigator.serviceWorker.register('/sw.js')
        await reg.update().catch(() => undefined)

        // New worker waiting → activate immediately
        if (reg.waiting) {
          reg.waiting.postMessage({ type: 'SKIP_WAITING' })
        }
        reg.addEventListener('updatefound', () => {
          const worker = reg.installing
          if (!worker) return
          worker.addEventListener('statechange', () => {
            if (worker.state === 'installed' && navigator.serviceWorker.controller) {
              worker.postMessage({ type: 'SKIP_WAITING' })
            }
          })
        })

        let refreshing = false
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          if (refreshing) return
          refreshing = true
          window.location.reload()
        })
      } catch {
        // SW optional — auth must still work without it
      }
    })()
  })
}
