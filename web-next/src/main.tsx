import './index.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import { QueryClient } from '@tanstack/react-query'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister'
import { TooltipProvider } from '@/components/ui/tooltip'
import { supabase } from '@/lib/supabase'
import { getAuthSession } from '@/lib/authSession'
import { setCachedToken } from '@/shared/api/client'
import { setAudioCacheUserId } from '@/shared/storage/audioCache'
import { setDictionaryCacheUserId } from '@/shared/storage/dictionaryCache'
import { startWarmup } from '@/shared/storage/modelCache'
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

const persister = createSyncStoragePersister({
  storage: window.localStorage,
  key: 'storybook-qcache-v1',
  throttleTime: 1000,
})

let activeUserId = ''

// Keep the cached JWT in sync with Supabase session (covers login, logout, token refresh)
supabase.auth.onAuthStateChange((_event, session) => {
  const token = session?.access_token ?? ''
  const nextUserId = session?.user.id ?? ''
  if (activeUserId && nextUserId && nextUserId !== activeUserId) {
    queryClient.clear()
    window.localStorage.removeItem('storybook-qcache-v1')
  }
  activeUserId = nextUserId
  void setAudioCacheUserId(nextUserId || null)
  void setDictionaryCacheUserId(nextUserId || null)
  setCachedToken(token)
  if (!token) {
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
})

// Restore token from existing session on app start (before any render)
getAuthSession().then(({ data }) => {
  if (data.session?.access_token) {
    activeUserId = data.session.user.id
    void setAudioCacheUserId(data.session.user.id)
    void setDictionaryCacheUserId(data.session.user.id)
    setCachedToken(data.session.access_token)
  }
}).catch((error) => {
  console.warn('[auth] Failed to restore Supabase session.', error)
})

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

// Begin model download + warmup as soon as the app loads. Idempotent —
// triggers regardless of route. By the time the user navigates to /book/:id,
// the pipeline is downloaded (or close to it) and the warmup synth has run.
if (typeof Worker !== 'undefined') {
  startWarmup()
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PersistQueryClientProvider client={queryClient} persistOptions={{ persister }}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </PersistQueryClientProvider>
  </StrictMode>,
)
