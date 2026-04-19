import './index.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import { QueryClient } from '@tanstack/react-query'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister'
import { TooltipProvider } from '@/components/ui/tooltip'
import { supabase } from '@/lib/supabase'
import { setCachedToken } from '@/shared/api/client'
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

// Keep the cached JWT in sync with Supabase session (covers login, logout, token refresh)
supabase.auth.onAuthStateChange((_event, session) => {
  const token = session?.access_token ?? ''
  setCachedToken(token)
  if (!token) {
    // On sign-out, wipe the query cache so no stale data leaks between users
    queryClient.clear()
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
supabase.auth.getSession().then(({ data }) => {
  if (data.session?.access_token) {
    setCachedToken(data.session.access_token)
  }
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PersistQueryClientProvider client={queryClient} persistOptions={{ persister }}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </PersistQueryClientProvider>
  </StrictMode>,
)
