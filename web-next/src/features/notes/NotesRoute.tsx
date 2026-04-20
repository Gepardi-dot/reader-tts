import { useMemo } from 'react'
import { useQuery, useQueries } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { FileText, BookOpen, ArrowRight, ExternalLink } from 'lucide-react'
import { api } from '@/shared/api/client'
import { cn } from '@/lib/utils'

// ── Types matching real API ───────────────────────────
interface Book {
  id: string
  title: string
  highlightCount: number
}

interface Highlight {
  id: string
  start: number
  end: number
  color: 'amber' | 'rose' | 'sky'
  kind: 'highlight' | 'note' | 'vocabulary'
  text: string
  note: string | null
  createdAt: string
}

// ── Colour accents ────────────────────────────────────
const COLOR_BAR: Record<Highlight['color'], string> = {
  amber: 'bg-amber-400',
  rose:  'bg-rose-400',
  sky:   'bg-sky-400',
}

const COLOR_BG: Record<Highlight['color'], string> = {
  amber: 'bg-amber-50',
  rose:  'bg-rose-50',
  sky:   'bg-sky-50',
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const days = Math.floor(diff / 86_400_000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  return months < 12 ? `${months}mo ago` : `${Math.floor(months / 12)}y ago`
}

// ── Skeleton ──────────────────────────────────────────
function Skeleton() {
  return (
    <div className="px-4 space-y-4 pt-2">
      {[1, 2].map((g) => (
        <div key={g} className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="px-4 py-3 border-b border-border bg-muted/40 flex items-center justify-between">
            <div className="h-4 w-40 rounded bg-muted animate-pulse" />
            <div className="h-4 w-16 rounded bg-muted animate-pulse" />
          </div>
          <div className="divide-y divide-border">
            {[1, 2, 3].map((i) => (
              <div key={i} className="flex gap-3 p-4">
                <div className="w-1 rounded-full bg-muted animate-pulse shrink-0" />
                <div className="flex-1 space-y-2">
                  <div className="h-3.5 w-full rounded bg-muted animate-pulse" />
                  <div className="h-3.5 w-4/5 rounded bg-muted animate-pulse" />
                  <div className="h-3 w-16 rounded bg-muted animate-pulse mt-2" />
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Main ──────────────────────────────────────────────
export function NotesRoute() {
  // 1. Fetch all books
  const { data: booksRaw, isLoading: booksLoading } = useQuery({
    queryKey: ['books'],
    queryFn: async () => {
      const res = await api.get<{ items: Book[] } | Book[]>('/api/books')
      return Array.isArray(res) ? res : (res as { items: Book[] }).items ?? []
    },
  })

  // Only query books that actually have highlights
  const booksWithNotes = useMemo(
    () => (booksRaw ?? []).filter((b) => b.highlightCount > 0),
    [booksRaw],
  )

  // 2. Fetch highlights for each relevant book in parallel
  const highlightQueries = useQueries({
    queries: booksWithNotes.map((book) => ({
      queryKey: ['highlights', book.id],
      queryFn: async () => {
        const res = await api.get<{ items: Highlight[] }>(`/api/books/${book.id}/highlights`)
        return res.items ?? []
      },
      staleTime: 30_000,
    })),
  })

  const isLoading = booksLoading || highlightQueries.some((q) => q.isLoading)

  // 3. Group: book → its highlights/notes (skip vocabulary kind)
  const groups = useMemo(() => {
    return booksWithNotes
      .map((book, i) => {
        const entries = (highlightQueries[i]?.data ?? []).filter(
          (h) => h.kind === 'highlight' || h.kind === 'note',
        )
        return { book, entries }
      })
      .filter((g) => g.entries.length > 0)
  }, [booksWithNotes, highlightQueries])

  const totalCount = groups.reduce((n, g) => n + g.entries.length, 0)

  return (
    <div className="min-h-svh bg-background pb-24 md:pb-6">
      {/* ── Header ─────────────────────────────────── */}
      <div className="px-4 pt-6 pb-4">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold text-foreground">Notes</h1>
          {totalCount > 0 && (
            <span className="text-sm text-muted-foreground">{totalCount} entries</span>
          )}
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          Highlights and notes from your reading
        </p>
      </div>

      {/* ── Content ────────────────────────────────── */}
      {isLoading ? (
        <Skeleton />
      ) : groups.length === 0 ? (
        <div className="flex flex-col items-center justify-center px-6 py-24 text-center">
          <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center mb-4">
            <FileText size={28} className="text-muted-foreground/50" />
          </div>
          <p className="font-medium text-foreground mb-1">No notes yet</p>
          <p className="text-sm text-muted-foreground max-w-xs">
            Select text in any book and choose <strong>Notes</strong> to save a highlight here.
          </p>
        </div>
      ) : (
        <div className="px-4 space-y-4">
          {groups.map(({ book, entries }) => (
            <div
              key={book.id}
              className="rounded-xl border border-border bg-card overflow-hidden"
            >
              {/* Book header */}
              <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-muted/30">
                <div className="flex items-center gap-2 min-w-0">
                  <BookOpen size={14} className="text-muted-foreground shrink-0" />
                  <span className="text-sm font-medium text-foreground truncate">
                    {book.title}
                  </span>
                </div>
                <Link
                  to={`/book/${book.id}`}
                  className="flex items-center gap-1 text-xs text-primary shrink-0 ml-3 hover:opacity-70 transition-opacity"
                >
                  Open <ArrowRight size={12} />
                </Link>
              </div>

              {/* Entries */}
              <div className="divide-y divide-border">
                {entries.map((entry) => (
                  <Link
                    key={entry.id}
                    to={`/book/${book.id}?offset=${entry.start}`}
                    className="flex gap-0 min-h-[56px] group hover:brightness-[0.97] transition-[filter] block"
                  >
                    {/* Color strip */}
                    <div
                      className={cn('w-1 shrink-0 self-stretch rounded-l-none', COLOR_BAR[entry.color])}
                    />
                    <div className={cn('flex-1 px-4 py-3', COLOR_BG[entry.color], 'bg-opacity-30')}>
                      {/* Quoted text */}
                      <p
                        className="text-sm text-foreground leading-relaxed"
                        style={{ fontFamily: 'Lora, Georgia, serif' }}
                      >
                        "{entry.text}"
                      </p>
                      {/* Note annotation */}
                      {entry.note && (
                        <p className="text-sm text-muted-foreground mt-1.5 pl-3 border-l-2 border-border">
                          {entry.note}
                        </p>
                      )}
                      {/* Date + jump hint */}
                      <div className="flex items-center justify-between mt-2">
                        <p className="text-[11px] text-muted-foreground">
                          {timeAgo(entry.createdAt)}
                        </p>
                        <span className="flex items-center gap-1 text-[11px] text-primary opacity-0 group-hover:opacity-100 transition-opacity">
                          View in book <ExternalLink size={10} />
                        </span>
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
