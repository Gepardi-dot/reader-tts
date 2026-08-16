import './index.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TooltipProvider } from '@/components/ui/tooltip'
import { subscribeAuth } from '@/lib/auth'
import { registerServiceWorkerWithUpdate } from '@/lib/clientRecovery'
import { router } from './app/router'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60_000,
      gcTime: 24 * 60 * 60_000,
      refetchOnWindowFocus: false,
    },
  },
})

let activeUserId = ''

function applyAuthUser(nextUserId: string) {
  if (activeUserId && nextUserId && nextUserId !== activeUserId) {
    queryClient.clear()
    window.localStorage.removeItem('storybook-qcache-v1')
  }
  activeUserId = nextUserId
  void Promise.all([
    import('@/shared/storage/audioCache'),
    import('@/shared/storage/dictionaryCache'),
  ]).then(([audioCache, dictionaryCache]) => {
    void audioCache.setAudioCacheUserId(nextUserId || null)
    void dictionaryCache.setDictionaryCacheUserId(nextUserId || null)
  })
  if (!nextUserId) {
    // On sign-out, wipe the query cache so no stale data leaks between users
    queryClient.clear()
    window.localStorage.removeItem('storybook-qcache-v1')
    window.localStorage.removeItem('storybook-reader-progress')
  } else {
    // Prefetch books immediately after sign-in so the library is instant
    queryClient.prefetchQuery({
      queryKey: ['books'],
      queryFn: async () => {
        const { api } = await import('@/shared/api/client')
        const res = await api.get<{ items: unknown[] } | unknown[]>('/api/books')
        return Array.isArray(res) ? res : (res as { items: unknown[] }).items ?? []
      },
    })
  }
}

subscribeAuth((user) => applyAuthUser(user?.id ?? ''))

// Register SW with update + one-time shell-cache purge so old browsers are not
// stuck on a cache-first index.html from a previous deploy (broke login).
registerServiceWorkerWithUpdate()

// Strip one-shot deploy recovery query params without a full navigation loop.
if (typeof window !== 'undefined' && window.location.search.includes('_chunk=')) {
  const url = new URL(window.location.href)
  url.searchParams.delete('_chunk')
  window.history.replaceState({}, '', url.pathname + url.search + url.hash)
}

// Cross-origin isolation is required for SharedArrayBuffer (multi-threaded ONNX
// WASM). If headers are misconfigured we'll silently fall back to single-thread —
// log so a regression is visible in DevTools.
if (typeof window !== 'undefined' && !window.crossOriginIsolated) {
  console.warn('[tts] crossOriginIsolated is false — WASM threads disabled; check COOP/COEP headers.')
}

// Request persistent storage early so the 82 MB Kokoro model in Cache Storage
// isn't evicted under quota pressure. Best effort — browsers may decline.
if (typeof navigator !== 'undefined' && 'storage' in navigator && 'persist' in navigator.storage) {
  navigator.storage.persist().catch(() => undefined)
}

// Warm offline dictionary seed into memory so Define is instant for common words.
void import('@/shared/storage/dictionaryCache').then((dictionaryCache) => {
  void dictionaryCache.ensureDictionarySeed()
})

// Keep Fly Kokoro warm for the whole session (health every 90s + initial prime synth).
void import('@/features/studio/studioVoice').then((studioVoice) => {
  studioVoice.startKokoroKeepAlive()
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
)
