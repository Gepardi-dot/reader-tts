import { describe, expect, it } from 'vitest'
import { paginateText } from '@/shared/utils/paginateText'
import { resolveAudioSelection } from '@/shared/utils/audioPreference'
import type { AudioPreference, ProviderCatalog } from '@/shared/types/api'

describe('paginateText', () => {
  it('splits long content into ordered reader pages', () => {
    const text = Array.from({ length: 12 }, (_, index) => `Paragraph ${index + 1} with enough words to expand the page size.`).join('\n\n')
    const pages = paginateText(text, 80)

    expect(pages.length).toBeGreaterThan(1)
    expect(pages[0].pageNumber).toBe(1)
    expect(pages.at(-1)?.end).toBe(text.length)
  })
})

describe('resolveAudioSelection', () => {
  const providers: ProviderCatalog[] = [
    {
      id: 'polly',
      name: 'Polly',
      available: true,
      recommended: true,
      description: '',
      voices: [{ id: 'Matthew', label: 'Matthew' }],
      defaultVoice: 'Matthew',
      models: [],
      defaultModel: null,
      voiceMetaNote: null,
    },
    {
      id: 'google',
      name: 'Google',
      available: true,
      recommended: false,
      description: '',
      voices: [{ id: 'Aoede', label: 'Aoede' }],
      defaultVoice: 'Aoede',
      models: [{ id: 'gemini', label: 'Gemini', description: '' }],
      defaultModel: 'gemini',
      voiceMetaNote: null,
    },
  ]

  it('prefers the saved provider when it is available', () => {
    const preference: AudioPreference = {
      providerId: 'google',
      voiceId: 'Aoede',
      modelId: 'gemini',
      outputFormat: 'mp3',
      narrationStyle: '',
      lengthScale: 1,
      sentenceSilence: 0.2,
    }

    const selection = resolveAudioSelection(providers, preference)

    expect(selection.provider?.id).toBe('google')
    expect(selection.voiceId).toBe('Aoede')
    expect(selection.modelId).toBe('gemini')
  })
})
