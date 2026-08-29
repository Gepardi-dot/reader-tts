import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Pause, Play, SkipBack, SkipForward, Volume2 } from 'lucide-react'
import { Slider } from '@/components/ui/slider'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { armHtmlMediaElement } from '@/lib/browser'
import { api, request } from '@/shared/api/client'
import type { RollingCacheState } from '@/shared/storage/rollingVoiceCache'
import { queuePerformanceTelemetry } from '@/shared/telemetry/performanceTelemetry'
import {
  DEFAULT_PREFETCH_AHEAD,
  PREFETCH_AHEAD_TARGET,
  SILENT_WAV_DATA_URL,
  audioPreferenceDraftChanged,
  committedVoiceForDraft,
  pacingFor,
} from './audioPlayback'
import {
  defaultVoiceForProvider,
  displayNameForTtsProvider,
  providerOptionsFromCatalog,
  PROVIDER_PREVIEW_TEXT,
  type ProvidersResponse,
  type ProviderTestResult,
} from './audioProviderCatalog'
import {
  audioErrorMessage,
  playableAudioUrl,
} from './tts-engine/liveAudio'
import {
  type AudioPhase,
  type PreviewAudioChunk as AudioChunk,
} from './tts-engine/types'

function unlockPreviewAudio(existing: HTMLAudioElement | null): HTMLAudioElement {
  const audio = existing ?? new Audio()
  armHtmlMediaElement(audio)
  audio.preservesPitch = true
  // Silent samples, not muted — iOS does not treat a muted play() as unlocking later unmuted playback.
  audio.muted = false
  audio.loop = false
  audio.src = SILENT_WAV_DATA_URL
  const playPromise = audio.play()
  if (playPromise && typeof playPromise.then === 'function') {
    playPromise.catch(() => undefined)
  }
  return audio
}

function attachPreviewUrl(audio: HTMLAudioElement, url: string, rate: number) {
  audio.src = url
  audio.muted = false
  audio.preservesPitch = true
  audio.playbackRate = rate
}

function bindPreviewPlayback(
  audio: HTMLAudioElement,
  handlers: {
    onEnded: () => void
    onError: () => void
    onBlocked: () => void
  },
) {
  audio.onended = handlers.onEnded
  audio.onerror = handlers.onError
  audio.play().catch(handlers.onBlocked)
}

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
  rollingCacheState: _rollingCacheState,
  currentBookId: _currentBookId,
}: AudioPreviewPanelProps) {
  void _rollingCacheState
  void _currentBookId
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
  const previewTargetRef = useRef<{ provider: string; voice: string | null }>({
    provider,
    voice,
  })
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
  const initialProvider = providerOptions.some((p) => p.id === provider)
    ? provider
    : (providerOptions.find((p) => p.recommended)?.id ?? providerOptions[0]?.id ?? 'kokoro')
  const [draftProvider, setDraftProvider] = useState(initialProvider)
  const [draftVoice, setDraftVoice] = useState<string | null>(voice)

  // If parent prefs still pointed at a removed provider (browser), resolve to Kokoro/Gemini
  // without setState-in-effect (eslint react-hooks/set-state-in-effect).
  const draftProviderKnown = providerOptions.some((p) => p.id === draftProvider)
  const resolvedDraftProvider = draftProviderKnown
    ? draftProvider
    : (providerOptions.find((p) => p.recommended)?.id
      ?? providerOptions[0]?.id
      ?? 'kokoro')
  const activeProvider = providerOptions.find(p => p.id === resolvedDraftProvider)
  const catalogVoices = activeProvider?.voices ?? []
  const providerVoices = catalogVoices
  const selectedProviderUnavailable = Boolean(providersRes?.providers?.length && (!activeProvider || !activeProvider.available))
  const draftVoiceMatchesProvider = Boolean(
    draftVoice
    && providerVoices.some((item) => item.id === draftVoice),
  )
  // When we silently remapped the provider, use that provider's default voice until the user picks one.
  const selectedVoiceId = draftProviderKnown && draftVoiceMatchesProvider
    ? draftVoice
    : defaultVoiceForProvider(activeProvider)
  const selectedVoiceIndex = providerVoices.findIndex((item) => item.id === selectedVoiceId)
  const appliedVoice = committedVoiceForDraft(resolvedDraftProvider, selectedVoiceId)
  const committedProviderInfo = providerOptions.find(p => p.id === provider)
  const committedVoiceLabel = committedProviderInfo
    ?.voices.find((item) => item.id === voice)
    ?.label ?? voice ?? committedProviderInfo?.label ?? displayNameForTtsProvider('kokoro')
  const hasDraftChanges = audioPreferenceDraftChanged({
    committedProvider: provider,
    committedVoice: voice,
    draftProvider: resolvedDraftProvider,
    draftVoice: selectedVoiceId,
  })

  function applyDraftSelection() {
    if (selectedProviderUnavailable) {
      const message = `${activeProvider?.label ?? resolvedDraftProvider} is not configured yet. Choose an available provider.`
      setErrorMsg(message)
      onError?.(message)
      return
    }
    stopPlayback()
    setErrorMsg(null)
    onSelectionChange({ provider: resolvedDraftProvider, voice: appliedVoice })
    onCommitVoice?.({ provider: resolvedDraftProvider, voice: appliedVoice })
    queuePerformanceTelemetry({
      eventName: 'tts.voice_apply',
      provider: resolvedDraftProvider,
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
        const playProvider = previewTargetRef.current.provider
        const playVoice = previewTargetRef.current.voice
        const { lengthScale, sentenceSilence } = pacingFor(playProvider)
        const previewLengthScale = Math.max(0.6, Math.min(lengthScale * rateRef.current, 1.5))
        const preview = await request<ProviderTestResult>('/api/providers/test', {
          method: 'POST',
          body: JSON.stringify({
            provider: playProvider,
            voice: playVoice,
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
    const target = PREFETCH_AHEAD_TARGET[previewTargetRef.current.provider] ?? DEFAULT_PREFETCH_AHEAD
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
    const audio = unlockPreviewAudio(audioRef.current)
    audioRef.current = audio
    primedAudioRef.current = audio
    return audio
  }

  function playChunkAt(idx: number, currentChunks: AudioChunk[], ctrl: AbortController) {
    const c = currentChunks[idx]
    if (!c?.url) return

    const audio = audioRef.current ?? new Audio()
    const wasPrimedForThisTap = primedAudioRef.current === audio
    if (!wasPrimedForThisTap) audio.pause()
    attachPreviewUrl(audio, c.url, rateRef.current)
    audioRef.current = audio
    primedAudioRef.current = null
    setPhase('playing')
    setCurIdx(idx)
    curIdxRef.current = idx
    setErrorMsg(null)
    prefetchAhead(idx, currentChunks, ctrl.signal)
    bindPreviewPlayback(audio, {
      onEnded: () => {
        if (ctrl.signal.aborted) return
        void continuePlayback(idx + 1, ctrl)
      },
      onError: () => {
        if (ctrl.signal.aborted) return
        setErrorMsg('Audio playback failed. Try starting it again.')
        setPhase('idle')
      },
      onBlocked: () => {
        if (ctrl.signal.aborted) return
        setPhase('paused')
        setErrorMsg('Audio is ready. Tap play again to start playback.')
      },
    })
  }

  async function startPlayback(
    playProvider = resolvedDraftProvider,
    playVoice = selectedVoiceId,
  ) {
    abortRef.current?.abort()
    const primedAudio = primedAudioRef.current
    if (audioRef.current && audioRef.current !== primedAudio) {
      audioRef.current.pause()
    }
    revokeAudioObjectUrls()
    chunkFetchesRef.current.clear()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    previewTargetRef.current = { provider: playProvider, voice: playVoice }
    setErrorMsg(null)

    const playProviderInfo = providerOptions.find((item) => item.id === playProvider)
    if (playProviderInfo && !playProviderInfo.available) {
      const message = `${playProviderInfo.label} is not configured yet. Choose an available provider.`
      setErrorMsg(message)
      onError?.(message)
      return
    }

    if (!playVoice) {
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
    primedAudioRef.current = null
    revokeAudioObjectUrls()
    chunkFetchesRef.current.clear()
    setPhase('idle')
    setCurIdx(0)
    curIdxRef.current = 0
  }

  function togglePlay() {
    if (phase === 'playing') {
      audioRef.current?.pause()
      setPhase('paused')
    } else if (phase === 'paused') {
      setErrorMsg(null)
      const audio = audioRef.current
      if (!audio) return
      audio.muted = false
      audio.play()
        .then(() => setPhase('playing'))
        .catch(() => {
          setErrorMsg('Playback was blocked by the browser. Tap play again.')
          setPhase('paused')
        })
    } else if (phase === 'buffering') {
      stopPlayback()
    } else if (phase === 'idle') {
      primeAudioElement()
      void startPlayback()
    }
  }

  function previewSelection(nextProvider: string, nextVoice: string | null, source: string) {
    stopPlayback()
    setErrorMsg(null)
    setDraftProvider(nextProvider)
    setDraftVoice(nextVoice)
    if (!nextVoice) return
    queuePerformanceTelemetry({
      eventName: 'tts.voice_draft_changed',
      provider: nextProvider,
      metadata: {
        source,
        voice: nextVoice,
      },
    })
    const nextInfo = providerOptions.find((item) => item.id === nextProvider)
    if (nextInfo && !nextInfo.available) {
      const message = `${nextInfo.label} is not configured yet. Choose an available provider.`
      setErrorMsg(message)
      onError?.(message)
      return
    }
    primeAudioElement()
    void startPlayback(nextProvider, nextVoice)
  }

  function previewVoice(nextVoice: string, source: string) {
    if (!nextVoice) return
    previewSelection(resolvedDraftProvider, nextVoice, source)
  }

  const isIdle = phase === 'idle'
  const isBuffering = phase === 'buffering'
  const isPlaying = phase === 'playing'
  const isPaused = phase === 'paused'
  const playDisabled = selectedProviderUnavailable || !selectedVoiceId
  const selectedVoiceLabel = providerVoices.find((item) => item.id === selectedVoiceId)?.label
    ?? selectedVoiceId
    ?? 'voice'
  const playStatusLabel = isBuffering
    ? `Generating ${selectedVoiceLabel}`
    : isPlaying
      ? `Playing ${selectedVoiceLabel}`
      : isPaused
        ? `Resume ${selectedVoiceLabel}`
        : `Play ${selectedVoiceLabel}`

  const totalChunks = chunks.length
  const readyChunks = chunks.filter(c => c.status === 'ready').length
  const showProgress = !isIdle && totalChunks > 1

  const bufferLabel = (() => {
    if (!isBuffering) return null
    if (resolvedDraftProvider === 'neutts_local' || resolvedDraftProvider === 'kokoro') return 'Generating sample…'
    return 'Loading preview…'
  })()

  function cycleVoice(direction: -1 | 1) {
    if (providerVoices.length < 2) return
    const baseIndex = selectedVoiceIndex >= 0 ? selectedVoiceIndex : 0
    const nextIndex = (baseIndex + direction + providerVoices.length) % providerVoices.length
    previewVoice(providerVoices[nextIndex].id, direction > 0 ? 'next' : 'previous')
  }

  return (
    <div className="px-3.5 pt-2.5 space-y-3" style={{ color: colors.text, paddingBottom: 16 }}>
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-widest opacity-40 mb-1">Provider</p>
        <Select value={resolvedDraftProvider} onValueChange={(v) => {
          if (v == null) return
          const nextProvider = providerOptions.find(p => p.id === v)
          previewSelection(v, defaultVoiceForProvider(nextProvider), 'provider_select')
        }}>
          <SelectTrigger className="w-full h-9 text-sm">
            <SelectValue>
              {activeProvider?.label ?? displayNameForTtsProvider(resolvedDraftProvider)}
            </SelectValue>
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false} side="bottom">
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
              previewVoice(v, 'voice_select')
            }}
          >
            <SelectTrigger className="w-full h-9 text-sm">
              <SelectValue>{selectedVoiceLabel}</SelectValue>
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false} side="top">
              {providerVoices.map((v) => {
                const isCurrent = v.id === selectedVoiceId
                return (
                  <SelectItem key={v.id} value={v.id}>
                    <span className="flex w-full min-w-0 items-center justify-between gap-3">
                      <span className="truncate">{v.label}</span>
                      <Volume2
                        size={14}
                        className={isCurrent && (isPlaying || isBuffering) ? 'opacity-90' : 'opacity-35'}
                      />
                    </span>
                  </SelectItem>
                )
              })}
            </SelectContent>
          </Select>

          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={() => cycleVoice(-1)}
              disabled={providerVoices.length < 2}
              className="h-10 w-10 shrink-0 rounded-full flex items-center justify-center opacity-35 hover:opacity-70 transition-opacity disabled:opacity-15"
              aria-label="Previous voice"
            >
              <SkipBack size={16} />
            </button>
            <button
              type="button"
              onClick={togglePlay}
              disabled={playDisabled}
              className="flex-1 h-10 rounded-full bg-primary text-white flex items-center justify-center gap-2 text-[13px] font-medium shadow-sm active:scale-[0.98] transition-transform disabled:opacity-50"
              aria-label={
                isBuffering
                  ? 'Cancel voice sample'
                  : isPlaying
                    ? 'Pause voice sample'
                    : 'Play voice sample'
              }
            >
              {isBuffering
                ? <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                : (isPlaying
                    ? <Pause size={16} />
                    : <Play size={16} fill="currentColor" />
                  )}
              <span className="truncate max-w-[11rem]">{playStatusLabel}</span>
            </button>
            <button
              type="button"
              onClick={() => cycleVoice(1)}
              disabled={providerVoices.length < 2}
              className="h-10 w-10 shrink-0 rounded-full flex items-center justify-center opacity-35 hover:opacity-70 transition-opacity disabled:opacity-15"
              aria-label="Next voice"
            >
              <SkipForward size={16} />
            </button>
          </div>
          <p className="mt-1.5 text-[11px] leading-4 opacity-40">
            A sample plays as soon as you pick a voice.
          </p>
        </div>
      )}

      <div
        className="rounded-xl border px-3 py-2 space-y-1"
        style={{
          borderColor: isPlaying || isBuffering ? `${colors.text}28` : `${colors.text}12`,
          background: `${colors.text}05`,
        }}
      >
        <p className="text-[10px] font-semibold uppercase tracking-widest opacity-40">
          {isPlaying || isBuffering ? `Sample · ${selectedVoiceLabel}` : 'Voice Sample'}
        </p>
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

      {errorMsg && (
        <p className="rounded-xl border px-3 py-2 text-xs leading-relaxed" style={{ borderColor: `${colors.text}18`, background: `${colors.text}08`, color: colors.text }}>
          {errorMsg}
        </p>
      )}
    </div>
  )
}
