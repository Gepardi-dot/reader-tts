import { describe, expect, it, vi } from 'vitest'
import {
  armHtmlMediaElement,
  armNavigatorAudioSession,
  createAudioContext,
  decodeAudioDataSafe,
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

describe('armHtmlMediaElement', () => {
  it('marks playsinline for iOS WebKit', () => {
    const attrs: Record<string, string> = {}
    const media = {
      setAttribute: (name: string, value: string) => { attrs[name] = value },
      preload: '',
      controls: true,
      isConnected: true,
      style: {} as CSSStyleDeclaration,
    } as unknown as HTMLMediaElement
    armHtmlMediaElement(media)
    expect(attrs.playsinline).toBe('true')
    expect(attrs['webkit-playsinline']).toBe('true')
    expect(media.preload).toBe('auto')
    expect(media.controls).toBe(false)
  })
})

describe('armNavigatorAudioSession', () => {
  it('sets playback type when the API exists', () => {
    const session = { type: 'auto' }
    vi.stubGlobal('navigator', { audioSession: session })
    armNavigatorAudioSession()
    expect(session.type).toBe('playback')
    vi.unstubAllGlobals()
  })
})

describe('decodeAudioDataSafe', () => {
  it('copies the buffer and uses the promise decode path', async () => {
    const decoded = { duration: 1 } as AudioBuffer
    const seen: ArrayBuffer[] = []
    const ctx = {
      decodeAudioData: vi.fn((data: ArrayBuffer) => {
        seen.push(data)
        return Promise.resolve(decoded)
      }),
    } as unknown as AudioContext
    const raw = new Uint8Array([1, 2, 3]).buffer
    const buffer = await decodeAudioDataSafe(ctx, raw)
    expect(buffer).toBe(decoded)
    expect(seen[0]).not.toBe(raw)
    expect(new Uint8Array(seen[0]!)).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('supports callback-style webkit decodeAudioData', async () => {
    const decoded = { duration: 2 } as AudioBuffer
    const ctx = {
      decodeAudioData: (data: ArrayBuffer, success?: (buffer: AudioBuffer) => void) => {
        success?.(decoded)
        void data
      },
    } as unknown as AudioContext
    const buffer = await decodeAudioDataSafe(ctx, new Uint8Array([9]).buffer)
    expect(buffer).toBe(decoded)
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
