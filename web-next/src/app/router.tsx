import { createBrowserRouter, Navigate, redirect } from 'react-router-dom'
import { getStoredUser, restoreSession } from '@/lib/auth'
import { needsVoiceOnboarding } from '@/features/reader/voiceOnboarding'
import { lazyRoute } from '@/app/chunkLoad'
import { RouteError } from '@/app/RouteError'

const hydrateFallbackElement = (
  <div className="flex min-h-[240px] items-center justify-center px-4 text-sm text-muted-foreground">
    Loading...
  </div>
)

async function requireAuth() {
  try {
    const user = await restoreSession()
    if (!user) throw redirect('/login')
  } catch (error) {
    if (error instanceof Response) throw error
    console.warn('[auth] Failed to read session before route load.', error)
    throw redirect('/login')
  }
  return null
}

/** Auth + force Kokoro voice pick before main app (prefetch/cache align to one voice). */
async function requireAuthWithVoice() {
  await requireAuth()
  const user = getStoredUser()
  if (user && needsVoiceOnboarding(user.id)) {
    throw redirect('/onboarding/voice')
  }
  return null
}

export const router = createBrowserRouter([
  {
    path: '/login',
    lazy: () =>
      lazyRoute(() =>
        import('@/features/auth/LoginRoute').then((mod) => ({ Component: mod.LoginRoute })),
      ),
    errorElement: <RouteError />,
    hydrateFallbackElement,
  },
  {
    path: '/onboarding/voice',
    lazy: () =>
      lazyRoute(() =>
        import('@/features/auth/VoiceOnboardingRoute').then((mod) => ({
          Component: mod.VoiceOnboardingRoute,
        })),
      ),
    loader: requireAuth,
    errorElement: <RouteError />,
    hydrateFallbackElement,
  },
  {
    path: '/',
    lazy: () =>
      lazyRoute(() => import('./AppShell').then((mod) => ({ Component: mod.AppShell }))),
    loader: requireAuthWithVoice,
    errorElement: <RouteError />,
    hydrateFallbackElement,
    children: [
      { index: true, element: <Navigate to="/library" replace /> },
      {
        path: 'library',
        lazy: () =>
          lazyRoute(() =>
            import('@/features/library/LibraryRoute').then((mod) => ({
              Component: mod.LibraryRoute,
            })),
          ),
        errorElement: <RouteError />,
        hydrateFallbackElement,
      },
      {
        path: 'notes',
        lazy: () =>
          lazyRoute(() =>
            import('@/features/notes/NotesRoute').then((mod) => ({ Component: mod.NotesRoute })),
          ),
        errorElement: <RouteError />,
        hydrateFallbackElement,
      },
      {
        path: 'vocabulary',
        lazy: () =>
          lazyRoute(() =>
            import('@/features/vocabulary/VocabularyRoute').then((mod) => ({
              Component: mod.VocabularyRoute,
            })),
          ),
        errorElement: <RouteError />,
        hydrateFallbackElement,
      },
      {
        path: 'studio',
        lazy: () =>
          lazyRoute(() =>
            import('@/features/studio/StudioRoute').then((mod) => ({ Component: mod.StudioRoute })),
          ),
        errorElement: <RouteError />,
        hydrateFallbackElement,
      },
      {
        path: 'progress',
        lazy: () =>
          lazyRoute(() =>
            import('@/features/progress/ProgressRoute').then((mod) => ({
              Component: mod.ProgressRoute,
            })),
          ),
        errorElement: <RouteError />,
        hydrateFallbackElement,
      },
      {
        path: 'audio',
        lazy: () =>
          lazyRoute(() =>
            import('@/features/reader/AudioSettingsRoute').then((mod) => ({
              Component: mod.AudioSettingsRoute,
            })),
          ),
        errorElement: <RouteError />,
        hydrateFallbackElement,
      },
      {
        path: 'upload',
        lazy: () =>
          lazyRoute(() =>
            import('@/features/library/UploadRoute').then((mod) => ({
              Component: mod.UploadRoute,
            })),
          ),
        errorElement: <RouteError />,
        hydrateFallbackElement,
      },
    ],
  },
  // Reader is outside AppShell but still requires auth + voice onboarding
  {
    path: '/book/:bookId',
    lazy: () =>
      lazyRoute(() =>
        import('@/features/reader/ReaderRoute').then((mod) => ({ Component: mod.ReaderRoute })),
      ),
    loader: requireAuthWithVoice,
    errorElement: <RouteError />,
    hydrateFallbackElement,
  },
])
