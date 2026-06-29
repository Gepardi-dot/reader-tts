import { createBrowserRouter, Navigate, redirect } from 'react-router-dom'
import { AppShell } from './AppShell'
import { LibraryRoute } from '@/features/library/LibraryRoute'
import { ReaderRoute } from '@/features/reader/ReaderRoute'
import { NotesRoute } from '@/features/notes/NotesRoute'
import { VocabularyRoute } from '@/features/vocabulary/VocabularyRoute'
import { StudioRoute } from '@/features/studio/StudioRoute'
import { UploadRoute } from '@/features/library/UploadRoute'
import { AudioSettingsRoute } from '@/features/reader/AudioSettingsRoute'
import { ProgressRoute } from '@/features/progress/ProgressRoute'
import { LoginRoute } from '@/features/auth/LoginRoute'
import { getAuthSession } from '@/lib/authSession'

async function requireAuth() {
  try {
    const { data } = await getAuthSession()
    if (!data.session) throw redirect('/login')
  } catch (error) {
    if (error instanceof Response) throw error
    console.warn('[auth] Failed to read session before route load.', error)
    throw redirect('/login')
  }
  return null
}

export const router = createBrowserRouter([
  { path: '/login', element: <LoginRoute /> },
  {
    path: '/',
    element: <AppShell />,
    loader: requireAuth,
    children: [
      { index: true, element: <Navigate to="/library" replace /> },
      { path: 'library', element: <LibraryRoute /> },
      { path: 'notes', element: <NotesRoute /> },
      { path: 'vocabulary', element: <VocabularyRoute /> },
      { path: 'studio', element: <StudioRoute /> },
      { path: 'progress', element: <ProgressRoute /> },
      { path: 'audio', element: <AudioSettingsRoute /> },
      { path: 'upload', element: <UploadRoute /> },
    ],
  },
  // Reader is outside AppShell but still requires auth
  {
    path: '/book/:bookId',
    element: <ReaderRoute />,
    loader: requireAuth,
  },
])
