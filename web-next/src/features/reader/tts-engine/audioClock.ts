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
  source: AudioBufferSourceNode
  startAt: number
  endAt: number
  seekSeconds: number
}

export interface AudioClockHandlers {
  onUnitStart?: (unit: ScheduledClockUnit) => void
  onProgress?: (unit: ScheduledClockUnit, currentTime: number) => void
  /** Fired when the timeline runs dry while a session is still active. */
  onUnderrun?: (nextChunkIndex: number) => void
  /** Fired when the session has no more units and the last one finished. */
  onEnded?: () => void
}

/**
 * Append-only Web Audio scheduler.
 *
 * Units are scheduled end-to-end on the AudioContext clock. New units can be
 * appended while audio is playing without restarting the graph. When the
 * timeline drains, the clock stays in session so a later append resumes from
 * `currentTime` instead of requiring a full stop/start cycle.
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

  get isActive() {
    return this.active && this.sources.length > 0
  }

  get isPaused() {
    return this.paused
  }

  get scheduledCount() {
    return this.scheduled.length
  }

  get lastScheduledEnd() {
    const last = this.scheduled[this.scheduled.length - 1]
    return last?.endAt ?? null
  }

  bufferedAheadSeconds() {
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
    this.rate = safe
    for (const source of this.sources) {
      source.playbackRate.value = safe
    }
  }

  /**
   * Mark whether the producer still expects to append more units.
   * When false and the timeline is already dry, `onEnded` fires (covers the
   * race where the last stream frame ends before the loader settles).
   */
  setExpectMore(expectMore: boolean) {
    this.expectMore = expectMore
    if (!expectMore && this.active && this.sources.length === 0) {
      this.active = false
      this.stopProgress()
      this.handlers.onEnded?.()
    }
  }

  async resume() {
    const ctx = this.ctx
    if (ctx && ctx.state === 'suspended') await ctx.resume()
    this.paused = false
  }

  async pause() {
    const ctx = this.ctx
    if (ctx && ctx.state === 'running') await ctx.suspend()
    this.paused = true
  }

  stop() {
    this.sessionToken += 1
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
    const ctx = this.ensureContext()
    if (ctx.state === 'suspended' && !this.paused) void ctx.resume()

    const seekSeconds = Math.max(0, Math.min(buffer.duration, meta.seekSeconds ?? 0))
    const previousEnd = this.scheduled[this.scheduled.length - 1]?.endAt
    const startAt = audioBufferSourceStartTime(ctx.currentTime, previousEnd ?? ctx.currentTime)
    const endAt = audioBufferScheduledEndTime({
      startAt,
      bufferDuration: buffer.duration,
      seekSeconds,
      playbackRate: this.rate,
    })

    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.playbackRate.value = this.rate
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
    source.onended = () => this.handleEnded(unit, token)
    source.start(startAt, seekSeconds > 0 ? seekSeconds : undefined)

    this.scheduled.push(unit)
    this.sources.push(source)
    this.active = true

    if (this.rafId === null) this.startProgress()
    return unit
  }

  private handleEnded(unit: ScheduledClockUnit, token: number) {
    if (token !== this.sessionToken) return
    this.sources = this.sources.filter((source) => source !== unit.source)

    const last = this.scheduled[this.scheduled.length - 1]
    if (!last || unit.unitId !== last.unitId) return

    // Timeline drained.
    this.stopProgress()
    if (this.expectMore) {
      this.handlers.onUnderrun?.(unit.chunkIndex + 1)
      return
    }
    this.active = false
    this.handlers.onEnded?.()
  }

  private startProgress() {
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
          unit.seekSeconds + elapsed * this.rate,
          unit.buffer.duration,
        )
        this.handlers.onProgress?.(unit, currentTime)
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

/** Build a mono AudioBuffer from Float32 PCM (Kokoro stream frames). */
export function pcmToAudioBuffer(
  ctx: AudioContext,
  pcm: Float32Array,
  sampleRate: number,
): AudioBuffer {
  const rate = sampleRate > 0 ? sampleRate : 24_000
  const buffer = ctx.createBuffer(1, Math.max(1, pcm.length), rate)
  if (pcm.length > 0) {
    // Copy into a fresh ArrayBuffer-backed view — worker transfer lists may
    // hand us SharedArrayBuffer-backed Float32Arrays that copyToChannel rejects.
    const copy = new Float32Array(pcm.length)
    copy.set(pcm)
    buffer.copyToChannel(copy, 0)
  }
  return buffer
}
