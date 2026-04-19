import './index.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import { QueryClient } from '@tanstack/react-query'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister'
import { TooltipProvider } from '@/components/ui/tooltip'
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

// Kick off books fetch immediately so the library is ready before the user navigates there
queryClient.prefetchQuery({
  queryKey: ['books'],
  queryFn: async () => {
    const { api } = await import('@/shared/api/client')
    const res = await api.get<{ items: unknown[] } | unknown[]>('/api/books')
    return Array.isArray(res) ? res : (res as { items: unknown[] }).items ?? []
  },
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
