// Bump when shell/HTML caching rules change so old clients drop stale index.html.
const SHELL_CACHE = 'storybook-shell-v3'
const PROVIDERS_CACHE = 'storybook-providers-v1'
const MODEL_CACHE = 'kokoro-model-v1'
const COVER_CACHE = 'book-covers-v1'
const ACTIVE_CACHES = [SHELL_CACHE, PROVIDERS_CACHE, MODEL_CACHE, COVER_CACHE]

// Never precache HTML — a stale index.html pins browsers to old JS hashes and
// can break auth (e.g. relative /api on Vercel). Only static, content-hashed
// assets and offline helpers belong in the shell cache.
const SHELL_URLS = ['/favicon.svg', '/dictionary-seed.json']

const MODEL_HOSTS = new Set([
  'huggingface.co',
  'cdn-lfs.huggingface.co',
  'cdn-lfs-us-1.huggingface.co',
  'cdn-lfs-eu-1.huggingface.co',
])
const COVER_HOSTS = new Set([
  'covers.openlibrary.org',
  'books.google.com',
  'books.googleusercontent.com',
])

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_URLS))
      .catch(() => undefined),
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    const stale = keys.filter((key) => !ACTIVE_CACHES.includes(key))
    await Promise.all(stale.map((key) => caches.delete(key)))
    await self.clients.claim()
    // Old clients were stuck on cache-first index.html (broken login). After we
    // drop legacy shell caches, force a same-URL navigation so they load fresh HTML
    // even if the open tab still has the previous SW-controlled document.
    if (stale.length > 0) {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
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
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting()
  }
  if (event.data && event.data.type === 'CLEAR_SHELL_CACHE') {
    event.waitUntil(caches.delete(SHELL_CACHE))
  }
})

async function staleWhileRevalidate(request) {
  const cache = await caches.open(PROVIDERS_CACHE)
  const cached = await cache.match(request)
  const network = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone())
      return response
    })
    .catch(() => cached)
  return cached || network
}

/** Hashed /assets/* and fonts: cache-first is safe (URL changes when content changes). */
async function cacheFirstAsset(request) {
  const cache = await caches.open(SHELL_CACHE)
  const cached = await cache.match(request)
  if (cached) return cached
  const response = await fetch(request)
  if (response.ok) cache.put(request, response.clone()).catch(() => undefined)
  return response
}

// Cross-origin model bytes (~82 MB) are large and infrequently changing — cache
// them aggressively in their own bucket. The injected CORP header makes the
// response usable when the page is cross-origin isolated (COOP/COEP).
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

function withCorp(response) {
  const headers = new Headers(response.headers)
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin')
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
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

  const url = new URL(request.url)

  if (MODEL_HOSTS.has(url.hostname)) {
    event.respondWith(modelCacheFirst(request))
    return
  }

  if (COVER_HOSTS.has(url.hostname)) {
    event.respondWith(coverCacheFirst(request))
    return
  }

  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/library/')) return

  // Navigations + HTML: always network. Stale index.html was pinning old clients
  // to broken auth bundles after deploys.
  const accept = request.headers.get('accept') || ''
  if (
    request.mode === 'navigate'
    || url.pathname === '/'
    || url.pathname === '/index.html'
    || accept.includes('text/html')
  ) {
    event.respondWith(fetch(request))
    return
  }

  if (url.pathname === '/api/providers') {
    event.respondWith(staleWhileRevalidate(request))
    return
  }

  // Never cache /api/* (auth, books, etc.)
  if (url.pathname.startsWith('/api/')) return

  if (
    url.pathname === '/dictionary-seed.json'
    || url.pathname.startsWith('/assets/')
    || url.pathname.endsWith('.svg')
    || url.pathname.endsWith('.woff')
    || url.pathname.endsWith('.woff2')
  ) {
    event.respondWith(cacheFirstAsset(request))
  }
})
