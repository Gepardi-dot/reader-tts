import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Layers } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { api } from '@/shared/api/client'

interface DeckSummary {
  id: string
  title: string
  dueNow: number
}

interface VocabNote {
  id: string
  front: string
  back: string | null
  extra: string | null
  explanation: string | null
  topic: string | null
}

interface DeckDashboard {
  deck: DeckSummary
  notes: VocabNote[]
}

export function VocabularyRoute() {
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

  const isLoading = decksLoading || (Boolean(deck) && dashLoading)
  const words = (dashboard?.notes ?? []).filter(
    (n) => n.front.trim().split(/\s+/).length === 1,
  )

  return (
    <div className="min-h-svh bg-background pb-24 md:pb-6">
      {/* Header */}
      <div className="px-4 pt-6 pb-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Vocabulary</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {deck ? `${deck.dueNow} due · ${words.length} words` : 'Saved words from reading'}
          </p>
        </div>
        {deck && (
          <Link to="/studio">
            <Button size="sm" disabled={deck.dueNow === 0}>
              Practice
            </Button>
          </Link>
        )}
      </div>

      {/* Word grid */}
      {isLoading ? (
        <div className="px-4 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="h-24 rounded-xl bg-muted animate-pulse" />
          ))}
        </div>
      ) : words.length === 0 ? (
        <div className="flex flex-col items-center justify-center px-6 py-24 text-center">
          <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center mb-4">
            <Layers size={28} className="text-muted-foreground/50" />
          </div>
          <p className="font-medium text-foreground mb-1">No words yet</p>
          <p className="text-sm text-muted-foreground max-w-xs">
            Select a word while reading and tap <strong>Vocabulary</strong> to save it here.
          </p>
        </div>
      ) : (
        <div className="px-4 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
          {words.map((word) => (
            <div
              key={word.id}
              className="rounded-xl border border-border bg-card p-3 flex flex-col gap-1.5 min-h-[80px]"
            >
              <p
                className="text-sm font-semibold text-foreground leading-snug"
                style={{ fontFamily: 'Lora, Georgia, serif' }}
              >
                {word.front}
              </p>
              {(word.back ?? word.explanation ?? word.extra) && (
                <p className="text-xs text-muted-foreground leading-snug line-clamp-3">
                  {word.back ?? word.explanation ?? word.extra}
                </p>
              )}
              {word.topic && (
                <p className="text-[10px] text-muted-foreground/50 mt-auto pt-1">{word.topic}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
