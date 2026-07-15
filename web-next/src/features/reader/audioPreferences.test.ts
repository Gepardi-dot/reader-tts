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
  it('defaults to kokoro', () => {
    installStorage()
    expect(loadAudioPrefs()).toMatchObject({
      provider: 'kokoro',
      voice: null,
      version: 4,
    })
  })

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
      version: 4,
    })
  })

  it('migrates browser speech prefs to kokoro', () => {
    const storage = installStorage()
    storage.set('reader-audio-prefs', JSON.stringify({
      provider: 'browser',
      voice: null,
      version: 3,
    }))

    expect(loadAudioPrefs()).toMatchObject({
      provider: 'kokoro',
      voice: null,
      version: 4,
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

  it('saves kokoro as the default committed provider', () => {
    const storage = installStorage()
    saveAudioPrefs(audioPrefsWithSelection(loadAudioPrefs(), { provider: 'kokoro', voice: 'af_heart' }))

    expect(JSON.parse(storage.get('reader-audio-prefs') ?? '{}')).toMatchObject({
      provider: 'kokoro',
      voice: 'af_heart',
      version: 4,
    })
  })
})
