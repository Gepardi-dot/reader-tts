import { audioBufferScheduledEndTime, audioBufferSourceStartTime, tapOffsetSeekSeconds } from '../audioPlayback'
import type { TtsAudioChunk } from './types'

interface PlayNativeChunkOptions {
  chunk: TtsAudioChunk
  rate: number
  tapOffset?: number | null
  signal: AbortSignal
  onStart: () => void
  onProgress: (currentTime: number, follow: boolean) => void
  onEnded: () => void
}

export class ClockedAudioSink {
  private ctx: AudioContext | null = null
  private source: AudioBufferSourceNode | null = null
  private scheduledEnd = 0
  private chunkStart = 0
  private seekSeconds = 0
  private rafId: number | null = null

  get active() {
    return this.ctx?.state === 'running' && Boolean(this.source)
  }

  ensureContext() {
    if (!this.ctx || this.ctx.state === 'closed') {
      this.ctx = new AudioContext()
      this.scheduledEnd = 0
      this.chunkStart = 0
      this.seekSeconds = 0
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
    this.stopProgress()
    try {
      if (this.source) {
        this.source.onended = null
        this.source.stop(0)
        this.source.disconnect()
      }
    } catch {
      // Already stopped.
    }
    this.source = null
    this.scheduledEnd = 0
    this.chunkStart = 0
    this.seekSeconds = 0
  }

  setRate(rate: number) {
    if (!this.source) return
    this.source.playbackRate.value = rate
  }

  close() {
    this.stop()
    void this.ctx?.close().catch(() => undefined)
    this.ctx = null
  }

  playChunk({
    chunk,
    rate,
    tapOffset,
    signal,
    onStart,
    onProgress,
    onEnded,
  }: PlayNativeChunkOptions) {
    const ctx = this.ensureContext()
    if (!chunk.buffer || signal.aborted) return false
    if (ctx.state === 'suspended') void ctx.resume()

    this.stop()

    const source = ctx.createBufferSource()
    source.buffer = chunk.buffer
    source.playbackRate.value = rate
    source.connect(ctx.destination)
    this.source = source

    const seekSeconds = tapOffsetSeekSeconds(chunk.start, tapOffset, chunk.cues)
    const now = ctx.currentTime
    const startAt = audioBufferSourceStartTime(now, this.scheduledEnd)
    source.start(startAt, seekSeconds > 0 ? seekSeconds : undefined)

    this.scheduledEnd = audioBufferScheduledEndTime({
      startAt,
      bufferDuration: chunk.buffer.duration,
      seekSeconds,
      playbackRate: rate,
    })
    this.chunkStart = startAt
    this.seekSeconds = seekSeconds

    onStart()
    onProgress(seekSeconds, true)
    this.startProgress(chunk, onProgress, signal)

    source.onended = () => {
      if (signal.aborted) return
      this.stopProgress()
      this.source = null
      onEnded()
    }
    return true
  }

  private startProgress(
    chunk: TtsAudioChunk,
    onProgress: (currentTime: number, follow: boolean) => void,
    signal: AbortSignal,
  ) {
    this.stopProgress()
    const tick = () => {
      if (signal.aborted) return
      const ctx = this.ctx
      if (!ctx || ctx.state === 'closed') return
      const currentTime = Math.max(0, ctx.currentTime - this.chunkStart) + this.seekSeconds
      onProgress(Math.min(currentTime, chunk.buffer?.duration ?? currentTime), false)
      this.rafId = requestAnimationFrame(tick)
    }
    this.rafId = requestAnimationFrame(tick)
  }

  private stopProgress() {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
  }
}
