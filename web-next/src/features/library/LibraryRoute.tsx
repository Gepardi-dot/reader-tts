import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Search, Trash2, BookOpen } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { api } from '@/shared/api/client'
import { cn } from '@/lib/utils'

// Matches the real API response shape from server/app.py
interface Book {
  id: string
  title: string
  fileName: string
  uploadedAt: string
  pageCount: number
  textCharacters: number
  sourceUrl: string
  excerpt: string
  highlightCount: number
  readingProgress: ReadingProgress | null
}

const PROGRESS_KEY = 'storybook-reader-progress'
interface ReadingProgress { pageNumber: number; totalPages: number; updatedAt?: string }

function loadProgress(): Record<string, ReadingProgress> {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY)
    return raw ? (JSON.parse(raw) as Record<string, ReadingProgress>) : {}
  } catch { return {} }
}

function useBooks() {
  return useQuery({
    queryKey: ['books'],
    queryFn: async () => {
      const res = await api.get<{ items: Book[] } | Book[]>('/api/books')
      return Array.isArray(res) ? res : (res as { items: Book[] }).items ?? []
    },
  })
}

function BookCard({ book, progress, onDelete }: {
  book: Book
  progress?: ReadingProgress
  onDelete: (id: string) => void
}) {
  const pct = progress && progress.totalPages > 0
    ? Math.round((progress.pageNumber / progress.totalPages) * 100)
    : 0
  const hasProgress = pct > 0

  return (
    <div className="group relative">
      <Link
        to={`/book/${book.id}`}
        className="block rounded-lg border border-border bg-card hover:border-primary/40 hover:shadow-sm transition-all overflow-hidden"
      >
        {/* Cover placeholder — API has no cover_url */}
        <div className="aspect-[2/3] bg-muted relative overflow-hidden">
          <div className="w-full h-full flex flex-col items-center justify-center p-4 gap-3">
            <BookOpen size={32} className="text-muted-foreground/40" />
            <span className="text-xs text-muted-foreground text-center line-clamp-3 leading-snug"
              style={{ fontFamily: 'Lora, Georgia, serif' }}>
              {book.title}
            </span>
          </div>
          {hasProgress && (
            <div className="absolute inset-x-0 bottom-0 bg-background/80 backdrop-blur-sm px-2 pt-1 pb-0.5">
              <Progress value={pct} className="h-1" />
            </div>
          )}
        </div>

        {/* Meta */}
        <div className="p-3">
          <p className="text-sm font-medium text-foreground line-clamp-2 leading-snug">
            {book.title}
          </p>
          <div className="flex items-center gap-2 mt-2">
            {hasProgress && (
              <Badge variant="secondary" className="text-[10px] h-4">{pct}%</Badge>
            )}
            <span className="text-[10px] text-muted-foreground">{book.pageCount}p</span>
            {book.highlightCount > 0 && (
              <span className="text-[10px] text-muted-foreground">{book.highlightCount} notes</span>
            )}
          </div>
        </div>
      </Link>

      {/* Delete button */}
      <button
        onClick={(e) => { e.preventDefault(); onDelete(book.id) }}
        className={cn(
          'absolute top-2 right-2 p-1.5 rounded-md bg-background/80 backdrop-blur-sm',
          'opacity-0 group-hover:opacity-100 transition-opacity',
          'text-muted-foreground hover:text-destructive',
        )}
        aria-label="Delete book"
      >
        <Trash2 size={14} />
      </button>
    </div>
  )
}

export function LibraryRoute() {
  const [search, setSearch] = useState('')
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const { data: books = [], isLoading, error } = useBooks()
  const queryClient = useQueryClient()
  const fallbackProgressMap = loadProgress()

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/books/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['books'] })
      setDeleteId(null)
    },
  })

  const q = search.toLowerCase()
  const filtered = books.filter(
    (b) => b.title.toLowerCase().includes(q) || b.excerpt.toLowerCase().includes(q),
  )

  const bookToDelete = books.find((b) => b.id === deleteId)

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-foreground">Library</h1>
        <Link to="/upload">
          <Button size="sm">Add book</Button>
        </Link>
      </div>

      {/* Search */}
      <div className="relative mb-6">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search books..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      {/* Grid */}
      {isLoading ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="rounded-lg bg-muted animate-pulse aspect-[2/3]" />
          ))}
        </div>
      ) : error ? (
        <p className="text-sm text-destructive">Failed to load library.</p>
      ) : filtered.length === 0 ? (
        <div className="text-center py-24 text-muted-foreground">
          {search ? 'No books match your search.' : 'No books yet. Upload a PDF to get started.'}
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
          {filtered.map((book) => (
            <BookCard
              key={book.id}
              book={book}
              progress={book.readingProgress ?? fallbackProgressMap[book.id]}
              onDelete={setDeleteId}
            />
          ))}
        </div>
      )}

      {/* Delete confirmation dialog */}
      <Dialog open={!!deleteId} onOpenChange={(open) => !open && setDeleteId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete book?</DialogTitle>
            <DialogDescription>
              <strong>"{bookToDelete?.title}"</strong> will be permanently removed including all
              notes, highlights, and audio files. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteId(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() => deleteId && deleteMutation.mutate(deleteId)}
            >
              {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
