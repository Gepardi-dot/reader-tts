import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Mic2, Check, Wifi, WifiOff, Loader2, ChevronDown, ChevronUp, Radio } from 'lucide-react'
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
  mode?: string          // 'remote' | 'local' | 'unavailable'
  remoteUrl?: string | null
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

// ── NeuTTS status panel ───────────────────────────────────────────────────────

function NeuTTSPanel({ provider }: { provider: ProviderInfo }) {
  const [expanded, setExpanded] = useState(false)

  const mode = provider.mode ?? 'unavailable'
  const isRemote = mode === 'remote'
  const isLocal  = mode === 'local'
  const isReady  = isRemote || isLocal

  // Health-check the remote server on mount when remote is configured
  const { data: health, isLoading: healthLoading } = useQuery({
    queryKey: ['neutts-health'],
    queryFn: async () => {
      if (!provider.remoteUrl) return null
      try {
        const r = await fetch(`${provider.remoteUrl}/v1/health`)
        return r.ok ? await r.json() : null
      } catch { return null }
    },
    enabled: isRemote,
    staleTime: 30_000,
    retry: false,
  })

  const serverOnline = health?.status === 'ok'
  const loadedModel  = health?.model as string | null | undefined

  const readyVoices  = provider.voices.filter(v => v.ready !== false)
  const pendingVoices = provider.voices.filter(v => v.ready === false)

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      {/* Header */}
      <button
        className="w-full flex items-center justify-between px-4 py-3 text-left"
        onClick={() => setExpanded(e => !e)}
      >
        <div className="flex items-center gap-2.5">
          <Radio size={15} className="text-primary shrink-0" />
          <span className="text-sm font-semibold text-foreground">NeuTTS</span>
          <Badge variant="outline" className="text-[10px] h-4 px-1.5">
            {isRemote ? 'Remote' : isLocal ? 'Local WSL' : 'Not configured'}
          </Badge>
          {isRemote && (
            healthLoading
              ? <Loader2 size={12} className="animate-spin text-muted-foreground" />
              : serverOnline
                ? <Wifi size={13} className="text-green-500" />
                : <WifiOff size={13} className="text-destructive" />
          )}
        </div>
        {expanded ? <ChevronUp size={14} className="opacity-40" /> : <ChevronDown size={14} className="opacity-40" />}
      </button>

      {/* Expanded details */}
      {expanded && (
        <div className="border-t border-border px-4 py-4 space-y-4 text-sm">

          {/* Connection status */}
          {isRemote && (
            <div className="space-y-1.5">
              <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Server</p>
              <div className="flex items-center gap-2">
                {healthLoading
                  ? <span className="text-muted-foreground text-xs">Checking…</span>
                  : serverOnline
                    ? <>
                        <span className="w-2 h-2 rounded-full bg-green-500 shrink-0" />
                        <span className="text-xs text-foreground truncate">{provider.remoteUrl}</span>
                      </>
                    : <>
                        <span className="w-2 h-2 rounded-full bg-destructive shrink-0" />
                        <span className="text-xs text-destructive">Unreachable — check NEUTTS_REMOTE_URL</span>
                      </>
                }
              </div>
              {loadedModel && (
                <p className="text-xs text-muted-foreground">Model: {loadedModel}</p>
              )}
            </div>
          )}

          {!isReady && (
            <div className="rounded-lg bg-muted px-3 py-2.5 text-xs text-muted-foreground space-y-1">
              <p className="font-medium text-foreground">Not configured</p>
              <p>Set <code className="bg-background px-1 rounded">NEUTTS_REMOTE_URL</code> in your Vercel environment
                 to point at a deployed NeuTTS server.</p>
              <p className="mt-1">Or set <code className="bg-background px-1 rounded">NEUTTS_WSL_PYTHON</code> for local WSL use.</p>
            </div>
          )}

          {/* Voice packs */}
          {provider.voices.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
                Voice packs ({readyVoices.length} ready)
              </p>
              <div className="space-y-1.5">
                {provider.voices.map(v => {
                  const ready = v.ready !== false
                  return (
                    <div key={v.id} className="flex items-center justify-between gap-2 py-0.5">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${ready ? 'bg-green-500' : 'bg-amber-400'}`} />
                        <span className="text-xs font-medium text-foreground truncate">
                          {v.label}
                        </span>
                        {v.gender && (
                          <span className="text-[10px] text-muted-foreground shrink-0">{v.gender}</span>
                        )}
                        {v.style && (
                          <span className="text-[10px] text-muted-foreground/60 shrink-0 hidden sm:inline">{v.style}</span>
                        )}
                      </div>
                      {!ready && (
                        <span className="text-[10px] text-amber-500 shrink-0">needs reference.wav</span>
                      )}
                    </div>
                  )
                })}
              </div>

              {pendingVoices.length > 0 && (
                <p className="text-xs text-muted-foreground pt-1">
                  Add a <code className="bg-muted-foreground/10 px-1 rounded">reference.wav</code> recording (15–30 s) and run:
                </p>
              )}
              {pendingVoices.length > 0 && (
                <code className="block text-[10px] bg-muted px-2 py-1.5 rounded text-muted-foreground break-all">
                  python scripts/neutts_sync_voices.py
                </code>
              )}
            </div>
          )}

          {/* Sync reminder */}
          {isReady && readyVoices.length > 0 && (
            <div className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
              To push updated voice packs to the server:
              <code className="block mt-1 text-[10px] break-all">python scripts/neutts_sync_voices.py</code>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Main settings page ────────────────────────────────────────────────────────

export function AudioSettingsRoute() {
  const qc = useQueryClient()

  const { data: res, isLoading } = useQuery({
    queryKey: ['providers'],
    queryFn: () => api.get<ProvidersResponse>('/api/providers'),
  })

  const providers = res?.providers ?? []
  const neuttsProvider = providers.find(p => p.id === 'neutts_local')

  // Simple per-provider local preference (mirrors what the reader uses)
  const [selectedProvider, setSelectedProvider] = useState(
    () => localStorage.getItem('reader-audio-prefs')
      ? JSON.parse(localStorage.getItem('reader-audio-prefs')!).provider ?? 'google'
      : 'google'
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
      // Persist to localStorage (same key the reader reads from)
      const prefs = { provider: selectedProvider, voice: selectedVoice }
      localStorage.setItem('reader-audio-prefs', JSON.stringify(prefs))
      // Also save speed to backend settings if available
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

          {/* NeuTTS status panel — always visible if configured */}
          {neuttsProvider && (
            <>
              <Separator />
              <NeuTTSPanel provider={neuttsProvider} />
            </>
          )}
        </div>
      )}
    </div>
  )
}
