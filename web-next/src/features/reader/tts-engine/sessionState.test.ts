import { describe, expect, it } from 'vitest'
import { TtsSessionState } from './sessionState'

describe('TtsSessionState', () => {
  it('starts a buffering session and invalidates the previous controller', () => {
    const state = new TtsSessionState()
    const first = state.begin({ word: 'first', selectionKey: 'kokoro:af_heart' })

    const second = state.begin({ word: 'second', selectionKey: 'google:Puck' })

    expect(first.signal.aborted).toBe(true)
    expect(second.id).toBe(first.id + 1)
    expect(state.phase).toBe('buffering')
    expect(state.lane).toBe('none')
    expect(state.currentWord).toBe('second')
    expect(state.isCurrent(first.id, first.signal)).toBe(false)
    expect(state.isCurrent(second.id, second.signal)).toBe(true)
  })

  it('guards stale sessions and stale voice selections', () => {
    const state = new TtsSessionState()
    const current = state.begin({ word: 'hello', selectionKey: 'kokoro:am_adam' })

    expect(state.isCurrentSelection(current.id, 'kokoro:am_adam', current.signal)).toBe(true)
    expect(state.isCurrentSelection(current.id, 'kokoro:af_bella', current.signal)).toBe(false)
    expect(state.isCurrentSelection(current.id + 1, 'kokoro:am_adam', current.signal)).toBe(false)
  })

  it('resets playback state and aborts work on stop', () => {
    const state = new TtsSessionState()
    const session = state.begin({ word: 'hello', selectionKey: 'google:Puck' })
    state.setPlaying('native')
    state.setCurrentIndex(3)

    state.stop()

    expect(session.signal.aborted).toBe(true)
    expect(state.phase).toBe('idle')
    expect(state.lane).toBe('none')
    expect(state.currentIndex).toBe(0)
    expect(state.currentWord).toBeNull()
    expect(state.isCurrent(session.id, session.signal)).toBe(false)
  })

  it('builds reader snapshots from the current session fields', () => {
    const state = new TtsSessionState()
    state.begin({ word: 'hello', selectionKey: 'kokoro:af_heart' })
    state.setPlaying('native')
    state.setCurrentIndex(2)

    expect(state.snapshot({
      provider: 'kokoro',
      totalChunks: 5,
      nativeReadyChunks: 1,
      bufferedSeconds: 2.5,
    })).toMatchObject({
      phase: 'playing',
      lane: 'native',
      currentIndex: 2,
      totalChunks: 5,
      word: 'hello',
      provider: 'kokoro',
      nativeReadyChunks: 1,
      bufferedSeconds: 2.5,
      error: null,
    })
  })
})
