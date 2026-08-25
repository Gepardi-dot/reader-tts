import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Search, BookOpen, Upload, X } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { api } from '@/shared/api/client'
import { cn } from '@/lib/utils'
import { loadLibraryCover } from './resolveBookCover'
import { deleteStoredCover } from '@/shared/storage/coverCache'

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
  coverUrl?: string | null
}

interface ReadingProgress { pageNumber: number; totalPages: number; updatedAt?: string }

// Warm cover tints cycling across books (fallback when no internet match is found)
const COVER_COLORS = ['#fef6ee', '#eef4fb', '#f0efe9', '#f8eef0']

function useBookCover(book: Book) {
  return useQuery({
    queryKey: ['book-cover', book.id, book.coverUrl ?? ''],
    queryFn: () => loadLibraryCover(book),
    staleTime: Infinity,
    gcTime: 24 * 60 * 60 * 1000,
    retry: false,
  })
}

const PARTICLE_WORDS = [
  'chapter', 'verse', 'prologue', 'epilogue', 'memoir', 'fable',
  'metaphor', 'stanza', 'plot', 'motif', 'narrative', 'tome', 'folio',
  'preface', 'author', 'genre', 'prose', 'lyric', 'allegory',
  'subtext', 'draft', 'canon', 'excerpt', 'footnote', 'margin',
  'ink', 'page', 'spine', 'cover', 'binding', 'serif', 'glyph',
]

interface WP {
  word: string; x: number; y: number
  vx: number; vy: number; size: number
  peakAlpha: number; dir: 1 | -1; startX: number; endX: number
}

function WordParticles() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    let raf: number
    let w = 0, h = 0

    function resize() {
      if (!canvas) return
      w = canvas.offsetWidth
      h = canvas.offsetHeight
      canvas.width  = w
      canvas.height = h
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)

    function spawn(anywhere = false): WP {
      const dir: 1 | -1 = Math.random() < 0.5 ? 1 : -1
      const speed = 0.35 + Math.random() * 0.4
      const startX = dir === 1 ? -90 : w + 90
      const endX   = dir === 1 ? w + 90 : -90
      return {
        word:      PARTICLE_WORDS[Math.floor(Math.random() * PARTICLE_WORDS.length)],
        x:         anywhere ? Math.random() * w : startX,
        y:         20 + Math.random() * (h - 40),
        vx:        dir * speed,
        vy:        (Math.random() - 0.5) * 0.06,
        size:      10 + Math.random() * 5,
        peakAlpha: 0.07 + Math.random() * 0.06,
        dir, startX, endX,
      }
    }

    const particles: WP[] = Array.from({ length: 22 }, () => spawn(true))

    function draw() {
      ctx.clearRect(0, 0, w, h)
      for (const p of particles) {
        p.x += p.vx
        p.y += p.vy
        const travel = Math.abs(p.endX - p.startX)
        const gone   = Math.abs(p.x - p.startX)
        const t      = Math.min(gone / travel, 1)
        const fade   = t < 0.2 ? t / 0.2 : t > 0.8 ? (1 - t) / 0.2 : 1
        ctx.globalAlpha = p.peakAlpha * fade
        ctx.fillStyle   = '#37352f'
        ctx.font        = `400 ${p.size}px "Lora", Georgia, serif`
        ctx.fillText(p.word, p.x, p.y)
        if (p.dir === 1 ? p.x > w + 90 : p.x < -90) Object.assign(p, spawn(false))
      }
      ctx.globalAlpha = 1
      raf = requestAnimationFrame(draw)
    }

    draw()
    return () => { cancelAnimationFrame(raf); ro.disconnect() }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full pointer-events-none"
      aria-hidden
    />
  )
}

type FilterType = 'all' | 'reading' | 'finished' | 'unread'
const FILTER_LABELS: { id: FilterType; label: string }[] = [
  { id: 'all',      label: 'All' },
  { id: 'reading',  label: 'Reading' },
  { id: 'finished', label: 'Finished' },
  { id: 'unread',   label: 'Unread' },
]

const PROGRESS_KEY = 'storybook-reader-progress'

function loadProgress(): Record<string, ReadingProgress> {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY)
    return raw ? (JSON.parse(raw) as Record<string, ReadingProgress>) : {}
  } catch { return {} }
}

function readPct(p?: ReadingProgress | null) {
  if (!p || !p.totalPages) return 0
  return Math.round((p.pageNumber / p.totalPages) * 100)
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

function BookCard({ book, progress, index, onDelete }: {
  book: Book
  progress?: ReadingProgress | null
  index: number
  onDelete: (id: string) => void
}) {
  const pct = readPct(progress)
  const coverBg = COVER_COLORS[index % COVER_COLORS.length]
  const [failedCoverUrl, setFailedCoverUrl] = useState<string | null>(null)
  const { data: coverUrl } = useBookCover(book)
  const showCover = Boolean(coverUrl && failedCoverUrl !== coverUrl)

  return (
    <div className="group relative">
      <Link
        to={`/book/${book.id}`}
        className="block"
      >
        <div
          className={cn(
            'relative aspect-[2/3] overflow-hidden rounded-[11px] bg-muted',
            'ring-1 ring-black/[0.08] dark:ring-white/12',
            'shadow-[0_1px_1px_rgba(15,18,24,0.06),0_10px_24px_-8px_rgba(15,18,24,0.34),0_24px_48px_-16px_rgba(15,18,24,0.16)]',
            'dark:shadow-[0_1px_1px_rgba(0,0,0,0.5),0_14px_32px_-10px_rgba(0,0,0,0.68),0_32px_64px_-20px_rgba(0,0,0,0.52)]',
            'transition-[transform,box-shadow] duration-300 ease-out will-change-transform',
            'group-hover:-translate-y-1.5',
            'group-hover:shadow-[0_2px_6px_rgba(15,18,24,0.08),0_18px_36px_-10px_rgba(15,18,24,0.4),0_40px_72px_-22px_rgba(15,18,24,0.22)]',
            'dark:group-hover:shadow-[0_2px_8px_rgba(0,0,0,0.55),0_22px_44px_-12px_rgba(0,0,0,0.72),0_48px_84px_-24px_rgba(0,0,0,0.58)]',
          )}
        >
          {showCover ? (
            <img
              src={coverUrl ?? undefined}
              alt={book.title}
              className="h-full w-full object-cover"
              onError={() => setFailedCoverUrl(coverUrl ?? null)}
            />
          ) : (
            <div
              className="flex h-full w-full flex-col items-center justify-center gap-3 p-4"
              style={{ backgroundColor: coverBg }}
            >
              <BookOpen size={32} className="shrink-0 text-foreground/20" />
              <span
                className="line-clamp-3 text-center text-xs leading-snug text-foreground/50"
                style={{ fontFamily: 'Lora, Georgia, serif' }}
              >
                {book.title}
              </span>
            </div>
          )}
          <span
            className="pointer-events-none absolute inset-y-0 left-0 w-[6px] bg-gradient-to-r from-black/22 via-white/12 to-transparent"
            aria-hidden
          />
          <span
            className="pointer-events-none absolute inset-0 bg-gradient-to-br from-white/12 via-transparent to-black/12"
            aria-hidden
          />
          {pct > 0 && (
            <div className="absolute inset-x-2.5 bottom-2.5 h-1 rounded-full bg-black/25">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${pct}%` }}
              />
            </div>
          )}
        </div>

        <div className="px-0.5 pt-3">
          <p className="line-clamp-2 text-[13.5px] font-medium leading-snug text-foreground">
            {book.title}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {pct >= 99 ? (
              <span className="rounded-full bg-muted px-2 py-px text-[10.5px] font-medium text-foreground">Finished</span>
            ) : pct > 0 ? (
              <span className="rounded-full bg-muted px-2 py-px text-[10.5px] font-medium text-foreground">{pct}%</span>
            ) : null}
            {book.pageCount > 0 && (
              <span className="text-[11px] text-muted-foreground">{book.pageCount}p</span>
            )}
            {book.highlightCount > 0 && (
              <span className="text-[11px] text-muted-foreground">· {book.highlightCount} notes</span>
            )}
          </div>
        </div>
      </Link>

      {/* Delete — always visible on mobile (low opacity), hover-only on desktop */}
      <button
        onClick={(e) => { e.preventDefault(); onDelete(book.id) }}
        className={cn(
          'absolute top-1.5 right-1.5 z-[1] w-5 h-5 rounded-full',
          'flex items-center justify-center',
          'bg-black/40',
          'opacity-35 sm:opacity-0 group-hover:opacity-100 transition-opacity',
          'text-white',
        )}
        aria-label="Delete book"
      >
        <X size={10} strokeWidth={2.5} />
      </button>
    </div>
  )
}

export function LibraryRoute() {
  const [search, setSearch]   = useState('')
  const [filter, setFilter]   = useState<FilterType>('all')
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const { data: books = [], isLoading, error } = useBooks()
  const queryClient = useQueryClient()
  const localProgress = loadProgress()

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/books/${id}`),
    onSuccess: (_data, id) => {
      void deleteStoredCover(id)
      queryClient.removeQueries({ queryKey: ['book-cover', id] })
      queryClient.invalidateQueries({ queryKey: ['books'] })
      setDeleteId(null)
    },
  })

  const q = search.toLowerCase()

  const filtered = books.filter((b) => {
    if (q && !b.title.toLowerCase().includes(q) && !b.excerpt.toLowerCase().includes(q)) return false
    const p = b.readingProgress ?? localProgress[b.id]
    const pct = readPct(p)
    if (filter === 'reading')  return pct > 0 && pct < 99
    if (filter === 'finished') return pct >= 99
    if (filter === 'unread')   return pct === 0
    return true
  })

  const bookToDelete = books.find((b) => b.id === deleteId)

  return (
    <div className="relative min-h-full">
    <WordParticles />
    <div className="relative z-10 p-6 pb-8 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-[22px] font-semibold text-foreground tracking-tight">Library</h1>
        <Link to="/upload">
          <Button size="sm" className="gap-1.5">
            <span className="text-base leading-none">+</span> Add book
          </Button>
        </Link>
      </div>
      <p className="text-[13px] text-muted-foreground mb-5">
        Everything you've brought in. Drag a PDF anywhere to add.
      </p>

      {/* Toolbar: search + filter chips */}
      <div className="flex items-center gap-3 mb-5 flex-wrap">
        <div className="relative flex-1 min-w-[160px] max-w-[300px]">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search books…"
            className={cn(
              'w-full h-[34px] pl-8 pr-3 text-[13px] rounded-lg',
              'border border-border bg-background text-foreground placeholder:text-muted-foreground',
              'outline-none focus:border-primary focus:ring-[3px] focus:ring-primary/25 transition',
            )}
          />
        </div>

        <div className="flex items-center gap-1.5">
          {FILTER_LABELS.map(({ id, label }) => (
            <button
              key={id}
              onClick={() => setFilter(id)}
              className={cn(
                'px-3 py-1 text-[12.5px] rounded-full border transition-colors cursor-pointer',
                filter === id
                  ? 'bg-foreground text-background border-foreground'
                  : 'bg-background text-foreground border-border hover:border-foreground/30',
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Grid */}
      {isLoading ? (
        <div className="grid grid-cols-2 gap-x-5 gap-y-8 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {Array.from({ length: 12 }).map((_, i) => (
            <div
              key={i}
              className="aspect-[2/3] animate-pulse rounded-[11px] bg-muted shadow-[0_10px_24px_-8px_rgba(15,18,24,0.18)]"
            />
          ))}
        </div>
      ) : error ? (
        <p className="text-sm text-destructive">Failed to load library.</p>
      ) : filtered.length === 0 && !search && filter === 'all' ? (
        <div className="grid grid-cols-2 gap-x-5 gap-y-8 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          <UploadCard />
        </div>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground py-16 text-center">
          {search ? 'No books match your search.' : `No ${filter} books.`}
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-x-5 gap-y-8 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {filtered.map((book, i) => (
            <BookCard
              key={book.id}
              book={book}
              index={i}
              progress={book.readingProgress ?? localProgress[book.id]}
              onDelete={setDeleteId}
            />
          ))}
          {filter === 'all' && !search && <UploadCard />}
        </div>
      )}

      {/* Delete dialog */}
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
            <Button variant="outline" onClick={() => setDeleteId(null)}>Cancel</Button>
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
    </div>
  )
}

function UploadCard() {
  return (
    <Link to="/upload">
      <div className={cn(
        'aspect-[2/3] rounded-[11px] border-2 border-dashed border-border',
        'flex flex-col items-center justify-center gap-2.5',
        'text-muted-foreground cursor-pointer transition-all',
        'shadow-[0_8px_20px_-10px_rgba(15,18,24,0.18)]',
        'hover:border-primary/50 hover:text-primary hover:bg-primary/[0.03]',
        'hover:-translate-y-1 hover:shadow-[0_14px_28px_-12px_rgba(15,18,24,0.22)]',
      )}>
        <Upload size={26} strokeWidth={1.75} />
        <span className="text-[12px] font-medium">Drop a PDF here</span>
      </div>
    </Link>
  )
}
