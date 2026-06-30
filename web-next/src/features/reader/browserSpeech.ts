interface BrowserSpeechVoiceCandidate {
  lang: string
  name: string
}

let cachedVoices: SpeechSynthesisVoice[] | null = null
let listeningForVoiceChanges = false

export function supportsBrowserSpeech() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window
}

export function pickPreferredBrowserSpeechVoice<T extends BrowserSpeechVoiceCandidate>(
  voices: readonly T[],
): T | null {
  return (
    voices.find((voice) => /^en[-_]/i.test(voice.lang) && /natural|premium|online|google/i.test(voice.name)) ??
    voices.find((voice) => /^en[-_]/i.test(voice.lang)) ??
    voices[0] ??
    null
  )
}

function refreshBrowserSpeechVoices() {
  if (!supportsBrowserSpeech()) return null
  let voices: SpeechSynthesisVoice[] = []
  try {
    voices = window.speechSynthesis.getVoices()
  } catch {
    return cachedVoices
  }
  if (voices.length > 0) cachedVoices = voices
  return cachedVoices
}

export function primeBrowserSpeechVoices() {
  if (!supportsBrowserSpeech()) return
  refreshBrowserSpeechVoices()

  if (listeningForVoiceChanges) return
  listeningForVoiceChanges = true

  const onVoicesChanged = () => {
    refreshBrowserSpeechVoices()
  }

  if (typeof window.speechSynthesis.addEventListener === 'function') {
    window.speechSynthesis.addEventListener('voiceschanged', onVoicesChanged)
    return
  }

  const previous = window.speechSynthesis.onvoiceschanged
  window.speechSynthesis.onvoiceschanged = (event) => {
    if (typeof previous === 'function') previous.call(window.speechSynthesis, event)
    onVoicesChanged()
  }
}

export function preferredBrowserSpeechVoice() {
  const voices = refreshBrowserSpeechVoices()
  return voices ? pickPreferredBrowserSpeechVoice(voices) : null
}
