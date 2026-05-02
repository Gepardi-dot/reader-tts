const SHELL_CACHE = 'storybook-shell-v1'
const PROVIDERS_CACHE = 'storybook-providers-v1'
const SHELL_URLS = ['/', '/index.html', '/favicon.svg', '/icons.svg', '/dictionary-seed.json']

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
        .filter((key) => ![SHELL_CACHE, PROVIDERS_CACHE].includes(key))
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

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
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
