import { create } from 'zustand'

type AudioTrack = {
  id: string
  url: string
  title: string
  subtitle?: string
}

type AudioDockState = {
  track: AudioTrack | null
  shouldPlay: boolean
  isPlaying: boolean
  currentTime: number
  duration: number
  volume: number
  muted: boolean
  playbackRate: number
  error: string | null
  setTrack: (track: AudioTrack | null, autoplay?: boolean) => void
  setPlaying: (playing: boolean) => void
  syncProgress: (currentTime: number, duration: number) => void
  setVolume: (volume: number) => void
  setMuted: (muted: boolean) => void
  setPlaybackRate: (rate: number) => void
  setError: (error: string | null) => void
}

export const useAudioStore = create<AudioDockState>((set) => ({
  track: null,
  shouldPlay: false,
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  volume: 1,
  muted: false,
  playbackRate: 1,
  error: null,
  setTrack: (track, autoplay = true) =>
    set({
      track,
      shouldPlay: autoplay,
      isPlaying: false,
      currentTime: 0,
      duration: 0,
      error: null,
    }),
  setPlaying: (playing) => set({ shouldPlay: playing, isPlaying: playing }),
  syncProgress: (currentTime, duration) => set({ currentTime, duration }),
  setVolume: (volume) => set({ volume }),
  setMuted: (muted) => set({ muted }),
  setPlaybackRate: (playbackRate) => set({ playbackRate }),
  setError: (error) => set({ error, isPlaying: false, shouldPlay: false }),
}))
