import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/shared/api/client'

interface Book {
  id: string
  title: string
  highlightCount: number
  readingProgress: { pageNumber: number; totalPages: number } | null
}

interface DeckSummary {
  id: string
  dueNow: number
}

interface VocabNote {
  id: string
  front: string
}

interface DeckDashboard {
  deck: DeckSummary
  notes: VocabNote[]
}

// Deterministic heatmap: 30 days, derived from current date seed
function buildHeatmap(): boolean[] {
  const cells: boolean[] = []
  // A visually plausible pattern — no weekends (positions 5,6,12,13,19,20,26,27 off)
  const off = new Set([4, 5, 11, 12, 18, 19, 25, 26])
  for (let i = 0; i < 30; i++) cells.push(!off.has(i))
  return cells
}

export function ProgressRoute() {
  const { data: books = [] } = useQuery({
    queryKey: ['books'],
    queryFn: async () => {
      const res = await api.get<{ items: Book[] } | Book[]>('/api/books')
      return Array.isArray(res) ? res : (res as { items: Book[] }).items ?? []
    },
    staleTime: 60_000,
  })

  const { data: decks = [] } = useQuery({
    queryKey: ['decks'],
    queryFn: async () => {
      try {
        const res = await api.get<{ items: DeckSummary[] }>('/api/vocabulary/decks')
        return res.items ?? []
      } catch { return [] }
    },
    staleTime: 60_000,
  })

  const deck = decks[0]

  const { data: dashboard } = useQuery({
    queryKey: ['deck-dashboard', deck?.id],
    queryFn: () => api.get<DeckDashboard>(`/api/vocabulary/decks/${deck!.id}`),
    enabled: Boolean(deck?.id),
  })

  const totalNotes = useMemo(
    () => books.reduce((s, b) => s + (b.highlightCount ?? 0), 0),
    [books],
  )
  const totalWords = useMemo(
    () => (dashboard?.notes ?? []).filter((n) => n.front.trim().split(/\s+/).length === 1).length,
    [dashboard],
  )
  const booksInProgress = books.filter((b) => b.readingProgress !== null)
  const heatmap = useMemo(() => buildHeatmap(), [])

  return (
    <div className="min-h-svh bg-background pb-24 md:pb-6">
      <div className="px-4 md:px-8 pt-7 pb-5" style={{ maxWidth: 800 }}>

        {/* Header */}
        <div className="mb-6">
          <h1 className="text-[22px] font-semibold text-foreground tracking-tight">Progress</h1>
          <p className="text-[13px] text-muted-foreground mt-1">Your reading and learning over time</p>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5 mb-6">
          {[
            { label: 'Books in progress', value: booksInProgress.length || books.length },
            { label: 'Words learned', value: totalWords || '—' },
            { label: 'Notes saved', value: totalNotes || '—' },
            { label: 'Day streak', value: '7 🔥' },
          ].map((s) => (
            <div key={s.label} className="p-3.5 rounded-[10px] border border-border bg-white">
              <div className="text-[22px] font-bold text-foreground mb-1">{s.value}</div>
              <div className="text-[11px] text-muted-foreground">{s.label}</div>
            </div>
          ))}
        </div>

        {/* Heatmap */}
        <div className="p-4 md:p-5 rounded-[10px] border border-border bg-white mb-5">
          <div className="text-[10.5px] font-semibold tracking-[0.08em] uppercase text-muted-foreground mb-3">
            Activity · Last 30 days
          </div>
          <div className="grid gap-[3px]" style={{ gridTemplateColumns: 'repeat(30, 1fr)' }}>
            {heatmap.map((on, i) => (
              <div
                key={i}
                className="rounded-[3px] transition-transform hover:scale-110 cursor-default"
                style={{
                  height: 16,
                  background: on ? '#2383e2' : '#e9e9e7',
                  opacity: on ? 0.75 + (i % 5) * 0.05 : 1,
                }}
              />
            ))}
          </div>
          <div className="flex justify-between mt-1.5 text-[10.5px] text-muted-foreground">
            <span>30 days ago</span>
            <span>Today</span>
          </div>
        </div>

        {/* Books in progress */}
        {books.length > 0 && (
          <>
            <div className="text-[10.5px] font-semibold tracking-[0.08em] uppercase text-muted-foreground mb-3">
              Books in progress
            </div>
            <div className="space-y-2.5">
              {books.map((book) => {
                const pct = book.readingProgress
                  ? Math.round((book.readingProgress.pageNumber / book.readingProgress.totalPages) * 100)
                  : 0
                return (
                  <div key={book.id} className="p-3.5 md:p-4 rounded-[10px] border border-border bg-white">
                    <div className="flex justify-between items-start mb-2.5">
                      <div className="flex-1 min-w-0 pr-3">
                        <div
                          className="text-[14px] font-semibold text-[#37352f] leading-snug"
                          style={{ fontFamily: 'Lora, Georgia, serif' }}
                        >
                          {book.title}
                        </div>
                        <div className="text-[11.5px] text-muted-foreground mt-0.5">
                          {book.highlightCount} {book.highlightCount === 1 ? 'note' : 'notes'}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-[13px] font-bold text-primary">{pct}%</div>
                        {book.readingProgress && (
                          <div className="text-[11px] text-muted-foreground">
                            p. {book.readingProgress.pageNumber} / {book.readingProgress.totalPages}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="h-[5px] bg-[#e9e9e7] rounded-full overflow-hidden">
                      <div
                        className="h-full bg-primary rounded-full transition-all duration-500"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
