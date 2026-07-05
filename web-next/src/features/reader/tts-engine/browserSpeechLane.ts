import { preferredBrowserSpeechVoice, supportsBrowserSpeech } from '../browserSpeech'

export interface BrowserSpeechChunk {
  index: number
  text: string
}

export interface SpeakChunkOptions {
  chunk: BrowserSpeechChunk
  rate: number
  signal: AbortSignal
  onStart: () => void
  onEnd: () => void
  onError: () => void
}

export class BrowserSpeechLane {
  private utterance: SpeechSynthesisUtterance | null = null
  private active = false

  get isActive() {
    return this.active
  }

  canSpeak() {
    return supportsBrowserSpeech()
  }

  speakChunk({ chunk, rate, signal, onStart, onEnd, onError }: SpeakChunkOptions) {
    if (!this.canSpeak()) return false
    this.stop()

    const utterance = new SpeechSynthesisUtterance(chunk.text)
    const voice = preferredBrowserSpeechVoice()
    if (voice) utterance.voice = voice
    utterance.lang = voice?.lang || 'en-US'
    utterance.rate = Math.max(0.5, Math.min(rate, 2))
    utterance.pitch = 1
    utterance.volume = 1

    this.active = true
    this.utterance = utterance
    utterance.onstart = () => {
      if (signal.aborted || this.utterance !== utterance) return
      onStart()
    }
    utterance.onend = () => {
      if (signal.aborted || this.utterance !== utterance) return
      this.utterance = null
      onEnd()
    }
    utterance.onerror = (event) => {
      if (signal.aborted || this.utterance !== utterance || event.error === 'interrupted') return
      this.utterance = null
      this.active = false
      onError()
    }

    window.speechSynthesis.cancel()
    window.speechSynthesis.speak(utterance)
    return true
  }

  pause() {
    if (!this.canSpeak() || !this.active) return false
    window.speechSynthesis.pause()
    return true
  }

  resume() {
    if (!this.canSpeak() || !this.active) return false
    window.speechSynthesis.resume()
    return true
  }

  stop() {
    if (!this.canSpeak()) {
      this.active = false
      this.utterance = null
      return
    }
    this.active = false
    this.utterance = null
    window.speechSynthesis.cancel()
  }
}

