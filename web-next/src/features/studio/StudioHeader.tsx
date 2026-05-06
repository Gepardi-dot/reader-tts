import { useQuery } from '@tanstack/react-query'
import { type CSSProperties } from 'react'
import { api } from '@/shared/api/client'

interface StudioSummary {
  streakDays: number
  xpToday: number
  xpThisWeek: number
  dailyGoal: number
  dailyGoalProgress: number
}

const C = {
  border: 'rgba(0,0,0,0.08)',
  text: '#1a1a1a',
  muted: '#9ca3af',
  mutedHi: '#6b7280',
  gold: '#f47b24',
  blue: '#2563eb',
  green: '#16a34a',
  amber: '#f59e0b',
}

const FONT_UI = '"Inter Variable", Inter, -apple-system, "Helvetica Neue", sans-serif'

function chipStyle(accent: string): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    background: `${accent}10`,
    color: accent,
    border: `1px solid ${accent}30`,
    borderRadius: 99,
    padding: '5px 11px',
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: '0.02em',
    fontFamily: FONT_UI,
    flex: '0 0 auto',
    whiteSpace: 'nowrap',
  }
}

// eslint-disable-next-line react-refresh/only-export-components
export function useStudioSummary(enabled: boolean) {
  return useQuery<StudioSummary>({
    queryKey: ['learning-summary'],
    queryFn: () => api.get<StudioSummary>('/api/vocabulary/learning-summary'),
    enabled,
    staleTime: 30_000,
  })
}

export function StudioHeader({ summary, isLoading }: { summary: StudioSummary | undefined; isLoading: boolean }) {
  if (isLoading && !summary) {
    return (
      <div style={{ display: 'flex', gap: 8, marginBottom: 10, color: C.muted, fontSize: 11.5, fontFamily: FONT_UI }}>
        Loading progress…
      </div>
    )
  }
  if (!summary) return null

  const streakColor = summary.streakDays > 0 ? C.amber : C.muted
  const xpColor = summary.xpToday > 0 ? C.gold : C.muted
  const weekColor = summary.xpThisWeek > 0 ? C.blue : C.muted

  return (
    <div
      style={{
        display: 'flex',
        gap: 6,
        marginBottom: 10,
        flexWrap: 'wrap',
        rowGap: 6,
      }}
      aria-label="Practice progress"
    >
      <span style={chipStyle(streakColor)} title="Consecutive days with at least one review">
        🔥 {summary.streakDays} day{summary.streakDays === 1 ? '' : 's'}
      </span>
      <span style={chipStyle(xpColor)} title="XP earned today">
        +{summary.xpToday} XP today
      </span>
      <span style={chipStyle(weekColor)} title="XP earned in the last 7 days">
        {summary.xpThisWeek} XP / week
      </span>
    </div>
  )
}
