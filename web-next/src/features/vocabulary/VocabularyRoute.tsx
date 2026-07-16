import { useState, useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Layers, LayoutGrid, AlignLeft, ChevronDown, ChevronUp } from 'lucide-react'
import { api } from '@/shared/api/client'
import {
  formatStudyDefinition,
  isFabricatedContextSentence,
  isNicheDomainDefinition,
  isRealBookSentence,
  lookupWordDefinition,
  shouldRefreshDefinition,
} from '@/shared/storage/dictionaryLookup'
import { isUsableDefinition } from '@/features/studio/vocabUtils'

type CardState = 'new' | 'learning' | 'review' | 'relearning'
type Layout = 'grid' | 'list'
type StageFilter = 'all' | 'new' | 'learning' | 'review'

interface DeckSummary {
  id: string
  title: string
  dueNow: number
  noteCount?: number
  cardCount?: number
}

interface VocabNoteCard {
  id: string
  state: CardState
  dueAt: string
  reps: number
  scheduledDays: number
}

interface VocabNote {
  id: string
  front: string
  back: string | null
  extra: string | null
  explanation: string | null
  exampleSentence?: string | null
  topic: string | null
  sourceBookId: string | null
  sourceBookTitle: string | null
  metadata: {
    dictionarySource?: string | null
    context?: string | null
    rankedDefinition?: boolean
    partOfSpeech?: string | null
  } | null
  cards: VocabNoteCard[]
}

interface DeckDashboard {
  deck: DeckSummary
  notes: VocabNote[]
  analytics?: {
    rollingRetention7d?: number | null
    studyStreak?: number | null
  }
}

const DUE_COLOR = '#fbc12a'

const STAGE_STYLE: Record<CardState, { pill: string; text: string; ring: string }> = {
  new:        { pill: '#eff6ff', text: '#2563eb', ring: '#2563eb' },
  learning:   { pill: '#fff7e0', text: '#fbc12a', ring: '#fbc12a' },
  review:     { pill: '#f0fdf4', text: '#16a34a', ring: '#16a34a' },
  relearning: { pill: '#fff1f2', text: '#dc2626', ring: '#f43f5e' },
}

function ringFill(state: CardState, due: boolean): number {
  if (state === 'new') return -1           // -1 = no ring
  if (state === 'learning' || state === 'relearning') return 0.65
  if (state === 'review') return due ? 0.92 : 0   // outline only when not due
  return 0
}

function noteState(note: VocabNote): CardState {
  const card = note.cards?.[0]
  if (!card) return 'new'
  const s = card.state
  return s === 'relearning' ? 'learning' : s
}

function isDue(note: VocabNote): boolean {
  const card = note.cards?.[0]
  if (!card) return false
  return new Date(card.dueAt) <= new Date()
}

function StageRing({ state, due }: { state: CardState; due: boolean }) {
  const fill = ringFill(state, due)
  const color = STAGE_STYLE[state].ring

  // NEW state: no ring, just DUE badge if due
  if (fill === -1) {
    return due ? (
      <span style={{ fontSize: 10, fontWeight: 800, color: DUE_COLOR, letterSpacing: '0.06em', marginTop: 2, flexShrink: 0 }}>DUE</span>
    ) : null
  }

  const r = 18
  const circ = 2 * Math.PI * r
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, flexShrink: 0 }}>
      <svg width={44} height={44} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={22} cy={22} r={r} fill="none" stroke="#e9e9e7" strokeWidth={3.5} />
        {fill > 0 && (
          <circle
            cx={22} cy={22} r={r}
            fill="none"
            stroke={color}
            strokeWidth={3.5}
            strokeDasharray={`${fill * circ} ${circ}`}
            strokeLinecap="round"
          />
        )}
      </svg>
      {due && (
        <span style={{ fontSize: 10, fontWeight: 800, color: DUE_COLOR, letterSpacing: '0.06em', lineHeight: 1 }}>DUE</span>
      )}
    </div>
  )
}

function StagePill({ state }: { state: CardState }) {
  const s = STAGE_STYLE[state]
  const label = state === 'relearning' ? 'LEARNING' : state.toUpperCase()
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      padding: '5px 13px', borderRadius: 99,
      background: s.pill, color: s.text,
      fontSize: 11, fontWeight: 700, letterSpacing: '0.07em',
      border: `1px solid ${s.text}33`,
    }}>
      {label}
    </span>
  )
}

function displayDefinition(note: VocabNote): string | null {
  for (const candidate of [note.back, note.explanation, note.extra]) {
    if (!candidate) continue
    if (candidate.startsWith('/')) continue // phonetic
    if (isUsableDefinition(candidate, note.front)) return candidate.trim()
  }
  return null
}

function WordCard({ note, lookingUp }: { note: VocabNote; lookingUp?: boolean }) {
  // Hide glosses by default so browsing Words doesn't spoil Practice.
  const [showDef, setShowDef] = useState(false)
  const def = displayDefinition(note)
  const phonetic = note.extra && note.extra.startsWith('/') ? note.extra : null
  const state = noteState(note)
  const due = isDue(note)
  const book = note.sourceBookTitle ?? note.topic ?? null

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => { if (def) setShowDef((v) => !v) }}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && def) {
          e.preventDefault()
          setShowDef((v) => !v)
        }
      }}
      title={def ? (showDef ? 'Hide definition' : 'Show definition') : undefined}
      style={{
        background: '#fbfdfe',
        border: '1px solid #e4ecf5',
        borderRadius: 14,
        padding: '18px 18px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        cursor: def ? 'pointer' : 'default',
        boxShadow: '0 1px 2px rgba(15,23,42,0.03)',
        transition: 'box-shadow 0.15s, border-color 0.15s',
      }}
      onMouseEnter={(e) => {
        const el = e.currentTarget as HTMLDivElement
        el.style.boxShadow = '0 2px 10px rgba(37,99,235,0.07)'
        el.style.borderColor = '#d4e0ee'
      }}
      onMouseLeave={(e) => {
        const el = e.currentTarget as HTMLDivElement
        el.style.boxShadow = '0 1px 2px rgba(15,23,42,0.03)'
        el.style.borderColor = '#e4ecf5'
      }}
    >
      {/* Top row: word + ring */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <p style={{ fontFamily: 'Lora, Georgia, serif', fontSize: 19, fontWeight: 700, color: '#1a1a2e', lineHeight: 1.25, margin: 0, letterSpacing: '-0.01em' }}>
            {note.front}
          </p>
          {phonetic && (
            <p style={{ fontSize: 12, color: '#6b7280', fontFamily: '"SF Mono", "JetBrains Mono", Consolas, monospace', marginTop: 4, lineHeight: 1 }}>{phonetic}</p>
          )}
        </div>
        <StageRing state={state} due={due} />
      </div>

      {/* Definition hidden until tap — keeps Practice from being spoiled */}
      {def ? (
        showDef ? (
          <p style={{ fontSize: 13.5, color: '#374151', lineHeight: 1.6, margin: 0 }} className="line-clamp-4">
            {def}
          </p>
        ) : (
          <p style={{ fontSize: 12.5, color: '#6b7280', lineHeight: 1.5, margin: 0 }}>
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '4px 10px', borderRadius: 99,
              background: 'rgba(37,99,235,0.08)', color: '#2563eb', fontWeight: 600, fontSize: 12,
            }}>
              Ready · tap to show definition
            </span>
          </p>
        )
      ) : lookingUp ? (
        <p style={{ fontSize: 12.5, color: '#9ca3af', lineHeight: 1.5, margin: 0, fontStyle: 'italic' }}>
          Looking up definition…
        </p>
      ) : (
        <p style={{ fontSize: 12.5, color: '#d97706', lineHeight: 1.5, margin: 0 }}>
          No definition yet — will fill in automatically
        </p>
      )}

      {/* Bottom row: stage pill + book */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginTop: 0, minWidth: 0 }}>
        <StagePill state={state} />
        {book && (
          note.sourceBookId && note.sourceBookTitle ? (
            <Link
              to={`/book/${note.sourceBookId}`}
              title={note.sourceBookTitle}
              onClick={(e) => e.stopPropagation()}
              style={{ fontSize: 12, color: '#9ca3af', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 160, textAlign: 'right', textDecoration: 'none', flexShrink: 1, minWidth: 0 }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.color = '#374151' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.color = '#9ca3af' }}
            >
              {book}
            </Link>
          ) : (
            <span title={book} style={{ fontSize: 12, color: '#9ca3af', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 160, textAlign: 'right', flexShrink: 1, minWidth: 0 }}>
              {book}
            </span>
          )
        )}
      </div>
    </div>
  )
}

function WordRow({
  note,
  expanded,
  onToggle,
  isLast,
  lookingUp,
}: {
  note: VocabNote
  expanded: boolean
  onToggle: () => void
  isLast: boolean
  lookingUp?: boolean
}) {
  const def = displayDefinition(note)
  const state = noteState(note)
  return (
    <div
      style={{ borderBottom: isLast ? 'none' : '1px solid #e9e9e7', background: expanded ? '#fafaf9' : '#fff' }}
    >
      <button
        onClick={onToggle}
        className="w-full px-4 py-3 flex items-center gap-2.5 cursor-pointer border-0 bg-transparent text-left"
      >
        <span style={{ fontFamily: 'Lora, Georgia, serif', fontSize: 14, fontWeight: 600, color: '#37352f', minWidth: 130 }}>
          {note.front}
        </span>
        <StagePill state={state} />
        <div className="ml-auto flex items-center gap-2 shrink-0">
          {note.sourceBookTitle && (
            <span className="text-[11px] text-[#9b9a97] max-w-[140px] truncate hidden sm:block">{note.sourceBookTitle}</span>
          )}
          {expanded ? <ChevronUp size={13} className="text-muted-foreground" /> : <ChevronDown size={13} className="text-muted-foreground" />}
        </div>
      </button>
      {expanded && (
        <div className="px-4 pb-3 space-y-1">
          {def ? (
            <p className="text-[13px] text-[#374151] leading-[1.6]">{def}</p>
          ) : lookingUp ? (
            <p className="text-[12.5px] text-[#9b9a97] italic">Looking up definition…</p>
          ) : (
            <p className="text-[12.5px] text-amber-600">No definition yet</p>
          )}
          {note.topic && <p className="text-[11px] text-[#9b9a97]/60">{note.topic}</p>}
          {def && (
            <p className="text-[11px] text-[#9b9a97]">Hidden by default on cards so Practice stays fair.</p>
          )}
        </div>
      )}
    </div>
  )
}

function SkeletonCard() {
  return <div className="h-36 rounded-[14px] bg-muted animate-pulse" />
}

const STAGE_FILTERS: { key: StageFilter; label: string }[] = [
  { key: 'all',      label: 'All' },
  { key: 'new',      label: 'New' },
  { key: 'learning', label: 'Learning' },
  { key: 'review',   label: 'Review' },
]

export function VocabularyRoute() {
  const [search, setSearch] = useState('')
  const [layout, setLayout] = useState<Layout>('grid')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [stageFilter, setStageFilter] = useState<StageFilter>('all')
  const queryClient = useQueryClient()

  const { data: decks = [], isLoading: decksLoading } = useQuery({
    queryKey: ['decks'],
    queryFn: async () => {
      try {
        const res = await api.get<{ items: DeckSummary[] }>('/api/vocabulary/decks')
        return res.items ?? []
      } catch { return [] }
    },
  })

  const deck = decks[0]

  const { data: dashboard, isLoading: dashLoading } = useQuery({
    queryKey: ['deck-dashboard', deck?.id],
    queryFn: () => api.get<DeckDashboard>(`/api/vocabulary/decks/${deck!.id}`),
    enabled: Boolean(deck?.id),
  })

  // Backfill missing definitions via Worker dictionary API (COEP-safe).
  // Only mark "done" after success or a hard miss — transient failures can retry.
  // Important: do NOT re-run this effect when notes update mid-fill (that cancelled the
  // loop after the first success and left the rest on "No definition yet").
  const filledOkRef = useRef(new Set<string>())
  const hardMissRef = useRef(new Set<string>())
  const backfillGenRef = useRef(0)
  const [lookingUpIds, setLookingUpIds] = useState<Set<string>>(() => new Set())
  const [backfillPass, setBackfillPass] = useState(0)
  const dashboardReady = Boolean(dashboard?.notes && deck?.id)
  const hasMissingDefs = Boolean(
    dashboard?.notes?.some((n) => {
      if (n.front.trim().split(/\s+/).length !== 1) return false
      return !displayDefinition(n)
    }),
  )

  useEffect(() => {
    if (!dashboardReady || !deck?.id || !hasMissingDefs) return

    const deckId = deck.id
    const gen = ++backfillGenRef.current
    const isActive = () => backfillGenRef.current === gen

    const refresh = async () => {
      const dash = queryClient.getQueryData<DeckDashboard>(['deck-dashboard', deckId])
      if (!dash?.notes) return

      const stale = dash.notes.filter((n) => {
        if (filledOkRef.current.has(n.id) || hardMissRef.current.has(n.id)) return false
        const current = n.back || n.explanation
        const fakeSentence = isFabricatedContextSentence(n.exampleSentence, n.front, current)
        return shouldRefreshDefinition(current, n.front) || fakeSentence
      })
      if (stale.length === 0) return

      setLookingUpIds((prev) => {
        const next = new Set(prev)
        for (const n of stale) next.add(n.id)
        return next
      })

      let refreshed = 0
      try {
        // Small concurrency: faster fill without hammering Free Dictionary.
        const CONCURRENCY = 3
        let cursor = 0
        const workers = Array.from({ length: Math.min(CONCURRENCY, stale.length) }, async () => {
          while (cursor < stale.length && isActive()) {
            const index = cursor
            cursor += 1
            const note = stale[index]
            try {
              const metaContext = typeof note.metadata?.context === 'string' ? note.metadata.context : null
              const rawContext = note.exampleSentence || metaContext
              const context = rawContext
                && isRealBookSentence(rawContext, note.front, note.back || note.explanation)
                ? rawContext
                : (metaContext && isRealBookSentence(metaContext, note.front, note.back || note.explanation)
                  ? metaContext
                  : null)

              const hit = await lookupWordDefinition(note.front, { context })
              if (!isActive()) return
              if (!hit || !isUsableDefinition(hit.definition, note.front)) {
                hardMissRef.current.add(note.id)
                if (isFabricatedContextSentence(note.exampleSentence, note.front, note.back)) {
                  await api.post(`/api/vocabulary/decks/${deckId}/notes`, {
                    noteType: 'basic',
                    front: note.front,
                    back: note.back,
                    exampleSentence: '',
                    metadata: { ...(note.metadata ?? {}), clearedFabricatedContext: true },
                  }).catch(() => {})
                }
                continue
              }
              // Accept ranked Free Dict hits; only skip true placeholders/niche garbage.
              if (shouldRefreshDefinition(hit.definition, note.front) && isNicheDomainDefinition(hit.definition)) {
                hardMissRef.current.add(note.id)
                continue
              }

              const definition = formatStudyDefinition(hit.definition, hit.partOfSpeech)
              const nextSentence = context
                || (hit.example && isRealBookSentence(hit.example, note.front, definition) ? hit.example : '')
                || ''

              await api.post(`/api/vocabulary/decks/${deckId}/notes`, {
                noteType: 'basic',
                front: note.front,
                back: definition,
                extra: hit.pronunciation ?? note.extra,
                exampleSentence: nextSentence,
                topic: note.topic ?? 'Reading',
                metadata: {
                  ...(note.metadata ?? {}),
                  dictionarySource: hit.source === 'online' ? 'worker-dictionary' : 'local-seed-ranked',
                  rankedDefinition: true,
                  partOfSpeech: hit.partOfSpeech,
                  bookId: note.sourceBookId,
                  clearedFabricatedContext: true,
                },
              })
              if (!isActive()) return

              filledOkRef.current.add(note.id)
              refreshed += 1
              queryClient.setQueryData<DeckDashboard>(['deck-dashboard', deckId], (prev) => {
                if (!prev) return prev
                return {
                  ...prev,
                  notes: prev.notes.map((n) => (
                    n.id === note.id
                      ? {
                          ...n,
                          back: definition,
                          extra: hit.pronunciation ?? n.extra,
                          exampleSentence: nextSentence || null,
                          metadata: {
                            ...(n.metadata ?? {}),
                            dictionarySource: hit.source === 'online' ? 'worker-dictionary' : 'local-seed-ranked',
                            rankedDefinition: true,
                            partOfSpeech: hit.partOfSpeech,
                            clearedFabricatedContext: true,
                          },
                        }
                      : n
                  )),
                }
              })
            } catch {
              // Network/SQL blip — leave out of filledOk/hardMiss so a later pass can retry.
            } finally {
              if (isActive()) {
                setLookingUpIds((prev) => {
                  const next = new Set(prev)
                  next.delete(note.id)
                  return next
                })
              }
            }
          }
        })
        await Promise.all(workers)
      } finally {
        if (isActive()) setLookingUpIds(new Set())
      }

      if (isActive() && refreshed > 0) {
        void queryClient.invalidateQueries({ queryKey: ['deck-dashboard', deckId] })
        void queryClient.invalidateQueries({ queryKey: ['decks'] })
      }
    }

    void refresh()
    return () => {
      // Invalidate this generation so in-flight work stops applying updates.
      if (backfillGenRef.current === gen) backfillGenRef.current += 1
    }
    // Intentionally omit dashboard.notes: progressive setQueryData must not abort the loop.
  }, [dashboardReady, deck?.id, backfillPass, queryClient, hasMissingDefs])

  const isLoading = decksLoading || (Boolean(deck) && dashLoading)
  const words = (dashboard?.notes ?? []).filter(
    (n) => n.front.trim().split(/\s+/).length === 1,
  )
  const readyCount = words.filter((w) => displayDefinition(w)).length
  const missingDefs = words.length - readyCount

  const filtered = words.filter((w) => {
    if (search && !w.front.toLowerCase().includes(search.toLowerCase())) return false
    if (stageFilter !== 'all') {
      const s = noteState(w)
      if (stageFilter === 'learning' && s !== 'learning') return false
      if (stageFilter === 'new' && s !== 'new') return false
      if (stageFilter === 'review' && s !== 'review') return false
    }
    return true
  })

  return (
    <div className="min-h-svh bg-background pb-24 md:pb-6">
      <div className="px-4 md:px-8 pt-7 pb-5 max-w-[860px] mx-auto">

        {/* Header */}
        <div className="flex items-start justify-between mb-5">
          <div>
            <h1 className="text-[22px] font-semibold text-foreground tracking-tight">Vocabulary</h1>
            <p className="text-[13px] text-muted-foreground mt-1">
              {deck
                ? `${words.length} word${words.length === 1 ? '' : 's'} · ${readyCount} ready · ${deck.dueNow} due`
                : 'Saved words from reading'}
              {missingDefs > 0 && lookingUpIds.size > 0 ? ' · filling definitions…' : ''}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {missingDefs > 0 && (
              <button
                type="button"
                onClick={() => {
                  hardMissRef.current.clear()
                  filledOkRef.current.clear()
                  setBackfillPass((n) => n + 1)
                }}
                disabled={lookingUpIds.size > 0}
                className="h-10 px-4 rounded-xl border border-border bg-white text-[13px] font-medium text-foreground cursor-pointer hover:bg-muted/40 disabled:opacity-50"
              >
                {lookingUpIds.size > 0 ? 'Filling…' : `Fill ${missingDefs} definition${missingDefs === 1 ? '' : 's'}`}
              </button>
            )}
            <Link to="/studio">
              <button className="flex items-center gap-2 h-10 px-5 rounded-xl bg-primary text-primary-foreground text-[13.5px] font-semibold cursor-pointer border-0 hover:opacity-90 transition-opacity shadow-sm">
                {deck && deck.dueNow > 0 ? `Practice · ${deck.dueNow} due` : 'Practice'}
              </button>
            </Link>
          </div>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-3 gap-3 mb-5">
          {[
            { label: 'Total words',   value: words.length || '—' },
            { label: 'With definition', value: readyCount || '—' },
            { label: 'Due to practice', value: deck?.dueNow ?? '—' },
          ].map((s, i) => (
            <div key={i} className="p-4 rounded-[12px] border border-border bg-white">
              <div className="text-[22px] font-bold text-foreground mb-0.5">{s.value}</div>
              <div className="text-[11.5px] text-muted-foreground">{s.label}</div>
            </div>
          ))}
        </div>

        {/* Search + stage filter + layout toggle (wraps on mobile) */}
        <div className="flex flex-wrap items-center gap-2 sm:gap-3 mb-5">
          <div className="relative w-full sm:flex-1 sm:min-w-0 order-1">
            <svg
              className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
              style={{ color: 'var(--muted-foreground)' }}
              width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
            >
              <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
            </svg>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search words..."
              className="w-full h-[38px] pl-9 pr-3 border border-border rounded-xl text-[13px] outline-none focus:border-primary transition-colors bg-white"
            />
          </div>

          <div className="flex gap-1.5 shrink-0 order-2 flex-1 sm:flex-initial overflow-x-auto">
            {STAGE_FILTERS.map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setStageFilter(key)}
                className="px-3.5 py-1.5 rounded-lg text-[12.5px] font-medium cursor-pointer transition-colors"
                style={{
                  background: stageFilter === key ? '#37352f' : '#fff',
                  color: stageFilter === key ? '#fff' : '#6b7280',
                  border: `1px solid ${stageFilter === key ? '#37352f' : '#e5e7eb'}`,
                }}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex gap-0.5 shrink-0 order-3 ml-auto sm:ml-0">
            {([['grid', LayoutGrid], ['list', AlignLeft]] as [Layout, typeof LayoutGrid][]).map(([k, Icon]) => (
              <button
                key={k}
                onClick={() => setLayout(k)}
                className="w-8 h-8 rounded flex items-center justify-center border-0 cursor-pointer transition-colors"
                style={{ background: layout === k ? '#efefef' : 'transparent' }}
              >
                <Icon size={15} style={{ color: layout === k ? 'var(--foreground)' : 'var(--muted-foreground)' }} />
              </button>
            ))}
          </div>
        </div>

        {/* Content */}
        {isLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {Array.from({ length: 6 }).map((_, i) => <SkeletonCard key={i} />)}
          </div>
        ) : words.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-6 py-24 text-center">
            <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center mb-4">
              <Layers size={28} className="text-muted-foreground/50" />
            </div>
            <p className="font-medium text-foreground mb-1">No words yet</p>
            <p className="text-[13px] text-muted-foreground max-w-xs">
              Select a word while reading and tap <strong>Vocabulary</strong> to save it here.
            </p>
          </div>
        ) : filtered.length === 0 ? (
          <p className="text-[13px] text-muted-foreground py-8 text-center">No words match your filters.</p>
        ) : layout === 'grid' ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 items-start">
            {filtered.map((w) => (
              <WordCard key={w.id} note={w} lookingUp={lookingUpIds.has(w.id)} />
            ))}
          </div>
        ) : (
          <div className="border border-[#e9e9e7] rounded-[12px] overflow-hidden bg-white">
            {filtered.map((w, i) => (
              <WordRow
                key={w.id}
                note={w}
                lookingUp={lookingUpIds.has(w.id)}
                expanded={expanded === w.id}
                onToggle={() => setExpanded(expanded === w.id ? null : w.id)}
                isLast={i === filtered.length - 1}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
