import { createAudioContext } from '@/lib/browser'
import { audioBufferScheduledEndTime, audioBufferSourceStartTime, tapOffsetSeekSeconds } from '../audioPlayback'
import type { TtsAudioChunk } from './types'

interface PlayNativeRunOptions {
  chunks: readonly TtsAudioChunk[]
  startIndex: number
  rate: number
  tapOffset?: number | null
  signal: AbortSignal
  onChunkStart: (chunk: TtsAudioChunk, index: number) => void
  onProgress: (chunk: TtsAudioChunk, currentTime: number, follow: boolean) => void
  onRunDrained: (nextIndex: number) => void
}

interface ScheduledNativeChunk {
  index: number
  chunk: TtsAudioChunk
  source: AudioBufferSourceNode
  startAt: number
  endAt: number
  seekSeconds: number
}

interface ActiveNativeRun {
  token: number
  rate: number
  signal: AbortSignal
  onChunkStart: (chunk: TtsAudioChunk, index: number) => void
  onProgress: (chunk: TtsAudioChunk, currentTime: number, follow: boolean) => void
  onRunDrained: (nextIndex: number) => void
}

export class ClockedAudioSink {
  private ctx: AudioContext | null = null
  private sources: AudioBufferSourceNode[] = []
  private scheduled: ScheduledNativeChunk[] = []
  private activeIndex: number | null = null
  private rafId: number | null = null
  private activeRun: ActiveNativeRun | null = null
  private runToken = 0

  get active() {
    return this.ctx?.state === 'running' && this.sources.length > 0
  }

  ensureContext() {
    if (!this.ctx || this.ctx.state === 'closed') {
      this.ctx = createAudioContext()
      this.activeIndex = null
    }
    return this.ctx
  }

  async resume() {
    const ctx = this.ctx
    if (ctx && ctx.state === 'suspended') await ctx.resume()
  }

  async pause() {
    const ctx = this.ctx
    if (ctx && ctx.state === 'running') await ctx.suspend()
  }

  stop() {
    this.runToken += 1
    this.stopProgress()
    for (const source of this.sources) {
      try {
        source.onended = null
        source.stop(0)
        source.disconnect()
      } catch {
        // Already stopped.
      }
    }
    this.sources = []
    this.scheduled = []
    this.activeIndex = null
    this.activeRun = null
  }

  setRate(rate: number) {
    if (this.activeRun) this.activeRun.rate = rate
    for (const source of this.sources) {
      source.playbackRate.value = rate
    }
  }

  close() {
    this.stop()
    void this.ctx?.close().catch(() => undefined)
    this.ctx = null
  }

  playReadyRun({
    chunks,
    startIndex,
    rate,
    tapOffset,
    signal,
    onChunkStart,
    onProgress,
    onRunDrained,
  }: PlayNativeRunOptions) {
    const ctx = this.ensureContext()
    if (signal.aborted) return 0
    if (ctx.state === 'suspended') void ctx.resume()

    this.stop()
    const token = this.runToken
    this.activeRun = { token, rate, signal, onChunkStart, onProgress, onRunDrained }

    const scheduledCount = this.scheduleReadyRun({
      chunks,
      startIndex: Math.max(0, startIndex),
      rate,
      tapOffset: tapOffset ?? null,
      token,
    })
    if (scheduledCount === 0) {
      this.activeRun = null
      return 0
    }

    this.startProgress({ signal, onChunkStart, onProgress })
    return scheduledCount
  }

  extendReadyRun(chunks: readonly TtsAudioChunk[]) {
    const run = this.activeRun
    const lastScheduled = this.scheduled[this.scheduled.length - 1]
    if (!run || !lastScheduled || run.signal.aborted || run.token !== this.runToken) return 0

    return this.scheduleReadyRun({
      chunks,
      startIndex: lastScheduled.index + 1,
      rate: run.rate,
      tapOffset: null,
      token: run.token,
    })
  }

  private scheduleReadyRun({
    chunks,
    startIndex,
    rate,
    tapOffset,
    token,
  }: {
    chunks: readonly TtsAudioChunk[]
    startIndex: number
    rate: number
    tapOffset: number | null
    token: number
  }) {
    const ctx = this.ensureContext()
    const scheduledStart = Math.max(0, startIndex)
    let scheduledEnd = this.scheduled[this.scheduled.length - 1]?.endAt ?? ctx.currentTime
    let scheduledCount = 0

    for (let index = scheduledStart; index < chunks.length; index += 1) {
      const chunk = chunks[index]
      if (!chunk?.buffer) break

      const source = ctx.createBufferSource()
      source.buffer = chunk.buffer
      source.playbackRate.value = rate
      source.connect(ctx.destination)

      const seekSeconds = index === scheduledStart
        ? tapOffsetSeekSeconds(chunk.start, tapOffset, chunk.cues)
        : 0
      const startAt = audioBufferSourceStartTime(ctx.currentTime, scheduledEnd)
      const endAt = audioBufferScheduledEndTime({
        startAt,
        bufferDuration: chunk.buffer.duration,
        seekSeconds,
        playbackRate: rate,
      })
      source.start(startAt, seekSeconds > 0 ? seekSeconds : undefined)

      scheduledEnd = endAt
      const scheduledChunk = { index, chunk, source, startAt, endAt, seekSeconds }
      source.onended = () => this.handleSourceEnded(scheduledChunk, token)
      this.scheduled.push(scheduledChunk)
      this.sources.push(source)
      scheduledCount += 1
    }

    return scheduledCount
  }

  private handleSourceEnded(item: ScheduledNativeChunk, token: number) {
    const run = this.activeRun
    this.sources = this.sources.filter((source) => source !== item.source)
    if (!run || run.signal.aborted || token !== this.runToken) return

    const lastScheduled = this.scheduled[this.scheduled.length - 1]
    if (!lastScheduled || item.index !== lastScheduled.index) return

    this.stopProgress()
    this.activeRun = null
    run.onRunDrained(lastScheduled.index + 1)
  }

  private startProgress({
    signal,
    onChunkStart,
    onProgress,
  }: {
    signal: AbortSignal
    onChunkStart: (chunk: TtsAudioChunk, index: number) => void
    onProgress: (chunk: TtsAudioChunk, currentTime: number, follow: boolean) => void
  }) {
    this.stopProgress()
    const first = this.scheduled[0]
    if (first) this.activate(first, true, onChunkStart, onProgress)

    const tick = () => {
      if (signal.aborted) return
      const ctx = this.ctx
      if (!ctx || ctx.state === 'closed') return
      const now = ctx.currentTime
      const active = this.scheduled.find((item) => now >= item.startAt && now < item.endAt)
      if (active) {
        this.activate(active, false, onChunkStart, onProgress)
      }
      this.rafId = requestAnimationFrame(tick)
    }
    this.rafId = requestAnimationFrame(tick)
  }

  private activate(
    item: ScheduledNativeChunk,
    follow: boolean,
    onChunkStart: (chunk: TtsAudioChunk, index: number) => void,
    onProgress: (chunk: TtsAudioChunk, currentTime: number, follow: boolean) => void,
  ) {
    const ctx = this.ctx
    if (!ctx) return
    if (this.activeIndex !== item.index) {
      this.activeIndex = item.index
      onChunkStart(item.chunk, item.index)
    }
    const elapsed = Math.max(0, ctx.currentTime - item.startAt)
    const currentTime = Math.min(
      item.seekSeconds + elapsed,
      item.chunk.buffer?.duration ?? item.seekSeconds + elapsed,
    )
    onProgress(item.chunk, currentTime, follow)
  }

  private stopProgress() {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
  }
}
