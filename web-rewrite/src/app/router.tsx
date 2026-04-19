import { createBrowserRouter, Navigate } from 'react-router-dom'
import { AppShell } from './AppShell'
import { ErrorBoundary } from './ErrorBoundary'
import { LearnRoute } from '@/features/learn/LearnRoute'
import { LibraryRoute } from '@/features/library/LibraryRoute'
import { BookRoute } from '@/features/book/BookRoute'
import { UploadRoute } from '@/features/upload/UploadRoute'
import { AudioSettingsRoute } from '@/features/audio/AudioSettingsRoute'
import { NotesRoute } from '@/features/notes/NotesRoute'
import { WordsRoute } from '@/features/words/WordsRoute'

export const router = createBrowserRouter([
  {
    path: '/',
    element: (
      <ErrorBoundary>
        <AppShell />
      </ErrorBoundary>
    ),
    children: [
      {
        index: true,
        element: <Navigate replace to="/books" />,
      },
      {
        path: 'books',
        element: <LibraryRoute />,
      },
      {
        path: 'notes',
        element: <NotesRoute />,
      },
      {
        path: 'words',
        element: <WordsRoute />,
      },
      {
        path: 'studio',
        element: <LearnRoute />,
      },
      {
        path: 'book/:bookId',
        element: <BookRoute />,
      },
      {
        path: 'upload',
        element: <UploadRoute />,
      },
      {
        path: 'settings/audio',
        element: <AudioSettingsRoute />,
      },
    ],
  },
])
