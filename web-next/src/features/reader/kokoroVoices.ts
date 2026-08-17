/**
 * Client-side Kokoro voice catalog (mirrors Worker KOKORO_VOICES).
 * Used for onboarding, practice prefs, and offline fallback when /api/providers is slow.
 */

export interface KokoroVoiceOption {
  id: string
  label: string
  gender: 'female' | 'male'
  style: string
  /** Highlight for story / practice defaults. */
  recommended?: boolean
  accent?: 'us' | 'uk'
}

export const DEFAULT_KOKORO_VOICE = 'af_sky'

export const KOKORO_VOICE_CATALOG: readonly KokoroVoiceOption[] = [
  { id: 'af_heart', label: 'Heart', gender: 'female', style: 'Warm & Natural', accent: 'us' },
  { id: 'af_sarah', label: 'Sarah', gender: 'female', style: 'Clear & Conversational', accent: 'us' },
  { id: 'af_sky', label: 'Sky', gender: 'female', style: 'Bright & Expressive', recommended: true, accent: 'us' },
  { id: 'af_bella', label: 'Bella', gender: 'female', style: 'Soft', accent: 'us' },
  { id: 'am_adam', label: 'Adam', gender: 'male', style: 'Natural & Steady', recommended: true, accent: 'us' },
  { id: 'am_michael', label: 'Michael', gender: 'male', style: 'Authoritative', accent: 'us' },
  { id: 'bf_emma', label: 'Emma', gender: 'female', style: 'British & Warm', accent: 'uk' },
  { id: 'bm_george', label: 'George', gender: 'male', style: 'British & Deep', recommended: true, accent: 'uk' },
  { id: 'bm_lewis', label: 'Lewis', gender: 'male', style: 'British & Calm', accent: 'uk' },
] as const

export const KOKORO_VOICE_IDS = new Set(KOKORO_VOICE_CATALOG.map((v) => v.id))

export function isKnownKokoroVoice(voice: string | null | undefined): voice is string {
  return Boolean(voice && KOKORO_VOICE_IDS.has(voice))
}

export function kokoroVoiceById(id: string | null | undefined): KokoroVoiceOption | undefined {
  if (!id) return undefined
  return KOKORO_VOICE_CATALOG.find((v) => v.id === id)
}

/** Short line for onboarding / settings previews. */
export const KOKORO_VOICE_PREVIEW_TEXT =
  'Hello. This is how I sound when reading your books and practice words.'
