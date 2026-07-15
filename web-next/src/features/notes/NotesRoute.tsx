import { useMemo, useState } from 'react'
import { useQuery, useQueries } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { FileText, LayoutGrid, List, GitBranch } from 'lucide-react'
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

type Layout = 'list' | 'grid' | 'timeline'
type ColorKey = 'amber' | 'rose' | 'sky'

const CMAP = {
  amber: { strip: '#fbbf24', bg: '#fffbeb88' },
  rose:  { strip: '#fb7185', bg: '#fff1f288' },
  sky:   { strip: '#38bdf8', bg: '#f0f9ff88' },
} as const

const COLOR_DOTS: { key: ColorKey; hex: string }[] = [
  { key: 'amber', hex: '#fbbf24' },
  { key: 'rose',  hex: '#fb7185' },
  { key: 'sky',   hex: '#38bdf8' },
]

const LAYOUT_BTNS: { key: Layout; Icon: typeof LayoutGrid }[] = [
  { key: 'list',     Icon: List },
  { key: 'grid',     Icon: LayoutGrid },
  { key: 'timeline', Icon: GitBranch },
]

function timeAgo(iso: string) {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 30) return `${days}d ago`
  const m = Math.floor(days / 30)
  return m < 12 ? `${m}mo ago` : `${Math.floor(m / 12)}y ago`
}

function NoteList({ entry, index }: { entry: Entry; index: number }) {
  const { strip, bg } = CMAP[entry.color]
  return (
    <Link
      to={`/book/${entry.book.id}?offset=${entry.start}`}
      className="flex rounded-[10px] overflow-hidden border border-[#e9e9e7] bg-white hover:shadow-sm transition-shadow"
      style={{ animationDelay: `${index * 35}ms` }}
    >
      <div className="w-1 shrink-0" style={{ background: strip }} />
      <div className="flex-1 px-3.5 py-2.5" style={{ background: bg }}>
        <div className="text-[11px] font-medium text-[#9b9a97] mb-1.5">{entry.book.title}</div>
        <p className="text-[13.5px] leading-[1.65] text-[#37352f] italic" style={{ fontFamily: 'Lora, Georgia, serif' }}>
          "{entry.text}"
        </p>
        {entry.note && (
          <p className="mt-2 pl-2.5 border-l-2 border-[#e9e9e7] text-[12px] text-[#9b9a97] leading-snug">
            {entry.note}
          </p>
        )}
        <div className="mt-2 text-[10.5px] font-medium text-[#9b9a97]">{timeAgo(entry.createdAt)}</div>
      </div>
    </Link>
  )
}

function NoteGrid({ entry, index }: { entry: Entry; index: number }) {
  const { strip, bg } = CMAP[entry.color]
  return (
    <Link
      to={`/book/${entry.book.id}?offset=${entry.start}`}
      className="mb-3 inline-block w-full break-inside-avoid rounded-[10px] overflow-hidden border border-[#e9e9e7] bg-white hover:shadow-md transition-shadow"
      style={{ animationDelay: `${index * 35}ms` }}
    >
      <div className="h-1" style={{ background: strip }} />
      <div className="p-3.5" style={{ background: bg }}>
        <div className="text-[10.5px] font-medium text-[#9b9a97] mb-1.5">{entry.book.title}</div>
        <p className="text-[13px] leading-[1.6] text-[#37352f] italic" style={{ fontFamily: 'Lora, Georgia, serif' }}>
          "{entry.text}"
        </p>
        {entry.note && (
          <p className="mt-1.5 text-[11.5px] text-[#9b9a97] leading-[1.45]">{entry.note}</p>
        )}
        <div className="mt-2.5 text-[10px] text-[#9b9a97]">{timeAgo(entry.createdAt)}</div>
      </div>
    </Link>
  )
}

function NoteTimeline({ entries }: { entries: Entry[] }) {
  return (
    <div className="relative pl-6">
      <div className="absolute left-[7px] top-2 bottom-2 w-px bg-[#e9e9e7]" />
      {entries.map((entry) => {
        const { strip, bg } = CMAP[entry.color]
        return (
          <div key={entry.id} className="relative mb-3.5">
            <div
              className="absolute -left-[22px] top-3.5 w-3.5 h-3.5 rounded-full border-2 border-white"
              style={{ background: strip, boxShadow: `0 0 0 1.5px ${strip}` }}
            />
            <Link
              to={`/book/${entry.book.id}?offset=${entry.start}`}
              className="block rounded-[10px] overflow-hidden border border-[#e9e9e7] bg-white hover:shadow-sm transition-shadow"
            >
              <div className="p-3.5" style={{ background: bg }}>
                <div className="flex justify-between items-center mb-1.5">
                  <span className="text-[11px] font-medium text-[#9b9a97]">{entry.book.title}</span>
                  <span className="text-[10px] text-[#9b9a97]">{timeAgo(entry.createdAt)}</span>
                </div>
                <p className="text-[13.5px] leading-[1.65] text-[#37352f] italic" style={{ fontFamily: 'Lora, Georgia, serif' }}>
                  "{entry.text}"
                </p>
                {entry.note && (
                  <p className="mt-2 pl-2.5 border-l-2 border-[#e9e9e7] text-[12px] text-[#9b9a97] leading-snug">
                    {entry.note}
                  </p>
                )}
              </div>
            </Link>
          </div>
        )
      })}
    </div>
  )
}

function SkeletonCard() {
  return (
    <div className="flex rounded-[10px] overflow-hidden border border-[#e9e9e7] bg-white">
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
  const [search, setSearch] = useState('')
  const [colorFilter, setColorFilter] = useState<ColorKey | null>(null)
  const [kind, setKind] = useState<'all' | 'annotation'>('all')
  const [layout, setLayout] = useState<Layout>('grid')

  const { data: booksRaw, isLoading: booksLoading } = useQuery({
    queryKey: ['books'],
    queryFn: async () => {
      const res = await api.get<{ items: Book[] } | Book[]>('/api/books')
      return Array.isArray(res) ? res : (res as { items: Book[] }).items ?? []
    },
  })

  // Prefer books known to have highlights, but always re-check every book so a
  // stale highlightCount (or cache race after save) cannot hide fresh notes.
  const books = useMemo(() => booksRaw ?? [], [booksRaw])

  const highlightQueries = useQueries({
    queries: books.map((book) => ({
      queryKey: ['highlights', book.id],
      queryFn: async () => {
        const res = await api.get<{ items: Highlight[] }>(`/api/books/${book.id}/highlights`)
        return res.items ?? []
      },
      staleTime: 15_000,
      enabled: books.length > 0,
    })),
  })

  const isLoading = booksLoading || (books.length > 0 && highlightQueries.some((q) => q.isLoading || q.isFetching && !q.data))

  const entries: Entry[] = useMemo(() => {
    return books
      .flatMap((book, i) =>
        (highlightQueries[i]?.data ?? [])
          .filter((h) => h.kind === 'highlight' || h.kind === 'note')
          .map((h) => ({
            ...h,
            // Guard against missing/unknown colors from older rows.
            color: (h.color === 'rose' || h.color === 'sky' ? h.color : 'amber') as ColorKey,
            book,
          })),
      )
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  }, [books, highlightQueries])

  const filtered = useMemo(() => entries.filter((e) => {
    if (colorFilter && e.color !== colorFilter) return false
    if (kind === 'annotation' && !e.note) return false
    if (search) {
      const q = search.toLowerCase()
      if (!e.text.toLowerCase().includes(q) && !(e.note ?? '').toLowerCase().includes(q)) return false
    }
    return true
  }), [entries, colorFilter, kind, search])

  return (
    <div className="min-h-svh bg-background pb-24 md:pb-6">
      <div className="px-4 md:px-8 pt-7 pb-5" style={{ maxWidth: 800 }}>

        {/* Header */}
        <div className="flex items-start justify-between mb-5">
          <div>
            <h1 className="text-[22px] font-semibold text-foreground tracking-tight">Notes</h1>
            <p className="text-[13px] text-muted-foreground mt-1">Highlights and notes from your reading</p>
          </div>
          <div className="flex items-center gap-1.5 mt-1">
            {COLOR_DOTS.map(({ key, hex }) => (
              <button
                key={key}
                onClick={() => setColorFilter(colorFilter === key ? null : key)}
                className="rounded-full cursor-pointer transition-all border-0"
                style={{
                  width: 18, height: 18,
                  background: hex,
                  outline: colorFilter === key ? `2px solid ${hex}` : '2px solid transparent',
                  outlineOffset: 2,
                  transform: colorFilter === key ? 'scale(1.2)' : 'scale(1)',
                }}
              />
            ))}
          </div>
        </div>

        {/* Search */}
        <div className="relative mb-3.5">
          <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--muted-foreground)' }} width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
          </svg>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search notes…"
            className="w-full h-[33px] pl-8 pr-3 border border-border rounded-lg text-[13px] text-foreground bg-white outline-none focus:border-primary transition-colors"
          />
        </div>

        {/* Filter pills + layout */}
        <div className="flex gap-1.5 mb-5 items-center">
          {([['all', 'All'], ['annotation', 'With annotation']] as const).map(([k, l]) => (
            <button
              key={k}
              onClick={() => setKind(k)}
              className="px-3 py-1 rounded-full text-[12.5px] font-medium cursor-pointer transition-all border"
              style={{
                background: kind === k ? '#37352f' : '#fff',
                color: kind === k ? '#fff' : '#9b9a97',
                borderColor: kind === k ? '#37352f' : '#e9e9e7',
              }}
            >
              {l}
            </button>
          ))}
          <span className="ml-auto text-[12.5px] text-muted-foreground">{filtered.length} entries</span>
          <div className="flex items-center gap-0.5 ml-2">
            {LAYOUT_BTNS.map(({ key, Icon }) => (
              <button
                key={key}
                onClick={() => setLayout(key)}
                className="w-7 h-7 rounded flex items-center justify-center cursor-pointer border-0 transition-colors"
                style={{ background: layout === key ? '#efefef' : 'transparent' }}
              >
                <Icon size={14} style={{ color: layout === key ? 'var(--foreground)' : 'var(--muted-foreground)' }} />
              </button>
            ))}
          </div>
        </div>

        {/* Content */}
        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)}
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center mb-4">
              <FileText size={28} className="text-muted-foreground/50" />
            </div>
            <p className="font-medium text-foreground mb-1">
              {entries.length === 0 ? 'No notes yet' : 'No notes match'}
            </p>
            <p className="text-[13px] text-muted-foreground max-w-xs">
              {entries.length === 0
                ? 'Select text in any book and choose Notes to save a highlight here.'
                : 'Try adjusting your filters.'}
            </p>
          </div>
        ) : layout === 'grid' ? (
          <div className="columns-1 sm:columns-2 gap-3">
            {filtered.map((e, i) => <NoteGrid key={e.id} entry={e} index={i} />)}
          </div>
        ) : layout === 'timeline' ? (
          <NoteTimeline entries={filtered} />
        ) : (
          <div className="space-y-2.5">
            {filtered.map((e, i) => <NoteList key={e.id} entry={e} index={i} />)}
          </div>
        )}
      </div>
    </div>
  )
}
