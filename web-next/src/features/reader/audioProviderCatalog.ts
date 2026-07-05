import { BROWSER_TTS_PROVIDER_ID } from './audioPlayback'

export interface TtsVoiceOption {
  id: string
  label: string
}

export interface TtsProviderInfo {
  id: string
  name: string
  available: boolean
  recommended?: boolean
  voices: TtsVoiceOption[]
  defaultVoice?: string | null
}

export interface ProvidersResponse {
  defaultNarrationStyle: string
  providers: TtsProviderInfo[]
}

export interface ProviderTestResult {
  provider: string
  voice: string | null
  model: string | null
  sampleText: string
  audioUrl: string
  message: string
}

export interface AudioProviderOption {
  id: string
  label: string
  available: boolean
  recommended: boolean
  voices: TtsVoiceOption[]
  defaultVoice: string | null
}

const BROWSER_TTS_PROVIDER: TtsProviderInfo = {
  id: BROWSER_TTS_PROVIDER_ID,
  name: 'Browser speech',
  available: true,
  recommended: true,
  voices: [],
  defaultVoice: null,
}

const FALLBACK_TTS_PROVIDERS = [
  { id: BROWSER_TTS_PROVIDER_ID, label: 'Browser speech' },
  { id: 'kokoro', label: 'Kokoro (on-device)' },
  { id: 'google', label: 'Gemini Flash (cloud)' },
]

export const PROVIDER_PREVIEW_TEXT = (
  'When the room quieted, the story finally found its rhythm. '
  + 'Read this sample with natural phrasing, steady pacing, and a warm, attentive tone.'
)

export function withBrowserProvider(providers?: TtsProviderInfo[]) {
  const catalog = providers ?? []
  return catalog.some((provider) => provider.id === BROWSER_TTS_PROVIDER_ID)
    ? catalog
    : [BROWSER_TTS_PROVIDER, ...catalog]
}

export function providerOptionsFromCatalog(providers?: TtsProviderInfo[]): AudioProviderOption[] {
  const catalog = withBrowserProvider(providers)
  if (catalog.length) {
    return catalog.map((provider) => ({
      id: provider.id,
      label: provider.name,
      available: provider.available,
      recommended: Boolean(provider.recommended),
      voices: provider.voices,
      defaultVoice: provider.defaultVoice ?? null,
    }))
  }

  return FALLBACK_TTS_PROVIDERS.map((provider) => ({
    ...provider,
    available: true,
    recommended: false,
    voices: [],
    defaultVoice: null,
  }))
}

export function defaultVoiceForProvider(
  provider: { voices: TtsVoiceOption[]; defaultVoice?: string | null } | undefined,
) {
  return provider?.defaultVoice ?? provider?.voices[0]?.id ?? null
}

export function pickFallbackProvider(providers: TtsProviderInfo[]) {
  const available = withBrowserProvider(providers).filter((provider) => provider.available)
  return (
    available.find((provider) => provider.recommended) ??
    available.find((provider) => provider.id === BROWSER_TTS_PROVIDER_ID) ??
    available.find((provider) => provider.id === 'kokoro') ??
    available[0] ??
    null
  )
}
