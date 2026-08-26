import { describe, expect, it } from 'vitest'
import {
  displayNameForTtsProvider,
  normalizeTtsProviders,
  providerOptionsFromCatalog,
} from './audioProviderCatalog'

describe('TTS provider display names', () => {
  it('brands Kokoro and Gemini for the picker', () => {
    expect(displayNameForTtsProvider('kokoro')).toBe('HR Voices')
    expect(displayNameForTtsProvider('google')).toBe('HR Ultra Realistic')
  })

  it('overrides API names so the dropdown never shows engine ids', () => {
    const options = providerOptionsFromCatalog([
      { id: 'kokoro', name: 'Kokoro', available: true, voices: [] },
      { id: 'google', name: 'google', available: true, voices: [] },
    ])
    expect(options.map((option) => ({ id: option.id, label: option.label }))).toEqual([
      { id: 'kokoro', label: 'HR Voices' },
      { id: 'google', label: 'HR Ultra Realistic' },
    ])
  })

  it('keeps internal ids unchanged', () => {
    const providers = normalizeTtsProviders([
      { id: 'kokoro', name: 'Kokoro TTS', available: true, voices: [] },
      { id: 'google', name: 'Gemini TTS', available: true, voices: [] },
    ])
    expect(providers.map((provider) => provider.id)).toEqual(['kokoro', 'google'])
    expect(providers.map((provider) => provider.name)).toEqual([
      'HR Voices',
      'HR Ultra Realistic',
    ])
  })
})
