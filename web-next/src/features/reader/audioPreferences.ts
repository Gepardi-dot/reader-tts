import { BROWSER_TTS_PROVIDER_ID, committedVoiceForDraft } from './audioPlayback'
import { defaultVoiceForProvider, type TtsProviderInfo } from './audioProviderCatalog'

export const AUDIO_PREFS_KEY = 'reader-audio-prefs'
export const AUDIO_PREFS_VERSION = 3

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
  provider: BROWSER_TTS_PROVIDER_ID,
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

export function loadAudioPrefs(): AudioPrefs {
  try {
    const raw = storage()?.getItem(AUDIO_PREFS_KEY)
    if (!raw) return DEFAULT_AUDIO_PREFS
    const parsed = JSON.parse(raw) as Partial<AudioPrefs>
    const provider = typeof parsed.provider === 'string' && parsed.provider
      ? parsed.provider
      : DEFAULT_AUDIO_PREFS.provider
    const voice = provider === BROWSER_TTS_PROVIDER_ID
      ? null
      : normalizedVoice(parsed.voice)
    const voicesByProvider = normalizedVoiceMap(parsed.voicesByProvider)

    if (provider !== BROWSER_TTS_PROVIDER_ID) {
      voicesByProvider[provider] = voice
    }

    return {
      provider,
      voice,
      voicesByProvider,
      version: AUDIO_PREFS_VERSION,
    }
  } catch {
    return DEFAULT_AUDIO_PREFS
  }
}

export function saveAudioPrefs(prefs: AudioPrefs): void {
  storage()?.setItem(AUDIO_PREFS_KEY, JSON.stringify({
    provider: prefs.provider,
    voice: committedVoiceForDraft(prefs.provider, prefs.voice),
    voicesByProvider: prefs.voicesByProvider,
    version: AUDIO_PREFS_VERSION,
  }))
}

export function audioPrefsWithSelection(prefs: AudioPrefs, selection: AudioSelection): AudioPrefs {
  const voice = committedVoiceForDraft(selection.provider, selection.voice)
  return {
    provider: selection.provider,
    voice,
    voicesByProvider: {
      ...prefs.voicesByProvider,
      [selection.provider]: voice,
    },
    version: AUDIO_PREFS_VERSION,
  }
}

export function resolvedVoiceForProvider(
  providerId: string,
  provider: Pick<TtsProviderInfo, 'voices' | 'defaultVoice'> | undefined,
  prefs: AudioPrefs,
): string | null {
  if (providerId === BROWSER_TTS_PROVIDER_ID) return null

  const remembered = prefs.voicesByProvider[providerId] ?? (prefs.provider === providerId ? prefs.voice : null)
  if (!provider) return remembered
  if (remembered && provider.voices.some((voice) => voice.id === remembered)) return remembered

  return defaultVoiceForProvider(provider)
}

