import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  audioPrefsWithSelection,
  loadAudioPrefs,
  resolvedVoiceForProvider,
  saveAudioPrefs,
} from './audioPreferences'

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

describe('audio preferences', () => {
  it('migrates the old single voice preference into a provider-scoped map', () => {
    const storage = installStorage()
    storage.set('reader-audio-prefs', JSON.stringify({
      provider: 'kokoro',
      voice: 'am_adam',
      version: 2,
    }))

    expect(loadAudioPrefs()).toMatchObject({
      provider: 'kokoro',
      voice: 'am_adam',
      voicesByProvider: { kokoro: 'am_adam' },
      version: 3,
    })
  })

  it('remembers separate voices per provider', () => {
    const prefs = audioPrefsWithSelection(
      audioPrefsWithSelection(loadAudioPrefs(), { provider: 'kokoro', voice: 'am_adam' }),
      { provider: 'google', voice: 'Puck' },
    )

    expect(prefs).toMatchObject({
      provider: 'google',
      voice: 'Puck',
      voicesByProvider: {
        kokoro: 'am_adam',
        google: 'Puck',
      },
    })
  })

  it('resolves remembered provider voices without falling back to defaults', () => {
    const prefs = audioPrefsWithSelection(loadAudioPrefs(), { provider: 'kokoro', voice: 'am_adam' })
    const provider = {
      voices: [
        { id: 'af_heart', label: 'Heart' },
        { id: 'am_adam', label: 'Adam' },
      ],
      defaultVoice: 'af_heart',
    }

    expect(resolvedVoiceForProvider('kokoro', provider, prefs)).toBe('am_adam')
  })

  it('saves browser speech with a null committed voice', () => {
    const storage = installStorage()
    saveAudioPrefs(audioPrefsWithSelection(loadAudioPrefs(), { provider: 'browser', voice: 'ignored' }))

    expect(JSON.parse(storage.get('reader-audio-prefs') ?? '{}')).toMatchObject({
      provider: 'browser',
      voice: null,
      version: 3,
    })
  })
})

