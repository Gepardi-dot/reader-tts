import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  commitKokoroVoiceChoice,
  hasCompletedVoiceOnboarding,
  needsVoiceOnboarding,
  savedKokoroVoice,
} from './voiceOnboarding'
import { loadAudioPrefs } from './audioPreferences'

function installStorage() {
  const map = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key: string) => map.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      map.set(key, value)
    }),
    removeItem: vi.fn((key: string) => {
      map.delete(key)
    }),
    clear: vi.fn(() => {
      map.clear()
    }),
  })
  return map
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('voice onboarding', () => {
  it('requires onboarding when no kokoro voice is saved', () => {
    installStorage()
    expect(needsVoiceOnboarding('user-1')).toBe(true)
    expect(hasCompletedVoiceOnboarding('user-1')).toBe(false)
  })

  it('commits a voice and marks onboarding complete', () => {
    installStorage()
    const voice = commitKokoroVoiceChoice('user-1', 'am_adam')
    expect(voice).toBe('am_adam')
    expect(savedKokoroVoice()).toBe('am_adam')
    expect(loadAudioPrefs()).toMatchObject({
      provider: 'kokoro',
      voice: 'am_adam',
      voicesByProvider: { kokoro: 'am_adam' },
    })
    expect(hasCompletedVoiceOnboarding('user-1')).toBe(true)
    expect(needsVoiceOnboarding('user-1')).toBe(false)
  })

  it('falls back to Heart for unknown voice ids', () => {
    installStorage()
    const voice = commitKokoroVoiceChoice('user-2', 'not_a_voice')
    expect(voice).toBe('af_heart')
    expect(savedKokoroVoice()).toBe('af_heart')
  })

  it('treats an existing saved voice as onboarding already done', () => {
    const storage = installStorage()
    storage.set('reader-audio-prefs', JSON.stringify({
      provider: 'kokoro',
      voice: 'bf_emma',
      voicesByProvider: { kokoro: 'bf_emma' },
      version: 4,
    }))

    expect(needsVoiceOnboarding('user-3')).toBe(false)
    expect(hasCompletedVoiceOnboarding('user-3')).toBe(true)
  })
})
