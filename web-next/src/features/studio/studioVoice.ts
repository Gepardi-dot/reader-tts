/**
 * High-quality practice pronunciation via hosted Kokoro (female by default).
 *
 * Practice always prefers neural Kokoro over browser speech:
 *  1. Hosted Kokoro (production path — edge-cached on Worker)
 *  2. On-device Kokoro if the reader model is already warm
 *  3. Gemini female (Kore) if Kokoro fails
 *  4. Browser speech last resort (female English voice when available)
 */

import { api, request } from '@/shared/api/client'
import { loadAudioPrefs } from '@/features/reader/audioPreferences'
import {
  DEFAULT_KOKORO_VOICE,
  isKnownKokoroVoice,
} from '@/features/reader/kokoroVoices'
import { playableAudioUrl } from '@/features/reader/tts-engine/liveAudio'
import { armHtmlMediaElement, guessAudioMime, pauseHtmlMediaElement, setHtmlMediaSrc } from '@/lib/browser'
import { synthesizeKokoroLocal } from '@/features/reader/tts-engine/kokoroAudio'
import { isModelReady } from '@/shared/storage/modelCache'

const AUDIO_CACHE = new Map<string, string>()
const AUDIO_CACHE_CAP = 96
const INFLIGHT = new Map<string, Promise<string | null>>()
let currentAudio: HTMLAudioElement | null = null
let speakGeneration = 0
let warmupKicked = false
/** Track last warmed voice so a voice change re-pings Fly with the new id. */
let warmedVoice: string | null = null

const DEFAULT_GEMINI_FEMALE = 'Kore'

/** Slightly brisk for short headwords. */
const PRACTICE_SPEED = 1.05
const PRACTICE_LENGTH_SCALE = 1 / PRACTICE_SPEED
const HOSTED_TIMEOUT_MS = 12_000
const PREFETCH_CONCURRENCY = 3
const PREFETCH_LIMIT = 16

/**
 * Practice + prefetch always use the user's chosen Kokoro voice
 * (from post-signup onboarding or Audio settings).
 */
export function preferredPracticeVoice(): { provider: 'kokoro' | 'google'; voice: string } {
  const prefs = loadAudioPrefs()
  const remembered = prefs.voicesByProvider.kokoro
    ?? (prefs.provider === 'kokoro' ? prefs.voice : null)
  if (isKnownKokoroVoice(remembered)) {
    return { provider: 'kokoro', voice: remembered }
  }
  return { provider: 'kokoro', voice: DEFAULT_KOKORO_VOICE }
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
    pauseHtmlMediaElement(currentAudio)
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

/**
 * Ping Worker → Fly Kokoro so the machine stays warm before first Play.
 * Pass `prime: true` occasionally to run a tiny synth (keeps model path hot).
 */
export function warmHostedKokoro(force = false, options?: { prime?: boolean }) {
  const voice = preferredPracticeVoice().voice
  const prime = Boolean(options?.prime)
  if (!force && !prime && warmupKicked && warmedVoice === voice) return
  warmupKicked = true
  warmedVoice = voice
  void api.post('/api/providers/warmup', {
    provider: 'kokoro',
    voice,
    ...(prime ? { synth: true } : {}),
  }).catch(() => { /* best-effort */ })
}

/** Keep-alive while the tab is open (Fly cold starts were multi-second). */
export function startKokoroKeepAlive() {
  if (typeof window === 'undefined') return () => undefined
  // Health ping on open (no synth — avoids stacking jobs on the single Fly worker).
  warmHostedKokoro(true)
  const tick = () => {
    if (document.visibilityState !== 'visible') return
    warmHostedKokoro(true)
  }
  const id = window.setInterval(tick, 60_000)
  const onVis = () => {
    if (document.visibilityState === 'visible') warmHostedKokoro(true)
  }
  document.addEventListener('visibilitychange', onVis)
  return () => {
    window.clearInterval(id)
    document.removeEventListener('visibilitychange', onVis)
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
  const audio = new Audio()
  armHtmlMediaElement(audio)
  audio.preload = 'auto'
  try { (audio as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = true } catch { /* ignore */ }
  setHtmlMediaSrc(audio, url, guessAudioMime(url))
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

function hostedCacheKey(provider: string, voice: string, text: string) {
  return `hosted:${provider}:${voice}:${PRACTICE_LENGTH_SCALE.toFixed(3)}:${text.toLowerCase()}`
}

async function tryHostedNeural(
  text: string,
  provider: 'kokoro' | 'google',
  voice: string,
  gen: number,
): Promise<string | null> {
  const cacheKey = hostedCacheKey(provider, voice, text)
  const cached = AUDIO_CACHE.get(cacheKey)
  if (cached) return cached

  const existing = INFLIGHT.get(cacheKey)
  if (existing) {
    const url = await existing
    if (url && gen === speakGeneration) return url
    return url
  }

  const work = (async (): Promise<string | null> => {
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
      const playable = await playableAudioUrl(preview.audioUrl, controller.signal)
      rememberUrl(cacheKey, playable.url)
      return playable.url
    } catch {
      return null
    } finally {
      window.clearTimeout(timer)
      INFLIGHT.delete(cacheKey)
    }
  })()

  INFLIGHT.set(cacheKey, work)
  const url = await work
  if (url && gen !== speakGeneration) return url
  return url
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
  warmHostedKokoro()

  const { voice } = preferredPracticeVoice()
  const onPlaying = options?.onPlaying

  try {
    // 1) Hosted Kokoro first — Worker edge-caches short previews.
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

/**
 * Prefetch neural audio for upcoming practice words (best-effort, concurrent).
 * Also warms Fly Kokoro so the first real tap is not a cold start.
 */
export function prefetchStudioWords(words: string[]) {
  warmHostedKokoro()
  const unique = [...new Set(
    words.map((w) => w.replace(/\s+/g, ' ').trim()).filter(Boolean),
  )].slice(0, PREFETCH_LIMIT)
  if (unique.length === 0) return

  const { voice } = preferredPracticeVoice()
  let index = 0
  const workers = Array.from({ length: Math.min(PREFETCH_CONCURRENCY, unique.length) }, async () => {
    while (index < unique.length) {
      const i = index
      index += 1
      const word = unique[i]
      // Use a generation that never cancels prefetch when user clicks another word.
      await tryHostedNeural(word, 'kokoro', voice, speakGeneration).catch(() => null)
    }
  })
  void Promise.all(workers)
}

/** Prefetch a single upcoming word (e.g. next session step). */
export function prefetchStudioWord(word: string) {
  const cleaned = word.replace(/\s+/g, ' ').trim()
  if (!cleaned) return
  warmHostedKokoro()
  const { voice } = preferredPracticeVoice()
  void tryHostedNeural(cleaned, 'kokoro', voice, speakGeneration).catch(() => null)
}
