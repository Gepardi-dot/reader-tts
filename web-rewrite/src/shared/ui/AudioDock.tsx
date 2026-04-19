import { useEffect, useMemo, useRef } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useAudioStore } from '@/shared/state/audioStore'
import styles from './AudioDock.module.css'

const RATES = [0.75, 1, 1.25, 1.5, 2] as const

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '0:00'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function AudioDock() {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const {
    track, shouldPlay, isPlaying, currentTime, duration,
    volume, muted, playbackRate, error,
    setTrack, setPlaying, syncProgress, setVolume, setMuted, setPlaybackRate, setError,
  } = useAudioStore()

  // ── Wire HTMLAudioElement events ──────────────────────────────────────────
  useEffect(() => {
    if (!audioRef.current) {
      audioRef.current = new Audio()
      audioRef.current.preload = 'auto'
    }
    const audio = audioRef.current
    const onTimeUpdate = () => syncProgress(audio.currentTime, audio.duration || 0)
    const onLoaded = () => syncProgress(audio.currentTime, audio.duration || 0)
    const onEnded = () => setPlaying(false)
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    const onError = () => setError('Playback failed. Check the audio URL or try again.')
    audio.addEventListener('timeupdate', onTimeUpdate)
    audio.addEventListener('loadedmetadata', onLoaded)
    audio.addEventListener('ended', onEnded)
    audio.addEventListener('play', onPlay)
    audio.addEventListener('pause', onPause)
    audio.addEventListener('error', onError)
    return () => {
      audio.pause()
      audio.removeEventListener('timeupdate', onTimeUpdate)
      audio.removeEventListener('loadedmetadata', onLoaded)
      audio.removeEventListener('ended', onEnded)
      audio.removeEventListener('play', onPlay)
      audio.removeEventListener('pause', onPause)
      audio.removeEventListener('error', onError)
    }
  }, [setError, setPlaying, syncProgress])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    audio.volume = volume
    audio.muted = muted
  }, [muted, volume])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    audio.playbackRate = playbackRate
  }, [playbackRate])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !track) return
    if (audio.src !== track.url) { audio.src = track.url; audio.load() }
    if (shouldPlay) {
      void audio.play().catch(() => setError('Tap Play to start (browser requires a user gesture).'))
    } else {
      audio.pause()
    }
  }, [setError, shouldPlay, track])

  const progress = useMemo(() => (duration ? Math.min((currentTime / duration) * 100, 100) : 0), [currentTime, duration])

  if (!track) return null

  return (
    <AnimatePresence>
      <motion.div
        animate={{ opacity: 1, y: 0 }}
        className={styles.dock}
        exit={{ opacity: 0, y: 32 }}
        initial={{ opacity: 0, y: 32 }}
        transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
      >
        {/* Progress fill */}
        <div className={styles.progressTrack} aria-hidden>
          <div className={styles.progressFill} style={{ width: `${progress}%` }} />
        </div>

        <div className={styles.inner}>
          {/* Track info */}
          <div className={styles.identity}>
            <p className="eyebrow">Now playing</p>
            <strong className={styles.trackTitle}>{track.title}</strong>
            {track.subtitle ? <span className={styles.trackSub}>{track.subtitle}</span> : null}
          </div>

          {/* Seek bar + time */}
          <div className={styles.seekRow}>
            <span className={styles.time}>{formatTime(currentTime)}</span>
            <input
              aria-label="Seek"
              className={styles.seeker}
              max={Math.max(duration, 1)}
              min={0}
              onChange={(e) => {
                const t = Number(e.target.value)
                if (audioRef.current) { audioRef.current.currentTime = t; syncProgress(t, duration) }
              }}
              type="range"
              value={Math.min(currentTime, duration || currentTime)}
            />
            <span className={styles.time}>{formatTime(duration)}</span>
          </div>

          {/* Controls row */}
          <div className={styles.controls}>
            {/* Play / Pause */}
            <button
              aria-label={isPlaying ? 'Pause' : 'Play'}
              className={`${styles.playBtn} ${isPlaying ? styles.playing : ''}`}
              onClick={() => setPlaying(!isPlaying)}
              type="button"
            >
              {isPlaying ? '⏸' : '▶'}
            </button>

            {/* Rate picker */}
            <div className={styles.rates}>
              {RATES.map((r) => (
                <button
                  className={`${styles.rateBtn} ${playbackRate === r ? styles.rateBtnActive : ''}`}
                  key={r}
                  onClick={() => setPlaybackRate(r)}
                  type="button"
                >
                  {r}×
                </button>
              ))}
            </div>

            {/* Volume + mute */}
            <div className={styles.volumeGroup}>
              <button
                aria-label={muted ? 'Unmute' : 'Mute'}
                className={styles.muteBtn}
                onClick={() => setMuted(!muted)}
                type="button"
              >
                {muted ? '🔇' : '🔊'}
              </button>
              <input
                aria-label="Volume"
                className={styles.volumeSlider}
                max={1} min={0} step={0.05} type="range" value={volume}
                onChange={(e) => setVolume(Number(e.target.value))}
              />
            </div>

            {/* Close */}
            <button
              aria-label="Close player"
              className={styles.closeBtn}
              onClick={() => setTrack(null, false)}
              type="button"
            >
              ✕
            </button>
          </div>

          {error ? <p className={styles.error}>{error}</p> : null}
        </div>
      </motion.div>
    </AnimatePresence>
  )
}
