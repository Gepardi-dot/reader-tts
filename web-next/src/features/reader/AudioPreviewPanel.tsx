import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Pause, Play, SkipBack, SkipForward } from 'lucide-react'
import { Slider } from '@/components/ui/slider'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api, request } from '@/shared/api/client'
import { waitForModelReady } from '@/shared/storage/modelCache'
import type { RollingCacheState } from '@/shared/storage/rollingVoiceCache'
import { queuePerformanceTelemetry } from '@/shared/telemetry/performanceTelemetry'
import {
  BROWSER_TTS_PROVIDER_ID,
  DEFAULT_PREFETCH_AHEAD,
  PREFETCH_AHEAD_TARGET,
  SILENT_WAV_DATA_URL,
  audioPreferenceDraftChanged,
  committedVoiceForDraft,
  pacingFor,
} from './audioPlayback'
import {
  defaultVoiceForProvider,
  providerOptionsFromCatalog,
  PROVIDER_PREVIEW_TEXT,
  type ProvidersResponse,
  type ProviderTestResult,
} from './audioProviderCatalog'
import {
  preferredBrowserSpeechVoice,
  supportsBrowserSpeech,
} from './browserSpeech'
import {
  audioErrorMessage,
  playableAudioUrl,
} from './tts-engine/liveAudio'
import {
  type AudioPhase,
  type PreviewAudioChunk as AudioChunk,
} from './tts-engine/types'
import { synthesizeKokoroLocal } from './tts-engine/kokoroAudio'

const KOKORO_PREVIEW_TEXT = 'The story found its rhythm, warm and clear.'

export interface AudioPreviewColors {
  bg: string
  text: string
  bar: string
}

export interface AudioPreviewPanelProps {
  colors: AudioPreviewColors
  provider: string
  voice: string | null
  onSelectionChange: (selection: { provider: string; voice: string | null }) => void
  onError?: (message: string) => void
  rate?: number
  onRateChange?: (rate: number) => void
  onCommitVoice?: (selection: { provider: string; voice: string | null }) => boolean
  rollingCacheState?: RollingCacheState
  currentBookId?: string | null
}

export function AudioPreviewPanel({
  colors,
  provider,
  voice,
  onSelectionChange,
  onError,
  rate: rateProp,
  onRateChange,
  onCommitVoice,
  rollingCacheState,
  currentBookId,
}: AudioPreviewPanelProps) {
  const [phase, setPhase] = useState<AudioPhase>('idle')
  const [chunks, setChunks] = useState<AudioChunk[]>([])
  const [curIdx, setCurIdx] = useState(0)
  const [rate, setRate] = useState(rateProp ?? 1.0)
  const [sampleText, setSampleText] = useState(PROVIDER_PREVIEW_TEXT)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const rateRef = useRef(rate)
  const chunksRef = useRef<AudioChunk[]>([])
  const curIdxRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  const audioObjectUrlsRef = useRef<Set<string>>(new Set())
  const chunkFetchesRef = useRef<Map<number, Promise<string | null>>>(new Map())
  const primedAudioRef = useRef<HTMLAudioElement | null>(null)
  const speechPreviewRef = useRef<SpeechSynthesisUtterance | null>(null)
  rateRef.current = rate
  chunksRef.current = chunks

  function rememberAudioObjectUrl(url: string) {
    if (url.startsWith('blob:')) audioObjectUrlsRef.current.add(url)
  }

  function revokeAudioObjectUrls() {
    for (const url of audioObjectUrlsRef.current) URL.revokeObjectURL(url)
    audioObjectUrlsRef.current.clear()
  }

  useEffect(() => () => {
    abortRef.current?.abort()
    audioRef.current?.pause()
    if (supportsBrowserSpeech()) window.speechSynthesis.cancel()
    speechPreviewRef.current = null
    primedAudioRef.current = null
    chunkFetchesRef.current.clear()
    revokeAudioObjectUrls()
  }, [])

  const { data: providersRes } = useQuery({
    queryKey: ['providers'],
    queryFn: () => api.get<ProvidersResponse>('/api/providers'),
    staleTime: 5 * 60_000,
  })
  const providerOptions = providerOptionsFromCatalog(providersRes?.providers)
  const [draftProvider, setDraftProvider] = useState(provider)
  const [draftVoice, setDraftVoice] = useState<string | null>(voice)

  const activeProvider = providerOptions.find(p => p.id === draftProvider)
  const providerVoices = activeProvider?.voices ?? []
  const selectedProviderUnavailable = Boolean(providersRes?.providers?.length && (!activeProvider || !activeProvider.available))
  const draftVoiceIsAvailable = Boolean(draftVoice && providerVoices.some((item) => item.id === draftVoice))
  const selectedVoiceId = draftProvider === BROWSER_TTS_PROVIDER_ID
    ? null
    : (draftVoiceIsAvailable ? draftVoice : defaultVoiceForProvider(activeProvider))
  const selectedVoiceIndex = providerVoices.findIndex((item) => item.id === selectedVoiceId)
  const appliedVoice = committedVoiceForDraft(draftProvider, selectedVoiceId)
  const committedProviderInfo = providerOptions.find(p => p.id === provider)
  const committedVoiceLabel = committedProviderInfo
    ?.voices.find((item) => item.id === voice)
    ?.label ?? voice ?? committedProviderInfo?.label ?? 'Browser speech'
  const hasDraftChanges = audioPreferenceDraftChanged({
    committedProvider: provider,
    committedVoice: voice,
    draftProvider,
    draftVoice: selectedVoiceId,
  })

  function applyDraftSelection() {
    if (selectedProviderUnavailable) {
      const message = `${activeProvider?.label ?? draftProvider} is not configured yet. Choose an available provider.`
      setErrorMsg(message)
      onError?.(message)
      return
    }
    stopPlayback()
    setErrorMsg(null)
    onSelectionChange({ provider: draftProvider, voice: appliedVoice })
    onCommitVoice?.({ provider: draftProvider, voice: appliedVoice })
    queuePerformanceTelemetry({
      eventName: 'tts.voice_apply',
      provider: draftProvider,
      metadata: {
        previousProvider: provider,
        previousVoice: voice ?? '',
        nextVoice: appliedVoice ?? '',
      },
    })
  }

  function updateChunk(idx: number, patch: Partial<AudioChunk>) {
    const next = [...chunksRef.current]
    if (next[idx]) next[idx] = { ...next[idx], ...patch }
    chunksRef.current = next
    setChunks(next)
  }

  async function fetchChunk(idx: number, _chunk: AudioChunk, signal: AbortSignal): Promise<string | null> {
    const existingChunk = chunksRef.current[idx]
    if (existingChunk?.url) return existingChunk.url
    const existingFetch = chunkFetchesRef.current.get(idx)
    if (existingFetch) return existingFetch

    updateChunk(idx, { status: 'fetching' })
    const fetchPromise = (async () => {
      try {
        if (draftProvider === 'kokoro') {
          const voiceId = selectedVoiceId
          if (!voiceId) throw new Error('Choose a voice to preview.')

          const ready = await waitForModelReady(signal)
          if (signal.aborted) return null
          if (!ready) throw new Error('The on-device voice is still preparing. Try again in a moment.')

          const { lengthScale } = pacingFor('kokoro')
          const speed = lengthScale > 0 ? 1 / lengthScale : 1
          const preview = await synthesizeKokoroLocal(KOKORO_PREVIEW_TEXT, voiceId, speed, signal)
          if (signal.aborted) return null
          if (!preview) throw new Error('Kokoro could not generate this voice sample. Try another voice or retry after preparation finishes.')

          const url = URL.createObjectURL(preview.blob)
          rememberAudioObjectUrl(url)
          setSampleText(KOKORO_PREVIEW_TEXT)
          updateChunk(idx, { status: 'ready', url })
          return url
        }

        const { lengthScale, sentenceSilence } = pacingFor(draftProvider)
        const previewLengthScale = Math.max(0.6, Math.min(lengthScale * rateRef.current, 1.5))
        const preview = await request<ProviderTestResult>('/api/providers/test', {
          method: 'POST',
          body: JSON.stringify({
            provider: draftProvider,
            voice: selectedVoiceId,
            model: null,
            narration_style: '',
            length_scale: previewLengthScale,
            sentence_silence: sentenceSilence,
          }),
          signal,
        })
        if (signal.aborted) return null
        const playable = await playableAudioUrl(preview.audioUrl, signal)
        if (signal.aborted) {
          playable.revoke()
          return null
        }
        setSampleText(preview.sampleText || PROVIDER_PREVIEW_TEXT)
        rememberAudioObjectUrl(playable.url)
        updateChunk(idx, { status: 'ready', url: playable.url })
        return playable.url
      } catch (e) {
        if ((e as Error).name !== 'AbortError') {
          const message = audioErrorMessage(e)
          setErrorMsg(message)
          onError?.(message)
          updateChunk(idx, { status: 'error' })
        }
        return null
      } finally {
        chunkFetchesRef.current.delete(idx)
      }
    })()

    chunkFetchesRef.current.set(idx, fetchPromise)
    return fetchPromise
  }

  function prefetchAhead(fromIdx: number, currentChunks: AudioChunk[], signal: AbortSignal) {
    if (signal.aborted) return
    const target = PREFETCH_AHEAD_TARGET[draftProvider] ?? DEFAULT_PREFETCH_AHEAD
    for (let offset = 1; offset <= target; offset += 1) {
      const idx = fromIdx + offset
      const chunk = currentChunks[idx]
      if (!chunk) break
      if (chunk.url || chunk.status === 'fetching') continue
      if (chunk.status === 'idle') {
        void fetchChunk(idx, chunk, signal)
      }
    }
  }

  async function continuePlayback(nextIdx: number, ctrl: AbortController) {
    const latest = chunksRef.current
    if (nextIdx >= latest.length) {
      setPhase('idle')
      setCurIdx(0)
      curIdxRef.current = 0
      revokeAudioObjectUrls()
      return
    }

    const nextChunk = latest[nextIdx]
    if (nextChunk.url) {
      playChunkAt(nextIdx, latest, ctrl)
      return
    }

    setPhase('buffering')
    const url = await fetchChunk(nextIdx, nextChunk, ctrl.signal)
    if (ctrl.signal.aborted) return
    if (!url) {
      setPhase('idle')
      return
    }
    playChunkAt(nextIdx, chunksRef.current, ctrl)
  }

  function primeAudioElement(): HTMLAudioElement {
    let audio = audioRef.current
    if (!audio) {
      audio = new Audio()
      audio.preservesPitch = true
      audioRef.current = audio
    }
    audio.muted = true
    audio.loop = false
    audio.src = SILENT_WAV_DATA_URL
    primedAudioRef.current = audio
    const playPromise = audio.play()
    if (playPromise && typeof playPromise.then === 'function') {
      playPromise.catch(() => undefined)
    }
    return audio
  }

  function playChunkAt(idx: number, currentChunks: AudioChunk[], ctrl: AbortController) {
    const c = currentChunks[idx]
    if (!c?.url) return

    const audio = audioRef.current ?? new Audio()
    const wasPrimedForThisTap = primedAudioRef.current === audio
    if (!wasPrimedForThisTap) audio.pause()
    audio.src = c.url
    audio.muted = false
    audio.preservesPitch = true
    audio.playbackRate = rateRef.current
    audioRef.current = audio
    primedAudioRef.current = null
    setPhase('playing')
    setCurIdx(idx)
    curIdxRef.current = idx
    setErrorMsg(null)
    audio.play().catch(() => {
      if (ctrl.signal.aborted) return
      setPhase('paused')
      setErrorMsg('Audio is ready. Tap play again to start playback.')
    })

    prefetchAhead(idx, currentChunks, ctrl.signal)

    audio.onended = () => {
      if (ctrl.signal.aborted) return
      void continuePlayback(idx + 1, ctrl)
    }
    audio.onerror = () => {
      if (ctrl.signal.aborted) return
      setErrorMsg('Audio playback failed. Try starting it again.')
      setPhase('idle')
    }
  }

  async function startPlayback() {
    abortRef.current?.abort()
    const primedAudio = primedAudioRef.current
    if (audioRef.current && audioRef.current !== primedAudio) {
      audioRef.current.pause()
    }
    revokeAudioObjectUrls()
    chunkFetchesRef.current.clear()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setErrorMsg(null)

    if (selectedProviderUnavailable) {
      const message = `${activeProvider?.label ?? draftProvider} is not configured yet. Choose an available provider.`
      setErrorMsg(message)
      onError?.(message)
      return
    }

    if (draftProvider === BROWSER_TTS_PROVIDER_ID) {
      if (!supportsBrowserSpeech()) {
        const message = 'Browser speech is not supported by this browser.'
        setErrorMsg(message)
        onError?.(message)
        return
      }

      const utterance = new SpeechSynthesisUtterance(sampleText)
      const voice = preferredBrowserSpeechVoice()
      if (voice) utterance.voice = voice
      utterance.lang = voice?.lang || 'en-US'
      utterance.rate = Math.max(0.5, Math.min(rateRef.current, 2))
      utterance.pitch = 1
      utterance.volume = 1
      utterance.onstart = () => setPhase('playing')
      utterance.onend = () => {
        if (speechPreviewRef.current === utterance) {
          speechPreviewRef.current = null
          setPhase('idle')
        }
      }
      utterance.onerror = (event) => {
        if (event.error === 'interrupted') return
        speechPreviewRef.current = null
        setErrorMsg('Browser speech stopped. Tap play to try again.')
        setPhase('idle')
      }

      window.speechSynthesis.cancel()
      speechPreviewRef.current = utterance
      const initial: AudioChunk[] = [{
        start: 0,
        end: sampleText.length,
        text: sampleText,
        url: null,
        buffer: null,
        status: 'ready',
      }]
      setChunks(initial)
      chunksRef.current = initial
      setCurIdx(0)
      curIdxRef.current = 0
      setPhase('buffering')
      window.speechSynthesis.speak(utterance)
      return
    }

    if (!selectedVoiceId) {
      setErrorMsg('Choose a voice to preview.')
      return
    }

    const initial: AudioChunk[] = [{ start: 0, end: 0, text: sampleText, url: null, buffer: null, status: 'idle' }]
    setChunks(initial)
    chunksRef.current = initial
    setCurIdx(0)
    curIdxRef.current = 0
    setPhase('buffering')

    const url0 = await fetchChunk(0, initial[0], ctrl.signal)
    if (ctrl.signal.aborted || !url0) {
      setPhase('idle')
      return
    }

    playChunkAt(0, chunksRef.current, ctrl)
  }

  function stopPlayback() {
    abortRef.current?.abort()
    audioRef.current?.pause()
    if (supportsBrowserSpeech()) window.speechSynthesis.cancel()
    speechPreviewRef.current = null
    primedAudioRef.current = null
    revokeAudioObjectUrls()
    chunkFetchesRef.current.clear()
    setPhase('idle')
    setCurIdx(0)
    curIdxRef.current = 0
  }

  function togglePlay() {
    if (phase === 'playing') {
      if (draftProvider === BROWSER_TTS_PROVIDER_ID && supportsBrowserSpeech()) {
        window.speechSynthesis.pause()
      } else {
        audioRef.current?.pause()
      }
      setPhase('paused')
    } else if (phase === 'paused') {
      setErrorMsg(null)
      if (draftProvider === BROWSER_TTS_PROVIDER_ID && supportsBrowserSpeech()) {
        window.speechSynthesis.resume()
        setPhase('playing')
        return
      }
      const audio = audioRef.current
      if (!audio) return
      audio.muted = false
      audio.play()
        .then(() => setPhase('playing'))
        .catch(() => {
          setErrorMsg('Playback was blocked by the browser. Tap play again.')
          setPhase('paused')
        })
    } else if (phase === 'idle') {
      if (draftProvider !== BROWSER_TTS_PROVIDER_ID) primeAudioElement()
      void startPlayback()
    }
  }

  const isIdle = phase === 'idle'
  const isBuffering = phase === 'buffering'
  const isPlaying = phase === 'playing'
  const isPaused = phase === 'paused'
  const playDisabled = isBuffering || selectedProviderUnavailable || (draftProvider !== BROWSER_TTS_PROVIDER_ID && !selectedVoiceId)

  const totalChunks = chunks.length
  const readyChunks = chunks.filter(c => c.status === 'ready').length
  const showProgress = !isIdle && totalChunks > 1

  const bufferLabel = (() => {
    if (!isBuffering) return null
    if (draftProvider === 'neutts_local' || draftProvider === 'kokoro') return 'Generating sample…'
    return 'Loading preview…'
  })()

  function cycleVoice(direction: -1 | 1) {
    if (providerVoices.length < 2) return
    const baseIndex = selectedVoiceIndex >= 0 ? selectedVoiceIndex : 0
    const nextIndex = (baseIndex + direction + providerVoices.length) % providerVoices.length
    stopPlayback()
    setErrorMsg(null)
    setDraftVoice(providerVoices[nextIndex].id)
    queuePerformanceTelemetry({
      eventName: 'tts.voice_draft_changed',
      provider: draftProvider,
      metadata: {
        source: direction > 0 ? 'next' : 'previous',
        voice: providerVoices[nextIndex].id,
      },
    })
  }

  return (
    <div className="px-3.5 pt-2.5 space-y-3" style={{ color: colors.text, paddingBottom: 16 }}>
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-widest opacity-40 mb-1">Provider</p>
        <Select value={draftProvider} onValueChange={(v) => {
          if (v == null) return
          stopPlayback()
          setErrorMsg(null)
          const nextProvider = providerOptions.find(p => p.id === v)
          setDraftProvider(v)
          setDraftVoice(defaultVoiceForProvider(nextProvider))
          queuePerformanceTelemetry({
            eventName: 'tts.voice_draft_changed',
            provider: v,
            metadata: {
              source: 'provider_select',
              voice: defaultVoiceForProvider(nextProvider) ?? '',
            },
          })
        }}>
          <SelectTrigger className="w-full h-9 text-sm"><SelectValue /></SelectTrigger>
          <SelectContent>
            {providerOptions.map((p) => (
              <SelectItem key={p.id} value={p.id} disabled={!p.available}>
                {p.label}{p.available ? '' : ' (not configured)'}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {providerVoices.length > 0 && (
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-widest opacity-40 mb-1">Voice</p>
          <Select
            value={selectedVoiceId ?? (providerVoices[0]?.id ?? '')}
            onValueChange={(v) => {
              if (v == null) return
              stopPlayback()
              setErrorMsg(null)
              setDraftVoice(v)
              queuePerformanceTelemetry({
                eventName: 'tts.voice_draft_changed',
                provider: draftProvider,
                metadata: {
                  source: 'voice_select',
                  voice: v,
                },
              })
            }}
          >
            <SelectTrigger className="w-full h-9 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              {providerVoices.map((v) => (
                <SelectItem key={v.id} value={v.id}>{v.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          {provider === 'kokoro' && onCommitVoice && currentBookId && !hasDraftChanges && (() => {
            const rcs = rollingCacheState
            const isThisBookVoice = rcs?.bookId === currentBookId && rcs?.voice === voice
            const isActive = Boolean(isThisBookVoice && rcs?.active)
            const completed = isThisBookVoice ? (rcs?.completed ?? 0) : 0
            const total = isThisBookVoice ? (rcs?.total ?? 0) : 0
            const pct = total > 0 ? Math.round((completed / total) * 100) : 0
            const isDone = isThisBookVoice && !rcs?.active && total > 0 && completed >= total
            const preparationError = isThisBookVoice && !isActive ? rcs?.error : null
            return (
              <div className="mt-2">
                <button
                  type="button"
                  onClick={() => {
                    setErrorMsg(null)
                    const started = onCommitVoice({ provider, voice })
                    if (!started) {
                      const message = 'Kokoro is still preparing. Try playback now, or retry voice preparation shortly.'
                      setErrorMsg(message)
                      onError?.(message)
                    }
                  }}
                  disabled={isActive}
                  className="w-full h-9 rounded-md text-[12px] font-medium transition-all active:scale-[0.99] disabled:cursor-not-allowed"
                  style={{
                    border: `1px solid ${colors.text}18`,
                    background: isActive ? `${colors.text}06` : `${colors.text}0a`,
                    color: isActive ? `${colors.text}90` : colors.text,
                  }}
                >
                  {isActive
                    ? `Preparing voice… ${pct}%`
                    : preparationError
                      ? 'Retry voice preparation'
                      : isDone
                      ? 'Voice ready · re-cache'
                      : 'Use this voice for this book'}
                </button>
                {isActive && (
                  <div className="mt-1.5 h-1 rounded-full overflow-hidden" style={{ background: `${colors.text}12` }}>
                    <div
                      className="h-full rounded-full transition-all duration-300"
                      style={{ width: `${pct}%`, background: colors.text, opacity: 0.4 }}
                    />
                  </div>
                )}
                {preparationError && (
                  <p className="mt-1.5 text-[11px] leading-4 opacity-55">
                    {preparationError}
                  </p>
                )}
              </div>
            )
          })()}
        </div>
      )}

      <div className="rounded-lg border px-3 py-2 space-y-2" style={{ borderColor: `${colors.text}12`, background: `${colors.text}05` }}>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-widest opacity-40">Current voice</p>
            <p className="text-[12px] opacity-70 truncate">{committedVoiceLabel}</p>
          </div>
          <button
            type="button"
            onClick={applyDraftSelection}
            disabled={!hasDraftChanges || selectedProviderUnavailable}
            className="h-8 px-3 rounded-md text-[12px] font-medium transition-all active:scale-[0.98] disabled:opacity-45 disabled:cursor-not-allowed"
            style={{
              background: hasDraftChanges ? colors.text : `${colors.text}0a`,
              color: hasDraftChanges ? colors.bg : `${colors.text}70`,
            }}
          >
            {hasDraftChanges ? 'Apply voice' : 'Applied'}
          </button>
        </div>
        {hasDraftChanges && (
          <p className="text-[11px] leading-4 opacity-50">
            Preview changes here first. Reading audio switches only after Apply.
          </p>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <p className="text-[10px] font-semibold uppercase tracking-widest opacity-40">Speed</p>
          <span className="text-[11px] opacity-40 tabular-nums">{rate.toFixed(1)}×</span>
        </div>
        <Slider value={[Math.round(rate * 10)]} min={5} max={25} step={1}
          onValueChange={(val) => {
            const r = (Array.isArray(val) ? val[0] : (val as number)) / 10
            setRate(r)
            onRateChange?.(r)
            rateRef.current = r
            if (audioRef.current) audioRef.current.playbackRate = r
          }} />
      </div>

      <div className="rounded-xl border px-3 py-2 space-y-1" style={{ borderColor: `${colors.text}12`, background: `${colors.text}05` }}>
        <p className="text-[10px] font-semibold uppercase tracking-widest opacity-40">Voice Sample</p>
        <p className="text-[12.5px] leading-5 opacity-70 italic line-clamp-3">
          "{sampleText}"
        </p>
      </div>

      {showProgress && (
        <div className="space-y-1.5">
          <div className="h-1 rounded-full overflow-hidden" style={{ background: `${colors.text}15` }}>
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{
                width: `${Math.round((readyChunks / totalChunks) * 100)}%`,
                background: colors.text,
                opacity: 0.35,
              }}
            />
          </div>
          <p className="text-[10px] opacity-35 text-center tabular-nums">
            {isPlaying || isPaused
              ? `Part ${curIdx + 1} of ${totalChunks}`
              : bufferLabel}
          </p>
        </div>
      )}

      {isBuffering && !showProgress && (
        <p className="text-xs text-center opacity-40">{bufferLabel}</p>
      )}

      {errorMsg && (
        <p className="rounded-xl border px-3 py-2 text-xs leading-relaxed" style={{ borderColor: `${colors.text}18`, background: `${colors.text}08`, color: colors.text }}>
          {errorMsg}
        </p>
      )}

      <div className="flex items-center justify-center gap-6 py-1 pb-2">
        <button
          onClick={() => cycleVoice(-1)}
          disabled={providerVoices.length < 2 || isBuffering}
          className="p-1.5 opacity-30 hover:opacity-60 transition-opacity disabled:opacity-15"
          aria-label="Previous voice"
        ><SkipBack size={18} /></button>
        <button
          onClick={togglePlay}
          disabled={playDisabled}
          className="w-12 h-12 rounded-full bg-primary text-white flex items-center justify-center shadow-lg active:scale-95 transition-transform disabled:opacity-50"
          aria-label={isPlaying ? 'Pause voice sample' : 'Play voice sample'}
        >
          {isBuffering
            ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
            : (isPlaying
                ? <Pause size={20} />
                : <Play size={20} fill="currentColor" />
              )}
        </button>
        <button
          onClick={() => cycleVoice(1)}
          disabled={providerVoices.length < 2 || isBuffering}
          className="p-1.5 opacity-30 hover:opacity-60 transition-opacity disabled:opacity-15"
          aria-label="Next voice"
        ><SkipForward size={18} /></button>
      </div>
    </div>
  )
}
