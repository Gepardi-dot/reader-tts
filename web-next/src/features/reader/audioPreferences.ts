import { BROWSER_TTS_PROVIDER_ID, committedVoiceForDraft } from './audioPlayback'
import { DEFAULT_TTS_PROVIDER_ID, defaultVoiceForProvider, type TtsProviderInfo } from './audioProviderCatalog'

export const AUDIO_PREFS_KEY = 'reader-audio-prefs'
export const AUDIO_PREFS_VERSION = 4

export interface AudioPrefs {
  provider: string
  voice: string | null
  voicesByProvider: Record<string, string | null>
  version: number
}

export interface AudioSelection {
  provider: string
  voice: string | null
}

const DEFAULT_AUDIO_PREFS: AudioPrefs = {
  provider: DEFAULT_TTS_PROVIDER_ID,
  voice: null,
  voicesByProvider: {},
  version: AUDIO_PREFS_VERSION,
}

function storage(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage
}

function normalizedVoice(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

function normalizedVoiceMap(value: unknown): Record<string, string | null> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, string | null> = {}
  for (const [provider, voice] of Object.entries(value)) {
    if (!provider) continue
    out[provider] = normalizedVoice(voice)
  }
  return out
}

function normalizeProviderId(value: unknown): string {
  const raw = typeof value === 'string' && value ? value : DEFAULT_TTS_PROVIDER_ID
  // Browser speech was removed — migrate anyone still on it to Kokoro.
  if (raw === BROWSER_TTS_PROVIDER_ID || raw === 'browser') return DEFAULT_TTS_PROVIDER_ID
  if (raw === 'kokoro' || raw === 'google') return raw
  return DEFAULT_TTS_PROVIDER_ID
}

export function loadAudioPrefs(): AudioPrefs {
  try {
    const raw = storage()?.getItem(AUDIO_PREFS_KEY)
    if (!raw) return { ...DEFAULT_AUDIO_PREFS }
    const parsed = JSON.parse(raw) as Partial<AudioPrefs>
    const provider = normalizeProviderId(parsed.provider)
    const voicesByProvider = normalizedVoiceMap(parsed.voicesByProvider)
    const voice = normalizedVoice(parsed.voice)
    if (voice) voicesByProvider[provider] = voice

    return {
      provider,
      voice: voicesByProvider[provider] ?? voice,
      voicesByProvider,
      version: AUDIO_PREFS_VERSION,
    }
  } catch {
    return { ...DEFAULT_AUDIO_PREFS }
  }
}

export function saveAudioPrefs(prefs: AudioPrefs): void {
  const provider = normalizeProviderId(prefs.provider)
  storage()?.setItem(AUDIO_PREFS_KEY, JSON.stringify({
    provider,
    voice: committedVoiceForDraft(provider, prefs.voice),
    voicesByProvider: prefs.voicesByProvider,
    version: AUDIO_PREFS_VERSION,
  }))
}

export function audioPrefsWithSelection(prefs: AudioPrefs, selection: AudioSelection): AudioPrefs {
  const provider = normalizeProviderId(selection.provider)
  const voice = committedVoiceForDraft(provider, selection.voice)
  return {
    provider,
    voice,
    voicesByProvider: {
      ...prefs.voicesByProvider,
      [provider]: voice,
    },
    version: AUDIO_PREFS_VERSION,
  }
}

export function resolvedVoiceForProvider(
  providerId: string,
  provider: Pick<TtsProviderInfo, 'voices' | 'defaultVoice'> | undefined,
  prefs: AudioPrefs,
): string | null {
  const id = normalizeProviderId(providerId)
  const remembered = prefs.voicesByProvider[id] ?? (prefs.provider === id ? prefs.voice : null)
  if (!provider) return remembered
  if (remembered && provider.voices.some((voice) => voice.id === remembered)) return remembered

  return defaultVoiceForProvider(provider)
}
