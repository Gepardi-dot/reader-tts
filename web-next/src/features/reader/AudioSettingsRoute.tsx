import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Mic2, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Badge } from '@/components/ui/badge'
import { api } from '@/shared/api/client'
import {
  defaultVoiceForProvider,
  displayNameForTtsProvider,
  normalizeTtsProviders,
  type TtsProviderInfo,
} from './audioProviderCatalog'
import {
  audioPrefsWithSelection,
  loadAudioPrefs,
  resolvedVoiceForProvider,
  saveAudioPrefs,
} from './audioPreferences'
import { DEFAULT_KOKORO_VOICE, KOKORO_VOICE_CATALOG } from './kokoroVoices'
import { markVoiceOnboardingComplete } from './voiceOnboarding'
import { getStoredUser } from '@/lib/auth'
import { warmHostedKokoro } from '@/features/studio/studioVoice'

interface ProvidersResponse {
  providers: TtsProviderInfo[]
  defaultNarrationStyle: string
  defaultProvider?: string
}

export function AudioSettingsRoute() {
  const qc = useQueryClient()

  const { data: res, isLoading } = useQuery({
    queryKey: ['providers'],
    queryFn: () => api.get<ProvidersResponse>('/api/providers'),
  })

  const providers = normalizeTtsProviders(res?.providers).map((provider) => {
    // Ensure Kokoro always exposes the full client catalog when API voices are empty/partial.
    if (provider.id !== 'kokoro') return provider
    const byId = new Map(provider.voices.map((v) => [v.id, v]))
    for (const v of KOKORO_VOICE_CATALOG) {
      if (!byId.has(v.id)) byId.set(v.id, { id: v.id, label: v.label })
    }
    return {
      ...provider,
      voices: [...byId.values()],
      defaultVoice: provider.defaultVoice ?? DEFAULT_KOKORO_VOICE,
    }
  })
  const initialPrefs = loadAudioPrefs()

  const [selectedProvider, setSelectedProvider] = useState(
    () => initialPrefs.provider,
  )
  const [selectedVoice, setSelectedVoice] = useState<string | null>(
    () => initialPrefs.voice ?? initialPrefs.voicesByProvider.kokoro ?? DEFAULT_KOKORO_VOICE,
  )
  const [speed, setSpeed] = useState('1.0')
  const [saved, setSaved] = useState(false)

  const currentProvider = providers.find((p) => p.id === selectedProvider)
  const availableVoices = currentProvider?.voices ?? []

  const saveMutation = useMutation({
    mutationFn: async () => {
      const voiceToSave = selectedVoice
        ?? defaultVoiceForProvider(currentProvider)
        ?? DEFAULT_KOKORO_VOICE
      saveAudioPrefs(audioPrefsWithSelection(loadAudioPrefs(), {
        provider: selectedProvider,
        voice: voiceToSave,
      }))
      const userId = getStoredUser()?.id
      if (userId && selectedProvider === 'kokoro') {
        markVoiceOnboardingComplete(userId)
      }
      warmHostedKokoro(true)
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

          <div className="space-y-2">
            <Label>TTS Provider</Label>
            <Select value={selectedProvider} onValueChange={(v) => {
              if (v == null) return
              const nextProvider = providers.find((p) => p.id === v)
              setSelectedProvider(v)
              setSelectedVoice(resolvedVoiceForProvider(v, nextProvider, loadAudioPrefs()))
            }}>
              <SelectTrigger>
                <SelectValue>
                  {displayNameForTtsProvider(selectedProvider, currentProvider?.name)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {providers.map((p) => (
                  <SelectItem key={p.id} value={p.id} disabled={!p.available}>
                    <span className="flex items-center gap-2">
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 inline-block ${p.available ? 'bg-green-500' : 'bg-muted-foreground/40'}`} />
                      {p.name}
                      {p.recommended && (
                        <Badge variant="secondary" className="text-[9px] h-3.5 px-1">Default</Badge>
                      )}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {currentProvider?.description && (
              <p className="text-xs text-muted-foreground">{currentProvider.description}</p>
            )}
            <p className="text-xs text-muted-foreground">
              HR Voices is the default. HR Ultra Realistic is available when configured on the server.
            </p>
          </div>

          {availableVoices.length > 0 && (
            <div className="space-y-2">
              <Label>Voice</Label>
              <Select
                value={selectedVoice ?? (defaultVoiceForProvider(currentProvider) ?? '')}
                onValueChange={(v) => v != null && setSelectedVoice(v)}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {availableVoices.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      {v.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <Separator />

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
