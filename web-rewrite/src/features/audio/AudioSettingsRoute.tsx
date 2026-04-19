import { useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { getProviders, getStoredAudioPreference, persistAudioPreference, testProvider } from '@/shared/api/client'
import { useAudioStore } from '@/shared/state/audioStore'
import { resolveAudioSelection } from '@/shared/utils/audioPreference'
import styles from './AudioSettingsRoute.module.css'

export function AudioSettingsRoute() {
  const providersQuery = useQuery({ queryKey: ['providers'], queryFn: getProviders })
  const [preference, setPreference] = useState(getStoredAudioPreference())
  const [sampleText, setSampleText] = useState('Turn this page into a calm, articulate narration.')
  const setTrack = useAudioStore((state) => state.setTrack)

  const selection = useMemo(() => {
    return providersQuery.data
      ? resolveAudioSelection(providersQuery.data.providers, preference)
      : { provider: null, voiceId: null, modelId: null }
  }, [preference, providersQuery.data])

  const previewMutation = useMutation({
    mutationFn: () =>
      testProvider({
        provider: selection.provider!.id,
        voice: selection.voiceId,
        model: selection.modelId,
        sampleText,
        outputFormat: preference.outputFormat,
        narrationStyle: preference.narrationStyle,
        lengthScale: preference.lengthScale,
        sentenceSilence: preference.sentenceSilence,
      }),
    onSuccess: (result) => {
      setTrack(
        {
          id: `provider-preview:${Date.now()}`,
          url: result.audioUrl,
          title: result.provider,
          subtitle: result.message,
        },
        true,
      )
    },
  })

  return (
    <section className={styles.layout}>
      <article className={`surface ${styles.panel}`}>
        <div>
          <p className="eyebrow">Audio settings</p>
          <h2>Keep the learner-facing surface simple — voice and speed, nothing more.</h2>
        </div>

        <div className={styles.grid}>
          <label className="field">
            <span>Provider</span>
            <select
              className="select"
              onChange={(event) => setPreference((current) => ({ ...current, providerId: event.target.value as typeof current.providerId }))}
              value={preference.providerId ?? ''}
            >
              <option value="">Auto choose</option>
              {providersQuery.data?.providers.map((provider) => (
                <option disabled={!provider.available} key={provider.id} value={provider.id}>
                  {provider.name} {provider.available ? '' : '(Unavailable)'}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Voice</span>
            <select
              className="select"
              onChange={(event) => setPreference((current) => ({ ...current, voiceId: event.target.value || null }))}
              value={preference.voiceId ?? ''}
            >
              <option value="">Use default voice</option>
              {selection.provider?.voices.map((voice) => (
                <option key={voice.id} value={voice.id}>
                  {voice.label}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Model</span>
            <select
              className="select"
              onChange={(event) => setPreference((current) => ({ ...current, modelId: event.target.value || null }))}
              value={preference.modelId ?? ''}
            >
              <option value="">Use default model</option>
              {selection.provider?.models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Format</span>
            <select
              className="select"
              onChange={(event) => setPreference((current) => ({ ...current, outputFormat: event.target.value === 'wav' ? 'wav' : 'mp3' }))}
              value={preference.outputFormat}
            >
              <option value="mp3">mp3</option>
              <option value="wav">wav</option>
            </select>
          </label>

          <label className="field">
            <span>Narration style</span>
            <textarea
              className="textarea"
              onChange={(event) => setPreference((current) => ({ ...current, narrationStyle: event.target.value }))}
              value={preference.narrationStyle}
            />
          </label>

          <label className="field">
            <span>Preview text</span>
            <textarea className="textarea" onChange={(event) => setSampleText(event.target.value)} value={sampleText} />
          </label>
        </div>

        <div className={styles.actions}>
          <button className="button button--secondary" onClick={() => persistAudioPreference(preference)} type="button">
            Save preference
          </button>
          <button
            className="button button--primary"
            disabled={!selection.provider || previewMutation.isPending}
            onClick={() => previewMutation.mutate()}
            type="button"
          >
            {previewMutation.isPending ? 'Rendering preview...' : 'Render preview'}
          </button>
        </div>
      </article>
    </section>
  )
}
