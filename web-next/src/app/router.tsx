import { createBrowserRouter, Navigate, redirect } from 'react-router-dom'
import { getStoredUser, restoreSession } from '@/lib/auth'
import { needsVoiceOnboarding } from '@/features/reader/voiceOnboarding'

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
    lazy: () => import('@/features/auth/LoginRoute').then((mod) => ({ Component: mod.LoginRoute })),
    hydrateFallbackElement,
  },
  {
    path: '/onboarding/voice',
    lazy: () => import('@/features/auth/VoiceOnboardingRoute').then((mod) => ({
      Component: mod.VoiceOnboardingRoute,
    })),
    loader: requireAuth,
    hydrateFallbackElement,
  },
  {
    path: '/',
    lazy: () => import('./AppShell').then((mod) => ({ Component: mod.AppShell })),
    loader: requireAuthWithVoice,
    hydrateFallbackElement,
    children: [
      { index: true, element: <Navigate to="/library" replace /> },
      {
        path: 'library',
        lazy: () => import('@/features/library/LibraryRoute').then((mod) => ({ Component: mod.LibraryRoute })),
        hydrateFallbackElement,
      },
      {
        path: 'notes',
        lazy: () => import('@/features/notes/NotesRoute').then((mod) => ({ Component: mod.NotesRoute })),
        hydrateFallbackElement,
      },
      {
        path: 'vocabulary',
        lazy: () => import('@/features/vocabulary/VocabularyRoute').then((mod) => ({ Component: mod.VocabularyRoute })),
        hydrateFallbackElement,
      },
      {
        path: 'studio',
        lazy: () => import('@/features/studio/StudioRoute').then((mod) => ({ Component: mod.StudioRoute })),
        hydrateFallbackElement,
      },
      {
        path: 'progress',
        lazy: () => import('@/features/progress/ProgressRoute').then((mod) => ({ Component: mod.ProgressRoute })),
        hydrateFallbackElement,
      },
      {
        path: 'audio',
        lazy: () => import('@/features/reader/AudioSettingsRoute').then((mod) => ({ Component: mod.AudioSettingsRoute })),
        hydrateFallbackElement,
      },
      {
        path: 'upload',
        lazy: () => import('@/features/library/UploadRoute').then((mod) => ({ Component: mod.UploadRoute })),
        hydrateFallbackElement,
      },
    ],
  },
  // Reader is outside AppShell but still requires auth + voice onboarding
  {
    path: '/book/:bookId',
    lazy: () => import('@/features/reader/ReaderRoute').then((mod) => ({ Component: mod.ReaderRoute })),
    loader: requireAuthWithVoice,
    hydrateFallbackElement,
  },
])
