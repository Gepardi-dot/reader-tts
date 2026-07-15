import './index.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TooltipProvider } from '@/components/ui/tooltip'
import { subscribeAuth } from '@/lib/auth'
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

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
)
