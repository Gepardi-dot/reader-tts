import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, Loader2, Volume2 } from 'lucide-react'
import { getStoredUser } from '@/lib/auth'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { request } from '@/shared/api/client'
import {
  DEFAULT_KOKORO_VOICE,
  KOKORO_VOICE_CATALOG,
  KOKORO_VOICE_PREVIEW_TEXT,
  type KokoroVoiceOption,
} from '@/features/reader/kokoroVoices'
import { commitKokoroVoiceChoice, savedKokoroVoice } from '@/features/reader/voiceOnboarding'
import { warmHostedKokoro } from '@/features/studio/studioVoice'

type PreviewState = 'idle' | 'loading' | 'playing' | 'error'

export function VoiceOnboardingRoute() {
  const navigate = useNavigate()
  const user = getStoredUser()
  const [selected, setSelected] = useState<string>(
    () => savedKokoroVoice() ?? DEFAULT_KOKORO_VOICE,
  )
  const [previewing, setPreviewing] = useState<string | null>(null)
  const [previewState, setPreviewState] = useState<PreviewState>('idle')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const previewGen = useRef(0)

  const female = useMemo(
    () => KOKORO_VOICE_CATALOG.filter((v) => v.gender === 'female'),
    [],
  )
  const male = useMemo(
    () => KOKORO_VOICE_CATALOG.filter((v) => v.gender === 'male'),
    [],
  )

  function stopPreviewAudio() {
    const audio = audioRef.current
    if (audio) {
      try {
        audio.pause()
        audio.removeAttribute('src')
        audio.load()
      } catch { /* ignore */ }
      audioRef.current = null
    }
  }

  useEffect(() => {
    // Warm Fly while they browse voices so Continue + first Play feel instant.
    warmHostedKokoro()
    return () => {
      previewGen.current += 1
      stopPreviewAudio()
    }
  }, [])

  async function playPreview(voice: KokoroVoiceOption) {
    const gen = ++previewGen.current
    stopPreviewAudio()
    setSelected(voice.id)
    setPreviewing(voice.id)
    setPreviewState('loading')
    setError(null)

    try {
      const result = await request<{ audioUrl: string }>('/api/providers/test', {
        method: 'POST',
        body: JSON.stringify({
          provider: 'kokoro',
          voice: voice.id,
          text: KOKORO_VOICE_PREVIEW_TEXT,
          length_scale: 1,
          sentence_silence: 0.08,
        }),
      })
      if (gen !== previewGen.current) return

      const audio = new Audio(result.audioUrl)
      audioRef.current = audio
      setPreviewState('playing')
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          audio.removeEventListener('ended', onEnded)
          audio.removeEventListener('error', onError)
          resolve()
        }
        const onEnded = () => done()
        const onError = () => {
          audio.removeEventListener('ended', onEnded)
          audio.removeEventListener('error', onError)
          reject(new Error('preview failed'))
        }
        audio.addEventListener('ended', onEnded)
        audio.addEventListener('error', onError)
        void audio.play().catch(reject)
      })
      if (gen === previewGen.current) {
        setPreviewState('idle')
        setPreviewing(null)
      }
    } catch {
      if (gen === previewGen.current) {
        setPreviewState('error')
        setPreviewing(null)
        setError('Could not play that sample. You can still continue — try again later in Audio settings.')
      }
    }
  }

  function handleContinue() {
    if (!user?.id) {
      navigate('/login', { replace: true })
      return
    }
    setSaving(true)
    setError(null)
    try {
      const voice = commitKokoroVoiceChoice(user.id, selected)
      // Re-warm with the committed voice so practice/reader caches align.
      warmHostedKokoro()
      // Fire a background prefetch of a short line for the chosen voice (best-effort).
      void request('/api/providers/test', {
        method: 'POST',
        body: JSON.stringify({
          provider: 'kokoro',
          voice,
          text: 'Ready.',
          length_scale: 1,
          sentence_silence: 0.02,
        }),
      }).catch(() => undefined)
      navigate('/library', { replace: true })
    } catch {
      setError('Could not save your voice. Please try again.')
      setSaving(false)
    }
  }

  function VoiceCard({ voice }: { voice: KokoroVoiceOption }) {
    const isSelected = selected === voice.id
    const isThisPreview = previewing === voice.id
    return (
      <button
        type="button"
        onClick={() => void playPreview(voice)}
        className={cn(
          'group relative flex w-full flex-col items-start gap-1 rounded-xl border px-3.5 py-3 text-left transition-all',
          'hover:border-primary/40 hover:bg-primary/5',
          isSelected
            ? 'border-primary bg-primary/8 ring-2 ring-primary/25'
            : 'border-border bg-card',
        )}
      >
        <div className="flex w-full items-center justify-between gap-2">
          <span className="text-sm font-semibold text-foreground">{voice.label}</span>
          <span className="flex items-center gap-1.5">
            {voice.recommended && (
              <Badge variant="secondary" className="h-4 px-1.5 text-[9px]">
                Popular
              </Badge>
            )}
            {isSelected && (
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                <Check size={12} strokeWidth={3} />
              </span>
            )}
          </span>
        </div>
        <span className="text-xs text-muted-foreground">{voice.style}</span>
        <span className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-primary/80">
          {isThisPreview && previewState === 'loading' ? (
            <>
              <Loader2 size={12} className="animate-spin" />
              Loading…
            </>
          ) : isThisPreview && previewState === 'playing' ? (
            <>
              <Volume2 size={12} />
              Playing…
            </>
          ) : (
            <>
              <Volume2 size={12} />
              Tap to preview
            </>
          )}
        </span>
      </button>
    )
  }

  return (
    <div className="flex min-h-svh items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-lg space-y-6">
        <div className="text-center">
          <span className="text-3xl" aria-hidden>🎙️</span>
          <h1
            className="mt-2 text-2xl font-semibold tracking-tight text-foreground"
            style={{ fontFamily: '"Playfair Display", Georgia, serif' }}
          >
            Choose your reading voice
          </h1>
          <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
            Used for books, practice words, and offline Kokoro.
            Prefetch and cache stay locked to this voice so Play stays fast.
          </p>
        </div>

        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground px-0.5">
            Female
          </h2>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {female.map((v) => (
              <VoiceCard key={v.id} voice={v} />
            ))}
          </div>
        </section>

        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground px-0.5">
            Male
          </h2>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {male.map((v) => (
              <VoiceCard key={v.id} voice={v} />
            ))}
          </div>
        </section>

        {error && (
          <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}

        <div className="space-y-2">
          <Button
            className="w-full"
            size="lg"
            disabled={saving || !selected}
            onClick={handleContinue}
          >
            {saving ? 'Saving…' : 'Continue with this voice'}
          </Button>
          <p className="text-center text-[11px] text-muted-foreground">
            You can change this anytime in Audio settings.
          </p>
        </div>
      </div>
    </div>
  )
}
