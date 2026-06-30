import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Mic2, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Badge } from '@/components/ui/badge'
import { api } from '@/shared/api/client'

// ── Types ─────────────────────────────────────────────────────────────────────

interface VoiceOption {
  id: string
  label: string
  gender?: string | null
  style?: string | null
  tags?: string[]
  ready?: boolean
}

interface ProviderInfo {
  id: string
  name: string
  available: boolean
  recommended?: boolean
  voices: VoiceOption[]
  defaultVoice?: string | null
  models?: Array<{ id: string; label: string }>
  defaultModel?: string | null
  description?: string
}

interface ProvidersResponse {
  providers: ProviderInfo[]
  defaultNarrationStyle: string
}

// ── Main settings page ────────────────────────────────────────────────────────

export function AudioSettingsRoute() {
  const qc = useQueryClient()

  const { data: res, isLoading } = useQuery({
    queryKey: ['providers'],
    queryFn: () => api.get<ProvidersResponse>('/api/providers'),
  })

  const providers = res?.providers ?? []

  // Simple per-provider local preference (mirrors what the reader uses)
  const [selectedProvider, setSelectedProvider] = useState(
    () => localStorage.getItem('reader-audio-prefs')
      ? JSON.parse(localStorage.getItem('reader-audio-prefs')!).provider ?? 'kokoro'
      : 'kokoro'
  )
  const [selectedVoice, setSelectedVoice] = useState<string | null>(
    () => localStorage.getItem('reader-audio-prefs')
      ? JSON.parse(localStorage.getItem('reader-audio-prefs')!).voice ?? null
      : null
  )
  const [speed, setSpeed] = useState('1.0')
  const [saved, setSaved] = useState(false)

  const currentProvider = providers.find(p => p.id === selectedProvider)
  const availableVoices = currentProvider?.voices ?? []

  const saveMutation = useMutation({
    mutationFn: async () => {
      const prefs = { provider: selectedProvider, voice: selectedVoice }
      localStorage.setItem('reader-audio-prefs', JSON.stringify(prefs))
      try { await api.patch('/api/settings/audio', { speed: parseFloat(speed) }) } catch { /* optional */ }
    },
    onSuccess: () => {
      setSaved(true)
      qc.invalidateQueries({ queryKey: ['providers'] })
      setTimeout(() => setSaved(false), 2000)
    },
  })

  return (
    <div className="p-6 max-w-lg mx-auto">
      <div className="flex items-center gap-3 mb-8">
        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
          <Mic2 size={20} className="text-primary" />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-foreground">Audio Settings</h1>
          <p className="text-sm text-muted-foreground">Voice and playback preferences</p>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-10 rounded bg-muted animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="space-y-6">

          {/* Provider */}
          <div className="space-y-2">
            <Label>TTS Provider</Label>
            <Select value={selectedProvider} onValueChange={(v) => {
              if (v == null) return
              setSelectedProvider(v)
              setSelectedVoice(null)
            }}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {providers.map((p) => (
                  <SelectItem key={p.id} value={p.id} disabled={!p.available}>
                    <span className="flex items-center gap-2">
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 inline-block ${p.available ? 'bg-green-500' : 'bg-muted-foreground/40'}`} />
                      {p.name}
                      {p.recommended && (
                        <Badge variant="secondary" className="text-[9px] h-3.5 px-1">Best</Badge>
                      )}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {currentProvider?.description && (
              <p className="text-xs text-muted-foreground">{currentProvider.description}</p>
            )}
          </div>

          {/* Voice */}
          {availableVoices.length > 0 && (
            <div className="space-y-2">
              <Label>Voice</Label>
              <Select
                value={selectedVoice ?? (currentProvider?.defaultVoice ?? availableVoices[0]?.id ?? '')}
                onValueChange={(v) => v != null && setSelectedVoice(v)}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {availableVoices.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      <span className="flex items-center gap-2">
                        {v.label}
                        {v.gender && <span className="text-[10px] text-muted-foreground">{v.gender}</span>}
                        {v.style  && <span className="text-[10px] text-muted-foreground/60">{v.style}</span>}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <Separator />

          {/* Speed */}
          <div className="space-y-2">
            <Label>Playback Speed</Label>
            <Select value={speed} onValueChange={(v) => v != null && setSpeed(v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {['0.75', '0.9', '1.0', '1.1', '1.25', '1.5', '1.75', '2.0'].map((s) => (
                  <SelectItem key={s} value={s}>{s}× {s === '1.0' ? '(normal)' : ''}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Button
            className="w-full"
            disabled={saveMutation.isPending}
            onClick={() => saveMutation.mutate()}
          >
            {saved ? (
              <span className="flex items-center gap-2"><Check size={16} /> Saved</span>
            ) : saveMutation.isPending ? 'Saving…' : 'Save settings'}
          </Button>
        </div>
      )}
    </div>
  )
}
