/**
 * Service worker — models & covers ONLY.
 *
 * PERMANENT RULE: never intercept same-origin requests (HTML, JS, CSS, /api).
 * Caching the app shell previously pinned browsers to stale index.html after
 * deploys and broke login on returning devices. The browser HTTP cache is
 * enough for hashed /assets/* (Vercel: immutable long-cache).
 *
 * This SW exists only to:
 *  1) Cache large Kokoro / Hugging Face model bytes
 *  2) Inject Cross-Origin-Resource-Policy for COEP (SharedArrayBuffer)
 *  3) Cache book cover thumbnails
 */
const SW_PROTOCOL = 'models-covers-only-v1'
const MODEL_CACHE = 'kokoro-model-v1'
const COVER_CACHE = 'book-covers-v1'
/** Only these caches may survive activation. Everything else is deleted. */
const ACTIVE_CACHES = [MODEL_CACHE, COVER_CACHE]

const MODEL_HOSTS = new Set([
  'huggingface.co',
  'cdn-lfs.huggingface.co',
  'cdn-lfs-us-1.huggingface.co',
  'cdn-lfs-eu-1.huggingface.co',
])
const COVER_HOSTS = new Set([
  'openlibrary.org',
  'covers.openlibrary.org',
  'books.google.com',
  'books.googleusercontent.com',
  'www.googleapis.com',
])

self.addEventListener('install', (event) => {
  // No precache of the app shell — ever.
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    // Drop every legacy shell / providers / HTML cache permanently.
    const stale = keys.filter((key) => !ACTIVE_CACHES.includes(key))
    await Promise.all(stale.map((key) => caches.delete(key)))
    await self.clients.claim()

    // One-time navigation so tabs still running an old controlling SW pick up
    // fresh HTML from the network (old SW may have cache-first'd index.html).
    if (stale.length > 0) {
      const windows = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      })
      await Promise.all(
        windows.map((client) => {
          if ('navigate' in client && typeof client.navigate === 'function') {
            return client.navigate(client.url).catch(() => undefined)
          }
          return undefined
        }),
      )
    }
  })())
})

self.addEventListener('message', (event) => {
  const data = event.data
  if (!data || typeof data !== 'object') return
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting()
    return
  }
  if (data.type === 'PURGE_NON_MODEL_CACHES') {
    event.waitUntil(
      caches.keys().then((keys) =>
        Promise.all(
          keys
            .filter((key) => !ACTIVE_CACHES.includes(key))
            .map((key) => caches.delete(key)),
        ),
      ),
    )
    return
  }
  if (data.type === 'GET_PROTOCOL' && event.ports && event.ports[0]) {
    event.ports[0].postMessage({ protocol: SW_PROTOCOL })
  }
})

function withCorp(response) {
  const headers = new Headers(response.headers)
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin')
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

async function modelCacheFirst(request) {
  const cache = await caches.open(MODEL_CACHE)
  const cached = await cache.match(request, { ignoreVary: true })
  if (cached) return withCorp(cached)
  let response
  try {
    response = await fetch(request, { mode: 'cors', credentials: 'omit' })
  } catch (err) {
    if (cached) return withCorp(cached)
    throw err
  }
  if (response.ok) {
    cache.put(request, response.clone()).catch(() => undefined)
  }
  return withCorp(response)
}

async function coverCacheFirst(request) {
  const cache = await caches.open(COVER_CACHE)
  const cached = await cache.match(request, { ignoreVary: true })
  if (cached) return withCorp(cached)
  let response
  try {
    response = await fetch(request, { mode: 'cors', credentials: 'omit' })
  } catch (err) {
    if (cached) return withCorp(cached)
    throw err
  }
  if (response.ok) {
    cache.put(request, response.clone()).catch(() => undefined)
  }
  return withCorp(response)
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  let url
  try {
    url = new URL(request.url)
  } catch {
    return
  }

  // ─── CRITICAL: never touch same-origin app/API traffic ───
  // Let the browser talk to Vercel/Worker directly for HTML, JS, CSS, /api.
  if (url.origin === self.location.origin) {
    return
  }

  if (MODEL_HOSTS.has(url.hostname)) {
    event.respondWith(modelCacheFirst(request))
    return
  }

  if (COVER_HOSTS.has(url.hostname)) {
    event.respondWith(coverCacheFirst(request))
  }
})
