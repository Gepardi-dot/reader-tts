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
  description?: string
}

export interface ProvidersResponse {
  defaultNarrationStyle: string
  defaultProvider?: string
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

/** Book TTS: hosted Kokoro, Gemini, and NVIDIA Natural Voices. */
export const ALLOWED_TTS_PROVIDER_IDS = new Set(['kokoro', 'google', 'nvidia'])
export const DEFAULT_TTS_PROVIDER_ID = 'nvidia'

/** Picker order. Natural Voices is the default. HR Voices is last. */
export const TTS_PROVIDER_ORDER = ['nvidia', 'google', 'kokoro'] as const

function providerRank(id: string): number {
  const index = TTS_PROVIDER_ORDER.indexOf(id as (typeof TTS_PROVIDER_ORDER)[number])
  return index === -1 ? TTS_PROVIDER_ORDER.length : index
}

/** User-facing names. Internal ids stay `kokoro` / `google` / `nvidia`. */
export const TTS_PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  kokoro: 'HR Voices',
  google: 'HR Ultra Realistic',
  nvidia: 'Natural Voices',
}

export function displayNameForTtsProvider(id: string, fallback?: string | null): string {
  return TTS_PROVIDER_DISPLAY_NAMES[id] ?? fallback ?? id
}

const FALLBACK_TTS_PROVIDERS: TtsProviderInfo[] = [
  {
    id: 'nvidia',
    name: TTS_PROVIDER_DISPLAY_NAMES.nvidia,
    available: true,
    recommended: true,
    voices: [],
    defaultVoice: null,
  },
  {
    id: 'google',
    name: TTS_PROVIDER_DISPLAY_NAMES.google,
    available: true,
    recommended: false,
    voices: [],
    defaultVoice: null,
  },
  {
    id: 'kokoro',
    name: TTS_PROVIDER_DISPLAY_NAMES.kokoro,
    available: true,
    recommended: false,
    voices: [],
    defaultVoice: null,
  },
]

export const PROVIDER_PREVIEW_TEXT = (
  'When the room quieted, the story finally found its rhythm. '
  + 'Read this sample with natural phrasing, steady pacing, and a warm, attentive tone.'
)

/** Filter API/catalog entries down to the hosted voices the reader can play. */
export function normalizeTtsProviders(providers?: TtsProviderInfo[]): TtsProviderInfo[] {
  const catalog = (providers ?? []).filter((provider) => ALLOWED_TTS_PROVIDER_IDS.has(provider.id))
  const source = catalog.length > 0 ? catalog : FALLBACK_TTS_PROVIDERS
  return source
    .map((provider) => ({
      ...provider,
      name: displayNameForTtsProvider(provider.id, provider.name),
      recommended: provider.id === DEFAULT_TTS_PROVIDER_ID,
    }))
    .sort((a, b) => providerRank(a.id) - providerRank(b.id))
}

/** @deprecated Use normalizeTtsProviders — kept for older imports. */
export function withBrowserProvider(providers?: TtsProviderInfo[]) {
  return normalizeTtsProviders(providers)
}

export function providerOptionsFromCatalog(providers?: TtsProviderInfo[]): AudioProviderOption[] {
  return normalizeTtsProviders(providers).map((provider) => ({
    id: provider.id,
    label: displayNameForTtsProvider(provider.id, provider.name),
    available: provider.available,
    recommended: Boolean(provider.recommended),
    voices: provider.voices,
    defaultVoice: provider.defaultVoice ?? null,
  }))
}

export function defaultVoiceForProvider(
  provider: { voices: TtsVoiceOption[]; defaultVoice?: string | null } | undefined,
) {
  return provider?.defaultVoice ?? provider?.voices[0]?.id ?? null
}

export function pickFallbackProvider(providers: TtsProviderInfo[]) {
  const available = normalizeTtsProviders(providers).filter((provider) => provider.available)
  return (
    available.find((provider) => provider.id === DEFAULT_TTS_PROVIDER_ID) ??
    available.find((provider) => provider.id === 'google') ??
    available.find((provider) => provider.id === 'kokoro') ??
    available[0] ??
    null
  )
}
