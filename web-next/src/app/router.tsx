import { createBrowserRouter, Navigate } from 'react-router-dom'
import { AppShell } from './AppShell'
import { LibraryRoute } from '@/features/library/LibraryRoute'
import { ReaderRoute } from '@/features/reader/ReaderRoute'
import { NotesRoute } from '@/features/notes/NotesRoute'
import { VocabularyRoute } from '@/features/vocabulary/VocabularyRoute'
import { StudioRoute } from '@/features/studio/StudioRoute'
import { UploadRoute } from '@/features/library/UploadRoute'
import { AudioSettingsRoute } from '@/features/reader/AudioSettingsRoute'

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/library" replace /> },
      { path: 'library', element: <LibraryRoute /> },
      { path: 'notes', element: <NotesRoute /> },
      { path: 'vocabulary', element: <VocabularyRoute /> },
      { path: 'studio', element: <StudioRoute /> },
      { path: 'audio', element: <AudioSettingsRoute /> },
      { path: 'upload', element: <UploadRoute /> },
    ],
  },
  // Reader is outside AppShell (full-screen)
  { path: '/book/:bookId', element: <ReaderRoute /> },
])
