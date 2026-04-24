import { useMemo } from 'react'
import { useQuery, useQueries } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { FileText } from 'lucide-react'
import { api } from '@/shared/api/client'

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

interface Entry extends Highlight {
  book: Book
}

const COLORS = [
  { strip: '#fbbf24', bg: '#fffbeb66' },
  { strip: '#fb7185', bg: '#fff1f266' },
  { strip: '#38bdf8', bg: '#f0f9ff66' },
]

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const days = Math.floor(diff / 86_400_000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  return months < 12 ? `${months}mo ago` : `${Math.floor(months / 12)}y ago`
}

function NoteCard({ entry, index }: { entry: Entry; index: number }) {
  const { strip, bg } = COLORS[index % COLORS.length]
  return (
    <Link
      to={`/book/${entry.book.id}?offset=${entry.start}`}
      className="flex gap-0 rounded-xl overflow-hidden border border-[#e9e9e7] bg-white hover:shadow-sm transition-shadow"
    >
      {/* 4px colour strip */}
      <div className="w-1 shrink-0" style={{ background: strip }} />

      {/* Body */}
      <div className="flex-1 px-3 py-2.5" style={{ background: bg }}>
        <p
          className="m-0 text-[13.5px] leading-[1.5] text-[#37352f]"
          style={{ fontFamily: 'Lora, Georgia, serif' }}
        >
          "{entry.text}"
        </p>

        {entry.note && (
          <p
            className="mt-1.5 ml-2.5 pl-2 text-[12px] text-[#6c6c70] leading-snug border-l-2 border-[#e9e9e7]"
          >
            {entry.note}
          </p>
        )}

        <div className="mt-1.5 text-[10px] font-medium text-[#9b9a97]">
          {timeAgo(entry.createdAt)}
        </div>
      </div>
    </Link>
  )
}

function SkeletonCard() {
  return (
    <div className="flex rounded-xl overflow-hidden border border-[#e9e9e7] bg-white">
      <div className="w-1 shrink-0 bg-[#e9e9e7] animate-pulse" />
      <div className="flex-1 px-3 py-2.5 space-y-2">
        <div className="h-3 w-full rounded bg-[#f3f3f1] animate-pulse" />
        <div className="h-3 w-2/3 rounded bg-[#f3f3f1] animate-pulse" />
        <div className="h-2.5 w-10 rounded bg-[#f3f3f1] animate-pulse mt-1" />
      </div>
    </div>
  )
}

export function NotesRoute() {
  const { data: booksRaw, isLoading: booksLoading } = useQuery({
    queryKey: ['books'],
    queryFn: async () => {
      const res = await api.get<{ items: Book[] } | Book[]>('/api/books')
      return Array.isArray(res) ? res : (res as { items: Book[] }).items ?? []
    },
  })

  const booksWithNotes = useMemo(
    () => (booksRaw ?? []).filter((b) => b.highlightCount > 0),
    [booksRaw],
  )

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

  const entries: Entry[] = useMemo(() => {
    return booksWithNotes
      .flatMap((book, i) =>
        (highlightQueries[i]?.data ?? [])
          .filter((h) => h.kind === 'highlight' || h.kind === 'note')
          .map((h) => ({ ...h, book })),
      )
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  }, [booksWithNotes, highlightQueries])

  return (
    <div className="min-h-svh bg-background pb-24 md:pb-6">
      <div className="px-4 pt-6 pb-4">
        <div className="flex items-center justify-between">
          <h1 className="text-[22px] font-semibold text-foreground tracking-tight">Notes</h1>
          {entries.length > 0 && (
            <span className="text-sm text-muted-foreground">{entries.length} entries</span>
          )}
        </div>
        <p className="text-[13px] text-muted-foreground mt-1">
          Highlights and notes from your reading
        </p>
      </div>

      {isLoading ? (
        <div className="px-4 space-y-3">
          {Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)}
        </div>
      ) : entries.length === 0 ? (
        <div className="flex flex-col items-center justify-center px-6 py-24 text-center">
          <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center mb-4">
            <FileText size={28} className="text-muted-foreground/50" />
          </div>
          <p className="font-medium text-foreground mb-1">No notes yet</p>
          <p className="text-[13px] text-muted-foreground max-w-xs">
            Select text in any book and choose <strong>Notes</strong> to save a highlight here.
          </p>
        </div>
      ) : (
        <div className="px-4 space-y-3">
          {entries.map((entry, i) => (
            <NoteCard key={entry.id} entry={entry} index={i} />
          ))}
        </div>
      )}
    </div>
  )
}
