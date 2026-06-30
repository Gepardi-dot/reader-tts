import { describe, expect, it } from 'vitest'
import { pickPreferredBrowserSpeechVoice } from './browserSpeech'

describe('browser speech voice selection', () => {
  it('prefers premium or natural English voices', () => {
    const voices = [
      { name: 'Compact German', lang: 'de-DE' },
      { name: 'Basic English', lang: 'en-US' },
      { name: 'Google US English', lang: 'en-US' },
    ]

    expect(pickPreferredBrowserSpeechVoice(voices)).toBe(voices[2])
  })

  it('falls back to any English voice', () => {
    const voices = [
      { name: 'Compact German', lang: 'de-DE' },
      { name: 'Plain English', lang: 'en-GB' },
    ]

    expect(pickPreferredBrowserSpeechVoice(voices)).toBe(voices[1])
  })

  it('falls back to the first available voice', () => {
    const voices = [
      { name: 'Compact German', lang: 'de-DE' },
      { name: 'Compact French', lang: 'fr-FR' },
    ]

    expect(pickPreferredBrowserSpeechVoice(voices)).toBe(voices[0])
  })

  it('returns null when no voices are available', () => {
    expect(pickPreferredBrowserSpeechVoice([])).toBeNull()
  })
})
