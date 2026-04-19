import type { AudioPreference, ProviderCatalog } from '@/shared/types/api'

const providerPriority: ProviderCatalog['id'][] = ['polly', 'google', 'qwen', 'openai', 'piper', 'qwen_local']

export function resolveAudioSelection(providers: ProviderCatalog[], preference: AudioPreference) {
  const availableProviders = providers.filter((provider) => provider.available)
  const provider =
    availableProviders.find((item) => item.id === preference.providerId) ??
    providerPriority.map((id) => availableProviders.find((providerItem) => providerItem.id === id)).find(Boolean) ??
    availableProviders[0] ??
    null

  if (!provider) {
    return {
      provider: null,
      voiceId: null,
      modelId: null,
    }
  }

  const modelId =
    provider.models.find((item) => item.id === preference.modelId)?.id ??
    provider.defaultModel ??
    provider.models[0]?.id ??
    null

  const availableVoices = modelId
    ? provider.voices.filter((voice) => !voice.models?.length || voice.models.includes(modelId))
    : provider.voices

  const voiceId =
    availableVoices.find((voice) => voice.id === preference.voiceId)?.id ??
    provider.defaultVoice ??
    availableVoices[0]?.id ??
    null

  return {
    provider,
    voiceId,
    modelId,
  }
}
