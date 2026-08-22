import {
  AUDIO_PREFS_KEY,
  loadAudioPrefs,
  normalizeAudioPrefs,
  type AudioPrefs,
} from './audioPreferences'
import { normalizeReaderLayout, type ReaderLayout } from './readerLayout'

export const BOOK_SETTINGS_KEY = 'reader-book-settings-v1'
export const APPEARANCE_KEY = 'reader-appearance'
export const AUDIO_RATE_KEY = 'reader-audio-rate'

export type BookAppearance = {
  fontSize: number
  lineHeight: number
  font: 'serif' | 'sans'
  bionic: boolean
  width: 'narrow' | 'balanced' | 'wide'
  align: 'left' | 'center' | 'justify'
  theme: 'paper' | 'white' | 'dark'
  layout: ReaderLayout
}

export type BookReaderSettings = {
  appearance: BookAppearance
  audioPrefs: AudioPrefs
  audioRate: number
}

export const DEFAULT_APPEARANCE: BookAppearance = {
  fontSize: 17,
  lineHeight: 1.85,
  font: 'serif',
  bionic: false,
  width: 'balanced',
  align: 'justify',
  theme: 'paper',
  layout: 'continuous',
}

const DEFAULT_AUDIO_RATE = 1

function storage(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage
}

function clampAudioRate(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return DEFAULT_AUDIO_RATE
  return Math.min(2.5, Math.max(0.5, Math.round(n * 10) / 10))
}

function isTheme(value: unknown): value is BookAppearance['theme'] {
  return value === 'paper' || value === 'white' || value === 'dark'
}

export function normalizeAppearance(raw: unknown): BookAppearance {
  const parsed = raw && typeof raw === 'object' ? raw as Partial<BookAppearance> : {}
  return {
    ...DEFAULT_APPEARANCE,
    ...parsed,
    fontSize: typeof parsed.fontSize === 'number' ? parsed.fontSize : DEFAULT_APPEARANCE.fontSize,
    lineHeight: typeof parsed.lineHeight === 'number' ? parsed.lineHeight : DEFAULT_APPEARANCE.lineHeight,
    font: parsed.font === 'sans' ? 'sans' : 'serif',
    bionic: Boolean(parsed.bionic),
    width: parsed.width === 'narrow' || parsed.width === 'wide' ? parsed.width : 'balanced',
    align: parsed.align === 'center' || parsed.align === 'left' ? parsed.align : 'justify',
    theme: isTheme(parsed.theme) ? parsed.theme : DEFAULT_APPEARANCE.theme,
    layout: normalizeReaderLayout(parsed.layout),
  }
}

export function loadGlobalAppearance(): BookAppearance {
  try {
    const raw = storage()?.getItem(APPEARANCE_KEY)
    if (!raw) return { ...DEFAULT_APPEARANCE }
    return normalizeAppearance(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_APPEARANCE }
  }
}

export function saveGlobalAppearance(appearance: BookAppearance): void {
  storage()?.setItem(APPEARANCE_KEY, JSON.stringify(normalizeAppearance(appearance)))
}

export function loadGlobalAudioRate(): number {
  try {
    const raw = storage()?.getItem(AUDIO_RATE_KEY)
    if (raw == null || raw === '') return DEFAULT_AUDIO_RATE
    return clampAudioRate(Number(raw))
  } catch {
    return DEFAULT_AUDIO_RATE
  }
}

export function saveGlobalAudioRate(rate: number): void {
  storage()?.setItem(AUDIO_RATE_KEY, String(clampAudioRate(rate)))
}

/** Wipe local appearance, voice, and per-book reader settings (account deletion). */
export function clearLocalReaderSettings(): void {
  const store = storage()
  if (!store) return
  store.removeItem(APPEARANCE_KEY)
  store.removeItem(AUDIO_RATE_KEY)
  store.removeItem(BOOK_SETTINGS_KEY)
  store.removeItem(AUDIO_PREFS_KEY)
}

function readMap(): Record<string, Partial<BookReaderSettings>> {
  try {
    const raw = storage()?.getItem(BOOK_SETTINGS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, Partial<BookReaderSettings>>
  } catch {
    return {}
  }
}

function writeMap(map: Record<string, Partial<BookReaderSettings>>) {
  storage()?.setItem(BOOK_SETTINGS_KEY, JSON.stringify(map))
}

function seedFromGlobal(): BookReaderSettings {
  return {
    appearance: loadGlobalAppearance(),
    audioPrefs: loadAudioPrefs(),
    audioRate: loadGlobalAudioRate(),
  }
}

function normalizeSettings(raw: Partial<BookReaderSettings> | undefined): BookReaderSettings {
  const seed = seedFromGlobal()
  if (!raw) return seed
  return {
    appearance: raw.appearance ? normalizeAppearance(raw.appearance) : seed.appearance,
    audioPrefs: raw.audioPrefs ? normalizeAudioPrefs(raw.audioPrefs) : seed.audioPrefs,
    audioRate: clampAudioRate(raw.audioRate ?? seed.audioRate),
  }
}

/** Load this book's settings. First visit snapshots current global defaults. */
export function loadBookSettings(bookId: string | undefined): BookReaderSettings {
  if (!bookId) return seedFromGlobal()
  const map = readMap()
  const existing = map[bookId]
  if (existing) return normalizeSettings(existing)
  const seeded = seedFromGlobal()
  map[bookId] = seeded
  writeMap(map)
  return seeded
}

export function saveBookSettings(bookId: string, settings: BookReaderSettings): void {
  if (!bookId) return
  const map = readMap()
  map[bookId] = {
    appearance: normalizeAppearance(settings.appearance),
    audioPrefs: settings.audioPrefs,
    audioRate: clampAudioRate(settings.audioRate),
  }
  writeMap(map)
}
