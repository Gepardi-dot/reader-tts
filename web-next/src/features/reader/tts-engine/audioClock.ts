import { audioBufferScheduledEndTime, audioBufferSourceStartTime } from '../audioPlayback'

export interface ClockUnitMeta {
  /** Logical text-chunk index for UI / follow highlighting. */
  chunkIndex: number
  /** Seek into the buffer (seconds). */
  seekSeconds?: number
  /** Optional cues for follow highlighting (buffer-relative). */
  cues?: readonly { start: number; timeStart: number }[]
}

export interface ScheduledClockUnit {
  unitId: number
  chunkIndex: number
  buffer: AudioBuffer
  source: AudioBufferSourceNode | null
  startAt: number
  endAt: number
  seekSeconds: number
  objectUrl?: string
}

export interface AudioClockHandlers {
  onUnitStart?: (unit: ScheduledClockUnit) => void
  onProgress?: (unit: ScheduledClockUnit, currentTime: number) => void
  /** Fired when the timeline runs dry while a session is still active. */
  onUnderrun?: (nextChunkIndex: number) => void
  /** Fired when the session has no more units and the last one finished. */
  onEnded?: () => void
}

/** Rates within this band use gapless Web Audio; outside → pitch-preserving HTMLAudio. */
const WEB_AUDIO_RATE_EPSILON = 0.02

function isWebAudioRate(rate: number) {
  return Math.abs(rate - 1) <= WEB_AUDIO_RATE_EPSILON
}

/**
 * Append-only audio scheduler.
 *
 * - Rate ≈ 1.0: Web Audio BufferSource (gapless, native pitch).
 * - Rate ≠ 1.0: HTMLAudioElement with preservesPitch (no chipmunk / robotic pitch shift).
 *
 * BufferSource.playbackRate is intentionally never used for speed ≠ 1 — it
 * changes pitch and is what made sped-up Gemini sound robotic.
 */
export class AudioClock {
  private ctx: AudioContext | null = null
  private scheduled: ScheduledClockUnit[] = []
  private sources: AudioBufferSourceNode[] = []
  private handlers: AudioClockHandlers = {}
  private rate = 1
  private sessionToken = 0
  private active = false
  private paused = false
  private activeUnitId: number | null = null
  private nextUnitId = 1
  private rafId: number | null = null
  private expectMore = false

  /** HTML pitch-preserving lane */
  private htmlAudio: HTMLAudioElement | null = null
  private htmlQueue: ScheduledClockUnit[] = []
  private htmlQueueIndex = -1
  private htmlPlayGeneration = 0

  get isActive() {
    if (this.useHtmlLane()) {
      return this.active && (this.htmlQueueIndex >= 0 || this.htmlQueue.length > 0)
    }
    return this.active && this.sources.length > 0
  }

  get isPaused() {
    return this.paused
  }

  get scheduledCount() {
    return this.useHtmlLane() ? this.htmlQueue.length : this.scheduled.length
  }

  get lastScheduledEnd() {
    if (this.useHtmlLane()) return null
    const last = this.scheduled[this.scheduled.length - 1]
    return last?.endAt ?? null
  }

  bufferedAheadSeconds() {
    if (this.useHtmlLane()) {
      if (this.htmlQueueIndex < 0) {
        return this.htmlQueue.reduce((sum, u) => sum + Math.max(0, u.buffer.duration - u.seekSeconds), 0) / Math.max(this.rate, 0.01)
      }
      let sum = 0
      for (let i = this.htmlQueueIndex; i < this.htmlQueue.length; i += 1) {
        const u = this.htmlQueue[i]!
        const remaining = i === this.htmlQueueIndex && this.htmlAudio
          ? Math.max(0, u.buffer.duration - (this.htmlAudio.currentTime || u.seekSeconds))
          : Math.max(0, u.buffer.duration - u.seekSeconds)
        sum += remaining
      }
      return sum / Math.max(this.rate, 0.01)
    }
    const ctx = this.ctx
    const last = this.scheduled[this.scheduled.length - 1]
    if (!ctx || !last) return 0
    return Math.max(0, last.endAt - ctx.currentTime)
  }

  ensureContext() {
    if (!this.ctx || this.ctx.state === 'closed') {
      this.ctx = new AudioContext()
      this.activeUnitId = null
    }
    return this.ctx
  }

  setHandlers(handlers: AudioClockHandlers) {
    this.handlers = handlers
  }

  setRate(rate: number) {
    const safe = rate > 0 && Number.isFinite(rate) ? rate : 1
    const wasHtml = this.useHtmlLane()
    this.rate = safe
    const nowHtml = this.useHtmlLane()

    if (wasHtml !== nowHtml && this.active) {
      // Switching pitch-preserve mode mid-session: rebuild on the HTML or Web path.
      this.rebuildForRateMode(wasHtml)
      return
    }

    if (nowHtml && this.htmlAudio) {
      applyPreservesPitch(this.htmlAudio, safe)
      return
    }

    // Rate ≈ 1: keep sources at 1.0 (never chipmunk).
    for (const source of this.sources) {
      source.playbackRate.value = 1
    }
  }

  private useHtmlLane() {
    return !isWebAudioRate(this.rate)
  }

  /**
   * Mark whether the producer still expects to append more units.
   * When false and the timeline is already dry, `onEnded` fires (covers the
   * race where the last stream frame ends before the loader settles).
   */
  setExpectMore(expectMore: boolean) {
    this.expectMore = expectMore
    if (!expectMore && this.active && !this.hasPlayableWork()) {
      this.active = false
      this.stopProgress()
      this.handlers.onEnded?.()
    }
  }

  private hasPlayableWork() {
    if (this.useHtmlLane()) {
      return this.htmlQueueIndex >= 0 && this.htmlQueueIndex < this.htmlQueue.length
    }
    return this.sources.length > 0
  }

  async resume() {
    this.paused = false
    if (this.useHtmlLane()) {
      if (this.htmlAudio) {
        try {
          await this.htmlAudio.play()
        } catch {
          // Autoplay race; user gesture should already have unlocked.
        }
      }
      return
    }
    const ctx = this.ctx
    if (ctx && ctx.state === 'suspended') await ctx.resume()
  }

  async pause() {
    this.paused = true
    if (this.useHtmlLane()) {
      this.htmlAudio?.pause()
      return
    }
    const ctx = this.ctx
    if (ctx && ctx.state === 'running') await ctx.suspend()
  }

  stop() {
    this.sessionToken += 1
    this.htmlPlayGeneration += 1
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
    this.stopHtmlLane(true)
    this.activeUnitId = null
    this.active = false
    this.paused = false
    this.expectMore = false
    this.handlers = {}
  }

  close() {
    this.stop()
    void this.ctx?.close().catch(() => undefined)
    this.ctx = null
  }

  /**
   * Append one buffer to the continuous timeline. Starts playback if this is
   * the first unit of an active session.
   */
  append(buffer: AudioBuffer, meta: ClockUnitMeta): ScheduledClockUnit | null {
    if (!buffer || buffer.duration <= 0) return null
    if (this.useHtmlLane()) return this.appendHtml(buffer, meta)
    return this.appendWebAudio(buffer, meta)
  }

  private appendWebAudio(buffer: AudioBuffer, meta: ClockUnitMeta): ScheduledClockUnit | null {
    const ctx = this.ensureContext()
    if (ctx.state === 'suspended' && !this.paused) void ctx.resume()

    const seekSeconds = Math.max(0, Math.min(buffer.duration, meta.seekSeconds ?? 0))
    const previousEnd = this.scheduled[this.scheduled.length - 1]?.endAt
    const startAt = audioBufferSourceStartTime(ctx.currentTime, previousEnd ?? ctx.currentTime)
    // Always schedule as rate 1 on Web Audio — pitch stays natural.
    const endAt = audioBufferScheduledEndTime({
      startAt,
      bufferDuration: buffer.duration,
      seekSeconds,
      playbackRate: 1,
    })

    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.playbackRate.value = 1
    source.connect(ctx.destination)

    const unit: ScheduledClockUnit = {
      unitId: this.nextUnitId++,
      chunkIndex: meta.chunkIndex,
      buffer,
      source,
      startAt,
      endAt,
      seekSeconds,
    }

    const token = this.sessionToken
    source.onended = () => this.handleWebEnded(unit, token)
    source.start(startAt, seekSeconds > 0 ? seekSeconds : undefined)

    this.scheduled.push(unit)
    this.sources.push(source)
    this.active = true

    if (this.rafId === null) this.startWebProgress()
    return unit
  }

  private appendHtml(buffer: AudioBuffer, meta: ClockUnitMeta): ScheduledClockUnit | null {
    const seekSeconds = Math.max(0, Math.min(buffer.duration, meta.seekSeconds ?? 0))
    let objectUrl: string
    try {
      objectUrl = URL.createObjectURL(audioBufferToWavBlob(buffer))
    } catch {
      return null
    }

    const unit: ScheduledClockUnit = {
      unitId: this.nextUnitId++,
      chunkIndex: meta.chunkIndex,
      buffer,
      source: null,
      startAt: 0,
      endAt: 0,
      seekSeconds,
      objectUrl,
    }
    this.htmlQueue.push(unit)
    this.active = true

    if (this.htmlQueueIndex < 0 && !this.paused) {
      void this.playHtmlAt(0)
    }
    if (this.rafId === null) this.startHtmlProgress()
    return unit
  }

  private async playHtmlAt(index: number) {
    if (index < 0 || index >= this.htmlQueue.length) {
      this.htmlQueueIndex = -1
      this.stopProgress()
      if (this.expectMore) {
        const last = this.htmlQueue[this.htmlQueue.length - 1]
        this.handlers.onUnderrun?.((last?.chunkIndex ?? 0) + 1)
      } else {
        this.active = false
        this.handlers.onEnded?.()
      }
      return
    }

    const gen = this.htmlPlayGeneration
    const unit = this.htmlQueue[index]!
    this.htmlQueueIndex = index

    const audio = this.ensureHtmlAudio()
    audio.onended = null
    audio.onerror = null

    try {
      audio.src = unit.objectUrl ?? ''
      audio.load()
      applyPreservesPitch(audio, this.rate)
      if (unit.seekSeconds > 0) {
        audio.currentTime = unit.seekSeconds
      }
      if (!this.paused) {
        await audio.play()
      }
    } catch {
      if (gen !== this.htmlPlayGeneration) return
      // Skip broken unit.
      void this.playHtmlAt(index + 1)
      return
    }

    if (gen !== this.htmlPlayGeneration) return

    this.activeUnitId = unit.unitId
    this.handlers.onUnitStart?.(unit)

    audio.onended = () => {
      if (gen !== this.htmlPlayGeneration) return
      void this.playHtmlAt(index + 1)
    }
    audio.onerror = () => {
      if (gen !== this.htmlPlayGeneration) return
      void this.playHtmlAt(index + 1)
    }
  }

  private ensureHtmlAudio() {
    if (!this.htmlAudio) {
      this.htmlAudio = new Audio()
      this.htmlAudio.preload = 'auto'
    }
    applyPreservesPitch(this.htmlAudio, this.rate)
    return this.htmlAudio
  }

  private stopHtmlLane(revokeUrls: boolean) {
    if (this.htmlAudio) {
      this.htmlAudio.onended = null
      this.htmlAudio.onerror = null
      try {
        this.htmlAudio.pause()
        this.htmlAudio.removeAttribute('src')
        this.htmlAudio.load()
      } catch {
        // ignore
      }
    }
    if (revokeUrls) {
      for (const unit of this.htmlQueue) {
        if (unit.objectUrl) URL.revokeObjectURL(unit.objectUrl)
      }
      this.htmlQueue = []
      this.htmlQueueIndex = -1
    }
  }

  /**
   * Mid-session rate mode switch: take remaining audio and replay with the
   * correct pitch policy.
   */
  private rebuildForRateMode(wasHtml: boolean) {
    const remaining: Array<{ buffer: AudioBuffer; chunkIndex: number; seekSeconds: number }> = []

    if (wasHtml) {
      const current = this.htmlQueueIndex >= 0 ? this.htmlQueue[this.htmlQueueIndex] : null
      const seek = current && this.htmlAudio
        ? this.htmlAudio.currentTime
        : (current?.seekSeconds ?? 0)
      if (current) {
        remaining.push({
          buffer: current.buffer,
          chunkIndex: current.chunkIndex,
          seekSeconds: Math.min(current.buffer.duration, Math.max(0, seek)),
        })
      }
      for (let i = this.htmlQueueIndex + 1; i < this.htmlQueue.length; i += 1) {
        const u = this.htmlQueue[i]!
        remaining.push({
          buffer: u.buffer,
          chunkIndex: u.chunkIndex,
          seekSeconds: u.seekSeconds,
        })
      }
    } else {
      const ctx = this.ctx
      const now = ctx?.currentTime ?? 0
      for (const unit of this.scheduled) {
        if (unit.endAt <= now) continue
        const seek = now >= unit.startAt
          ? unit.seekSeconds + (now - unit.startAt)
          : unit.seekSeconds
        remaining.push({
          buffer: unit.buffer,
          chunkIndex: unit.chunkIndex,
          seekSeconds: Math.min(unit.buffer.duration, Math.max(0, seek)),
        })
      }
    }

    // Soft stop without clearing handlers / expectMore.
    this.sessionToken += 1
    this.htmlPlayGeneration += 1
    this.stopProgress()
    for (const source of this.sources) {
      try {
        source.onended = null
        source.stop(0)
        source.disconnect()
      } catch {
        // ignore
      }
    }
    this.sources = []
    this.scheduled = []
    this.stopHtmlLane(true)
    this.activeUnitId = null

    const handlers = this.handlers
    const expectMore = this.expectMore
    // handlers preserved
    this.handlers = handlers
    this.expectMore = expectMore
    this.active = remaining.length > 0
    this.paused = this.paused

    for (const item of remaining) {
      this.append(item.buffer, {
        chunkIndex: item.chunkIndex,
        seekSeconds: item.seekSeconds,
      })
    }
  }

  private handleWebEnded(unit: ScheduledClockUnit, token: number) {
    if (token !== this.sessionToken) return
    this.sources = this.sources.filter((source) => source !== unit.source)

    const last = this.scheduled[this.scheduled.length - 1]
    if (!last || unit.unitId !== last.unitId) return

    this.stopProgress()
    if (this.expectMore) {
      this.handlers.onUnderrun?.(unit.chunkIndex + 1)
      return
    }
    this.active = false
    this.handlers.onEnded?.()
  }

  private startWebProgress() {
    this.stopProgress()
    const tick = () => {
      const ctx = this.ctx
      if (!ctx || ctx.state === 'closed' || !this.active) {
        this.rafId = null
        return
      }
      const now = ctx.currentTime
      const unit = this.scheduled.find((item) => now >= item.startAt && now < item.endAt)
      if (unit) {
        if (this.activeUnitId !== unit.unitId) {
          this.activeUnitId = unit.unitId
          this.handlers.onUnitStart?.(unit)
        }
        const elapsed = Math.max(0, now - unit.startAt)
        const currentTime = Math.min(
          unit.seekSeconds + elapsed,
          unit.buffer.duration,
        )
        this.handlers.onProgress?.(unit, currentTime)
      }
      this.rafId = requestAnimationFrame(tick)
    }
    this.rafId = requestAnimationFrame(tick)
  }

  private startHtmlProgress() {
    this.stopProgress()
    const tick = () => {
      if (!this.active || !this.useHtmlLane()) {
        this.rafId = null
        return
      }
      const unit = this.htmlQueueIndex >= 0 ? this.htmlQueue[this.htmlQueueIndex] : null
      if (unit && this.htmlAudio && !this.htmlAudio.paused) {
        if (this.activeUnitId !== unit.unitId) {
          this.activeUnitId = unit.unitId
          this.handlers.onUnitStart?.(unit)
        }
        this.handlers.onProgress?.(unit, this.htmlAudio.currentTime)
      }
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

function applyPreservesPitch(audio: HTMLAudioElement, rate: number) {
  const safe = rate > 0 && Number.isFinite(rate) ? rate : 1
  audio.preservesPitch = true
  const anyAudio = audio as HTMLAudioElement & {
    mozPreservesPitch?: boolean
    webkitPreservesPitch?: boolean
  }
  anyAudio.mozPreservesPitch = true
  anyAudio.webkitPreservesPitch = true
  audio.playbackRate = safe
}

/** Encode a mono/stereo AudioBuffer as a WAV blob for HTMLAudioElement. */
export function audioBufferToWavBlob(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels
  const sampleRate = buffer.sampleRate
  const length = buffer.length
  const bytesPerSample = 2
  const blockAlign = numChannels * bytesPerSample
  const dataSize = length * blockAlign
  const arrayBuffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(arrayBuffer)

  writeString(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeString(view, 8, 'WAVE')
  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, 16, true)
  writeString(view, 36, 'data')
  view.setUint32(40, dataSize, true)

  const channels: Float32Array[] = []
  for (let c = 0; c < numChannels; c += 1) {
    channels.push(buffer.getChannelData(c))
  }

  let offset = 44
  for (let i = 0; i < length; i += 1) {
    for (let c = 0; c < numChannels; c += 1) {
      const sample = Math.max(-1, Math.min(1, channels[c]![i] ?? 0))
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
      offset += 2
    }
  }

  return new Blob([arrayBuffer], { type: 'audio/wav' })
}

function writeString(view: DataView, offset: number, value: string) {
  for (let i = 0; i < value.length; i += 1) {
    view.setUint8(offset + i, value.charCodeAt(i))
  }
}

/** Build a mono AudioBuffer from Float32 PCM (Kokoro stream frames). */
export function pcmToAudioBuffer(
  ctx: AudioContext,
  pcm: Float32Array,
  sampleRate: number,
): AudioBuffer {
  const rate = sampleRate > 0 ? sampleRate : 24_000
  const buffer = ctx.createBuffer(1, Math.max(1, pcm.length), rate)
  if (pcm.length > 0) {
    const copy = new Float32Array(pcm.length)
    copy.set(pcm)
    buffer.copyToChannel(copy, 0)
  }
  return buffer
}
