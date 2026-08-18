import { afterEach, describe, expect, it } from 'vitest'
import {
  collectPdfTextItems,
  describePdfError,
  installPdfCompat,
  isPdfInfrastructureError,
} from './pdfCompat'

describe('installPdfCompat', () => {
  afterEach(() => {
    installPdfCompat()
  })

  it('provides Math.sumPrecise for WebKit that lacks it', () => {
    installPdfCompat()
    const math = Math as typeof Math & { sumPrecise?: (values: Iterable<number>) => number }
    expect(typeof math.sumPrecise).toBe('function')
    expect(math.sumPrecise?.([1, 2, 3.5])).toBe(6.5)
  })

  it('provides Map.getOrInsertComputed', () => {
    installPdfCompat()
    const map = new Map<string, number>()
    const proto = Map.prototype as Map<string, number> & {
      getOrInsertComputed: (key: string, callback: (key: string) => number) => number
    }
    expect(proto.getOrInsertComputed.call(map, 'a', () => 7)).toBe(7)
    expect(proto.getOrInsertComputed.call(map, 'a', () => 9)).toBe(7)
    expect(map.get('a')).toBe(7)
  })

  it('provides Promise.try and URL.parse', async () => {
    installPdfCompat()
    const promiseCtor = Promise as typeof Promise & {
      try: <T>(fn: (...args: unknown[]) => T, ...args: unknown[]) => Promise<Awaited<T>>
    }
    await expect(promiseCtor.try(() => 4)).resolves.toBe(4)
    await expect(promiseCtor.try(() => { throw new Error('nope') })).rejects.toThrow('nope')

    const urlCtor = URL as typeof URL & { parse: (url: string, base?: string) => URL | null }
    expect(urlCtor.parse('https://higgsread.com/x')?.pathname).toBe('/x')
    expect(urlCtor.parse('::::')).toBeNull()
  })
})

describe('collectPdfTextItems', () => {
  it('joins strings and honors hasEOL', () => {
    expect(collectPdfTextItems([
      { str: 'Hello' },
      { str: 'world', hasEOL: true },
      { str: 'Next' },
    ])).toBe('Hello world \n Next')
  })

  it('does not throw on missing items (Safari for-of crash)', () => {
    expect(collectPdfTextItems(undefined)).toBe('')
    expect(collectPdfTextItems(null)).toBe('')
    expect(collectPdfTextItems({ str: 'x' })).toBe('')
  })
})

describe('describePdfError', () => {
  it('maps the Safari TypeError users see on upload', () => {
    expect(describePdfError(new TypeError("undefined is not a function (near '...e of t...')")))
      .toMatch(/could not convert the PDF/i)
  })

  it('keeps password and empty-text messages', () => {
    expect(describePdfError(new Error('Password required'))).toMatch(/password-protected/i)
    expect(describePdfError(new Error('No extractable text was found. Scanned PDFs need OCR before upload.')))
      .toMatch(/OCR/)
  })
})

describe('isPdfInfrastructureError', () => {
  it('retries worker crashes but not empty/password PDFs', () => {
    expect(isPdfInfrastructureError(new TypeError('undefined is not a function'))).toBe(true)
    expect(isPdfInfrastructureError(new Error('No extractable text was found'))).toBe(false)
    expect(isPdfInfrastructureError(new Error('PasswordException: No password given'))).toBe(false)
  })
})
