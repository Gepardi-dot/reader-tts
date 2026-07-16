/**
 * High-quality practice pronunciation via hosted Kokoro (female by default).
 *
 * Practice always prefers neural Kokoro over browser speech:
 *  1. Hosted Kokoro (production path — fast single-word synth)
 *  2. On-device Kokoro if the reader model is already warm
 *  3. Gemini female (Kore) if Kokoro fails
 *  4. Browser speech last resort (female English voice when available)
 */

import { request } from '@/shared/api/client'
import { loadAudioPrefs } from '@/features/reader/audioPreferences'
import { playableAudioUrl } from '@/features/reader/tts-engine/liveAudio'
import { synthesizeKokoroLocal } from '@/features/reader/tts-engine/kokoroAudio'
import { isModelReady } from '@/shared/storage/modelCache'

const AUDIO_CACHE = new Map<string, string>()
const AUDIO_CACHE_CAP = 80
let currentAudio: HTMLAudioElement | null = null
let speakGeneration = 0

/** Female Kokoro voices — practice defaults to Heart for clarity. */
const FEMALE_KOKORO_VOICES = new Set([
  'af_heart', 'af_sarah', 'af_sky', 'af_bella', 'bf_emma',
])
const DEFAULT_PRACTICE_VOICE = 'af_heart'
const DEFAULT_GEMINI_FEMALE = 'Kore'

/** Slightly brisk for short headwords (was 0.9 — felt slow). */
const PRACTICE_SPEED = 1.05
const PRACTICE_LENGTH_SCALE = 1 / PRACTICE_SPEED
const HOSTED_TIMEOUT_MS = 12_000

function preferredPracticeVoice(): { provider: 'kokoro' | 'google'; voice: string } {
  // Practice always aims for Kokoro first (hosted is configured in production).
  // If the reader prefs already picked a female Kokoro voice, keep it.
  const prefs = loadAudioPrefs()
  if (prefs.provider === 'kokoro') {
    const remembered = prefs.voicesByProvider.kokoro ?? prefs.voice
    if (remembered && FEMALE_KOKORO_VOICES.has(remembered)) {
      return { provider: 'kokoro', voice: remembered }
    }
  }
  return { provider: 'kokoro', voice: DEFAULT_PRACTICE_VOICE }
}

function rememberUrl(key: string, url: string) {
  if (AUDIO_CACHE.has(key)) AUDIO_CACHE.delete(key)
  AUDIO_CACHE.set(key, url)
  while (AUDIO_CACHE.size > AUDIO_CACHE_CAP) {
    const oldest = AUDIO_CACHE.keys().next().value
    if (oldest == null) break
    const stale = AUDIO_CACHE.get(oldest)
    AUDIO_CACHE.delete(oldest)
    if (stale?.startsWith('blob:')) {
      try { URL.revokeObjectURL(stale) } catch { /* ignore */ }
    }
  }
}

function stopCurrentAudio() {
  if (currentAudio) {
    try {
      currentAudio.pause()
      currentAudio.removeAttribute('src')
      currentAudio.load()
    } catch { /* ignore */ }
    currentAudio = null
  }
  try {
    window.speechSynthesis?.cancel()
  } catch { /* ignore */ }
}

function pickFemaleBrowserVoice(): SpeechSynthesisVoice | null {
  try {
    const voices = window.speechSynthesis.getVoices()
    if (!voices.length) return null
    const en = voices.filter((v) => /^en/i.test(v.lang))
    const femaleName = /female|samantha|karen|moira|tessa|fiona|victoria|zira|susan|hazel|aria|jenny|natasha|google uk english female|google us english/i
    return en.find((v) => femaleName.test(v.name))
      || en.find((v) => /natural|neural|premium|enhanced/i.test(v.name) && !/male|david|daniel|mark|james|george/i.test(v.name))
      || en.find((v) => /en-US|en_US/i.test(v.lang))
      || en[0]
      || null
  } catch {
    return null
  }
}

function speakBrowserFallback(text: string) {
  try {
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.rate = 1.0
    utterance.pitch = 1.05
    const preferred = pickFemaleBrowserVoice()
    if (preferred) {
      utterance.voice = preferred
      utterance.lang = preferred.lang || 'en-US'
    } else {
      utterance.lang = 'en-US'
    }
    window.speechSynthesis.speak(utterance)
  } catch {
    // optional
  }
}

class AutoplayBlockedError extends Error {
  constructor() {
    super('autoplay-blocked')
    this.name = 'AutoplayBlockedError'
  }
}

async function playUrl(url: string, gen: number, onPlaying?: () => void): Promise<void> {
  if (gen !== speakGeneration) return
  const audio = new Audio(url)
  audio.preload = 'auto'
  try { (audio as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = true } catch { /* ignore */ }
  currentAudio = audio
  await new Promise<void>((resolve, reject) => {
    const done = () => {
      audio.removeEventListener('ended', onEnded)
      audio.removeEventListener('error', onError)
      resolve()
    }
    const onEnded = () => done()
    const onError = () => {
      audio.removeEventListener('ended', onEnded)
      audio.removeEventListener('error', onError)
      reject(new Error('audio element failed'))
    }
    audio.addEventListener('ended', onEnded)
    audio.addEventListener('error', onError)
    void audio.play().then(() => {
      if (gen === speakGeneration) onPlaying?.()
    }).catch((err: unknown) => {
      audio.removeEventListener('ended', onEnded)
      audio.removeEventListener('error', onError)
      const name = err && typeof err === 'object' && 'name' in err ? String((err as { name: string }).name) : ''
      const msg = err instanceof Error ? err.message : String(err)
      if (name === 'NotAllowedError' || /user didn't interact|not allowed|play\(\)/i.test(msg)) {
        reject(new AutoplayBlockedError())
        return
      }
      reject(err instanceof Error ? err : new Error(msg))
    })
  })
}

async function tryLocalKokoro(text: string, voice: string, gen: number): Promise<string | null> {
  if (!isModelReady()) return null
  const cacheKey = `local:${voice}:${PRACTICE_SPEED}:${text.toLowerCase()}`
  const cached = AUDIO_CACHE.get(cacheKey)
  if (cached) return cached

  const controller = new AbortController()
  if (gen !== speakGeneration) {
    controller.abort()
    return null
  }

  const result = await synthesizeKokoroLocal(text, voice, PRACTICE_SPEED, controller.signal)
  if (!result || gen !== speakGeneration) return null

  const url = URL.createObjectURL(result.blob)
  rememberUrl(cacheKey, url)
  return url
}

async function tryHostedNeural(
  text: string,
  provider: 'kokoro' | 'google',
  voice: string,
  gen: number,
): Promise<string | null> {
  const cacheKey = `hosted:${provider}:${voice}:${PRACTICE_LENGTH_SCALE.toFixed(3)}:${text.toLowerCase()}`
  const cached = AUDIO_CACHE.get(cacheKey)
  if (cached) return cached

  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), HOSTED_TIMEOUT_MS)
  try {
    const preview = await request<{ audioUrl: string }>('/api/providers/test', {
      method: 'POST',
      body: JSON.stringify({
        provider,
        voice,
        text,
        length_scale: PRACTICE_LENGTH_SCALE,
        sentence_silence: 0.02,
        narration_style: provider === 'google' ? 'warm' : '',
      }),
      signal: controller.signal,
    })
    if (gen !== speakGeneration) return null

    const playable = await playableAudioUrl(preview.audioUrl, controller.signal)
    if (gen !== speakGeneration) {
      playable.revoke()
      return null
    }
    rememberUrl(cacheKey, playable.url)
    return playable.url
  } finally {
    window.clearTimeout(timer)
  }
}

export type SpeakStudioOptions = {
  /** Called once neural (or browser) audio actually starts playing. */
  onPlaying?: () => void
}

/**
 * Speak a short practice word/phrase with neural TTS (female Kokoro by default).
 * Resolves when playback finishes (or fails through to browser speech).
 */
export async function speakStudioText(text: string, options?: SpeakStudioOptions): Promise<void> {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  if (!cleaned) return

  const gen = ++speakGeneration
  stopCurrentAudio()

  const { voice } = preferredPracticeVoice()
  const onPlaying = options?.onPlaying

  try {
    // 1) Hosted Kokoro first — production path; snappy female voice for headwords.
    const hostedKokoro = await tryHostedNeural(cleaned, 'kokoro', voice, gen)
    if (hostedKokoro && gen === speakGeneration) {
      await playUrl(hostedKokoro, gen, onPlaying)
      return
    }

    // 2) On-device Kokoro only if already warm (don't wait for download).
    const localUrl = await tryLocalKokoro(cleaned, voice, gen)
    if (localUrl && gen === speakGeneration) {
      await playUrl(localUrl, gen, onPlaying)
      return
    }

    // 3) Gemini female as backup neural path.
    const hostedGemini = await tryHostedNeural(cleaned, 'google', DEFAULT_GEMINI_FEMALE, gen)
    if (hostedGemini && gen === speakGeneration) {
      await playUrl(hostedGemini, gen, onPlaying)
      return
    }
  } catch (err) {
    if (err instanceof AutoplayBlockedError) return
    console.warn('[studioVoice] neural TTS failed, using browser speech', err)
  }

  if (gen === speakGeneration) {
    onPlaying?.()
    speakBrowserFallback(cleaned)
  }
}

export function stopStudioSpeech() {
  speakGeneration += 1
  stopCurrentAudio()
}

export function estimateSpeakMs(text: string) {
  const chars = Math.max(4, text.trim().length)
  return Math.min(7000, Math.max(800, Math.round(chars * 70 + 350)))
}

/** Prefetch neural audio for upcoming practice words (best-effort). */
export function prefetchStudioWords(words: string[]) {
  const unique = [...new Set(words.map((w) => w.replace(/\s+/g, ' ').trim().toLowerCase()).filter(Boolean))]
  const { voice } = preferredPracticeVoice()
  for (const word of unique.slice(0, 8)) {
    void tryHostedNeural(word, 'kokoro', voice, speakGeneration).catch(() => { /* ignore */ })
  }
}
