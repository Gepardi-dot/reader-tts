import {
  audioPrefsWithSelection,
  loadAudioPrefs,
  saveAudioPrefs,
} from './audioPreferences'
import { DEFAULT_KOKORO_VOICE, isKnownKokoroVoice } from './kokoroVoices'

const VOICE_ONBOARDING_KEY = 'reader-voice-onboarding-v1'

function storage(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage
}

function readCompletedIds(): Set<string> {
  try {
    const raw = storage()?.getItem(VOICE_ONBOARDING_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((id): id is string => typeof id === 'string' && id.length > 0))
  } catch {
    return new Set()
  }
}

function writeCompletedIds(ids: Set<string>) {
  storage()?.setItem(VOICE_ONBOARDING_KEY, JSON.stringify([...ids]))
}

export function hasCompletedVoiceOnboarding(userId: string): boolean {
  if (!userId) return false
  return readCompletedIds().has(userId)
}

export function markVoiceOnboardingComplete(userId: string) {
  if (!userId) return
  const ids = readCompletedIds()
  ids.add(userId)
  writeCompletedIds(ids)
}

/** Saved Kokoro voice from audio prefs, if any. */
export function savedKokoroVoice(): string | null {
  const prefs = loadAudioPrefs()
  const voice = prefs.voicesByProvider.kokoro
    ?? (prefs.provider === 'kokoro' ? prefs.voice : null)
  return isKnownKokoroVoice(voice) ? voice : null
}

/**
 * True when this user still needs to pick a reading/practice voice.
 * Users who already chose a Kokoro voice (settings or prior session) are treated as done.
 */
export function needsVoiceOnboarding(userId: string): boolean {
  if (!userId) return false
  if (hasCompletedVoiceOnboarding(userId)) return false
  if (savedKokoroVoice()) {
    markVoiceOnboardingComplete(userId)
    return false
  }
  return true
}

/** Persist Kokoro as provider + chosen voice and mark onboarding complete. */
export function commitKokoroVoiceChoice(userId: string, voice: string) {
  const chosen = isKnownKokoroVoice(voice) ? voice : DEFAULT_KOKORO_VOICE
  saveAudioPrefs(audioPrefsWithSelection(loadAudioPrefs(), {
    provider: 'kokoro',
    voice: chosen,
  }))
  markVoiceOnboardingComplete(userId)
  return chosen
}
