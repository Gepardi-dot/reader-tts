const SHELL_CACHE = 'storybook-shell-v1'
const PROVIDERS_CACHE = 'storybook-providers-v1'
const MODEL_CACHE = 'kokoro-model-v1'
const ACTIVE_CACHES = [SHELL_CACHE, PROVIDERS_CACHE, MODEL_CACHE]
const SHELL_URLS = ['/', '/index.html', '/favicon.svg', '/icons.svg', '/dictionary-seed.json']
const MODEL_HOSTS = new Set([
  'huggingface.co',
  'cdn-lfs.huggingface.co',
  'cdn-lfs-us-1.huggingface.co',
  'cdn-lfs-eu-1.huggingface.co',
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
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys
        .filter((key) => !ACTIVE_CACHES.includes(key))
        .map((key) => caches.delete(key)),
    )),
  )
  self.clients.claim()
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

async function cacheFirstShell(request) {
  const cache = await caches.open(SHELL_CACHE)
  const cached = await cache.match(request)
  if (cached) return cached
  const response = await fetch(request)
  if (response.ok) cache.put(request, response.clone())
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

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)

  if (MODEL_HOSTS.has(url.hostname)) {
    event.respondWith(modelCacheFirst(request))
    return
  }

  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/library/')) return

  if (url.pathname === '/api/providers') {
    event.respondWith(staleWhileRevalidate(request))
    return
  }

  if (
    url.pathname === '/' ||
    url.pathname === '/index.html' ||
    url.pathname === '/dictionary-seed.json' ||
    url.pathname.startsWith('/assets/') ||
    url.pathname.endsWith('.svg') ||
    url.pathname.endsWith('.woff') ||
    url.pathname.endsWith('.woff2')
  ) {
    event.respondWith(cacheFirstShell(request))
  }
})
