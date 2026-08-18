import { describe, expect, it, vi } from 'vitest'
import {
  createAudioContext,
  isAppleWebKit,
  isIosWebKit,
  isMacSafari,
  newBrowserId,
  readFileBuffer,
} from './browser'

describe('isAppleWebKit', () => {
  it('matches iPhone, iPadOS-as-Mac, and desktop Safari', () => {
    expect(isIosWebKit('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)', 5, 'iPhone')).toBe(true)
    expect(isAppleWebKit('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)', 5, 'iPhone')).toBe(true)
    expect(isAppleWebKit('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5, 'MacIntel')).toBe(true)
    expect(isMacSafari('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Safari/17.0', 0, 'MacIntel')).toBe(true)
    expect(isAppleWebKit('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Safari/17.0', 0, 'MacIntel')).toBe(true)
  })

  it('does not match Chrome or Windows', () => {
    expect(isMacSafari('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Chrome/120', 0, 'MacIntel')).toBe(false)
    expect(isAppleWebKit('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Chrome/120', 0, 'MacIntel')).toBe(false)
    expect(isAppleWebKit('Mozilla/5.0 (Windows NT 10.0)', 0, 'Win32')).toBe(false)
  })
})

describe('newBrowserId', () => {
  it('returns a string id', () => {
    expect(newBrowserId()).toMatch(/./)
  })
})

describe('readFileBuffer', () => {
  it('reads a blob via arrayBuffer', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    const buffer = await readFileBuffer(new Blob([bytes]))
    expect(new Uint8Array(buffer)).toEqual(bytes)
  })

  it('falls back to FileReader when arrayBuffer throws', async () => {
    const bytes = new Uint8Array([9, 8, 7])
    const blob = new Blob([bytes])
    vi.spyOn(blob, 'arrayBuffer').mockRejectedValueOnce(new Error('iCloud'))
    class FakeFileReader {
      result: ArrayBuffer | null = null
      onload: null | (() => void) = null
      onerror: null | (() => void) = null
      readAsArrayBuffer(file: Blob) {
        void file.arrayBuffer().then((buffer) => {
          this.result = buffer
          this.onload?.()
        })
      }
    }
    vi.stubGlobal('FileReader', FakeFileReader)
    try {
      const buffer = await readFileBuffer(blob)
      expect(new Uint8Array(buffer)).toEqual(bytes)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('createAudioContext', () => {
  it('uses webkitAudioContext when AudioContext is missing', () => {
    const original = globalThis.AudioContext
    const webkit = vi.fn(function WebkitAudio() {
      return { state: 'running' }
    })
    // @ts-expect-error test stub
    delete globalThis.AudioContext
    Object.assign(globalThis, { webkitAudioContext: webkit })
    try {
      const ctx = createAudioContext()
      expect(webkit).toHaveBeenCalled()
      expect(ctx).toMatchObject({ state: 'running' })
    } finally {
      if (original) globalThis.AudioContext = original
      // @ts-expect-error cleanup
      delete globalThis.webkitAudioContext
    }
  })
})
