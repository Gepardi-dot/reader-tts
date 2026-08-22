import { afterEach, describe, expect, it, vi } from 'vitest'
import { AUDIO_PREFS_KEY, audioPrefsWithSelection, loadAudioPrefs } from './audioPreferences'
import {
  APPEARANCE_KEY,
  BOOK_SETTINGS_KEY,
  DEFAULT_APPEARANCE,
  loadBookSettings,
  saveBookSettings,
} from './bookSettings'

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

describe('bookSettings', () => {
  it('seeds a new book from global appearance and voice', () => {
    const storage = installStorage()
    storage.set(APPEARANCE_KEY, JSON.stringify({ ...DEFAULT_APPEARANCE, theme: 'white', layout: 'paginated' }))
    storage.set(AUDIO_PREFS_KEY, JSON.stringify({
      provider: 'kokoro',
      voice: 'am_adam',
      voicesByProvider: { kokoro: 'am_adam' },
      version: 4,
    }))

    const settings = loadBookSettings('book-a')
    expect(settings.appearance).toMatchObject({ theme: 'white', layout: 'paginated' })
    expect(settings.audioPrefs).toMatchObject({ provider: 'kokoro', voice: 'am_adam' })
    expect(settings.audioRate).toBe(1)
    expect(JSON.parse(storage.get(BOOK_SETTINGS_KEY) ?? '{}')['book-a']).toBeTruthy()
  })

  it('keeps voice and appearance isolated per book', () => {
    installStorage()
    const a = loadBookSettings('book-a')
    saveBookSettings('book-a', {
      ...a,
      appearance: { ...a.appearance, theme: 'dark', layout: 'paginated' },
      audioPrefs: audioPrefsWithSelection(a.audioPrefs, { provider: 'kokoro', voice: 'af_heart' }),
      audioRate: 1.4,
    })

    const b = loadBookSettings('book-b')
    saveBookSettings('book-b', {
      ...b,
      appearance: { ...b.appearance, theme: 'paper', layout: 'continuous' },
      audioPrefs: audioPrefsWithSelection(b.audioPrefs, { provider: 'google', voice: 'Puck' }),
      audioRate: 0.8,
    })

    expect(loadBookSettings('book-a')).toMatchObject({
      appearance: { theme: 'dark', layout: 'paginated' },
      audioPrefs: { provider: 'kokoro', voice: 'af_heart' },
      audioRate: 1.4,
    })
    expect(loadBookSettings('book-b')).toMatchObject({
      appearance: { theme: 'paper', layout: 'continuous' },
      audioPrefs: { provider: 'google', voice: 'Puck' },
      audioRate: 0.8,
    })
  })

  it('does not let a later global default overwrite a saved book', () => {
    const storage = installStorage()
    const a = loadBookSettings('book-a')
    saveBookSettings('book-a', {
      ...a,
      audioPrefs: audioPrefsWithSelection(a.audioPrefs, { provider: 'kokoro', voice: 'am_adam' }),
    })
    storage.set(AUDIO_PREFS_KEY, JSON.stringify({
      provider: 'google',
      voice: 'Puck',
      voicesByProvider: { google: 'Puck' },
      version: 4,
    }))

    expect(loadBookSettings('book-a').audioPrefs).toMatchObject({
      provider: 'kokoro',
      voice: 'am_adam',
    })
    expect(loadAudioPrefs()).toMatchObject({ provider: 'google', voice: 'Puck' })
  })
})
