/**
 * High-quality practice pronunciation via Kokoro neural TTS.
 *
 * Order of preference:
 *  1. On-device Kokoro (same model as the reader — best latency once warm)
 *  2. Hosted Kokoro / Gemini via /api/providers/test
 *  3. Browser speech only if neural paths are unavailable
 */

import { request } from '@/shared/api/client'
import { loadAudioPrefs } from '@/features/reader/audioPreferences'
import { playableAudioUrl } from '@/features/reader/tts-engine/liveAudio'
import { synthesizeKokoroLocal } from '@/features/reader/tts-engine/kokoroAudio'
import { isModelReady, startWarmup } from '@/shared/storage/modelCache'

const AUDIO_CACHE = new Map<string, string>()
const AUDIO_CACHE_CAP = 64
let currentAudio: HTMLAudioElement | null = null
let speakGeneration = 0
let warmupKicked = false

/** Slightly slower than book narration so single words are clear. */
const PRACTICE_SPEED = 0.9
const PRACTICE_LENGTH_SCALE = 1 / PRACTICE_SPEED

function preferredStudioVoice(): { provider: 'kokoro' | 'google'; voice: string } {
  const prefs = loadAudioPrefs()
  const provider = prefs.provider === 'google' ? 'google' : 'kokoro'
  const remembered = prefs.voicesByProvider[provider] ?? prefs.voice
  const voice = remembered
    || (provider === 'google' ? 'Kore' : 'af_heart')
  return { provider, voice }
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

function speakBrowserFallback(text: string) {
  try {
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.rate = 0.88
    utterance.pitch = 1
    const voices = window.speechSynthesis.getVoices()
    const preferred = voices.find((v) => /en(-|_)?(US|GB)/i.test(v.lang) && /natural|neural|premium|enhanced|samantha|daniel|google|microsoft/i.test(v.name))
      || voices.find((v) => /^en/i.test(v.lang) && /google|microsoft|apple|samantha|daniel/i.test(v.name))
      || voices.find((v) => /^en/i.test(v.lang))
    if (preferred) utterance.voice = preferred
    window.speechSynthesis.speak(utterance)
  } catch {
    // optional
  }
}

function ensureWarmup() {
  if (warmupKicked) return
  warmupKicked = true
  try {
    startWarmup()
  } catch {
    // optional — hosted path still works
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
  // Keep pitch natural if the browser supports it (rate stays 1.0 for neural files).
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
      // Don't degrade to robot browser TTS just because autoplay was blocked —
      // the Replay / speaker button is a real user gesture and will play neural.
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
  // Cancel local synth if a newer speak superseded us.
  const cancelIfStale = () => {
    if (gen !== speakGeneration) controller.abort()
  }
  cancelIfStale()
  if (controller.signal.aborted) return null

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

  const preview = await request<{ audioUrl: string }>('/api/providers/test', {
    method: 'POST',
    body: JSON.stringify({
      provider,
      voice,
      text,
      length_scale: PRACTICE_LENGTH_SCALE,
      sentence_silence: 0.05,
      // Empty style for Kokoro; Gemini uses a light warm cue when set.
      narration_style: provider === 'google' ? 'warm' : '',
    }),
  })
  if (gen !== speakGeneration) return null

  const playable = await playableAudioUrl(preview.audioUrl)
  if (gen !== speakGeneration) {
    playable.revoke()
    return null
  }
  rememberUrl(cacheKey, playable.url)
  return playable.url
}

export type SpeakStudioOptions = {
  /** Called once neural (or browser) audio actually starts playing. */
  onPlaying?: () => void
}

/**
 * Speak a short practice word/phrase with neural TTS (Kokoro by default).
 * Resolves when playback finishes (or fails through to browser speech).
 */
export async function speakStudioText(text: string, options?: SpeakStudioOptions): Promise<void> {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  if (!cleaned) return

  const gen = ++speakGeneration
  stopCurrentAudio()
  ensureWarmup()

  const { provider, voice } = preferredStudioVoice()
  const onPlaying = options?.onPlaying

  try {
    // 1) On-device Kokoro when the reader model is already warm.
    if (provider === 'kokoro') {
      const localUrl = await tryLocalKokoro(cleaned, voice, gen)
      if (localUrl && gen === speakGeneration) {
        await playUrl(localUrl, gen, onPlaying)
        return
      }
    }

    // 2) Hosted neural (Kokoro or Gemini per user audio prefs).
    const hostedUrl = await tryHostedNeural(cleaned, provider, voice, gen)
    if (hostedUrl && gen === speakGeneration) {
      await playUrl(hostedUrl, gen, onPlaying)
      return
    }
  } catch (err) {
    if (err instanceof AutoplayBlockedError) {
      // Neural audio is cached; user can tap Replay / speaker for real voice.
      return
    }
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
  // Rough UI “speaking” duration while waiting for real ended event.
  // Neural practice runs ~0.9× → a bit longer than reading pace.
  const chars = Math.max(4, text.trim().length)
  return Math.min(9000, Math.max(1100, Math.round(chars * 100 + 500)))
}
