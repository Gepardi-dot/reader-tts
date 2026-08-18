import { describe, expect, it } from 'vitest'
import {
  htmlToText,
  jsonToText,
  normalizeText,
  rtfToText,
} from './textConverters'
import { bookAcceptAttribute, bookFileInputAccept, isSupportedBookFile, resolveBookFormat } from './bookFormats'

describe('normalizeText', () => {
  it('collapses excess blank lines and spaces', () => {
    expect(normalizeText('a  \n\n\n  b\r\nc')).toBe('a\n\nb\nc')
  })
})

describe('htmlToText', () => {
  it('strips tags and scripts', () => {
    const text = htmlToText('<html><script>x</script><p>Hello</p><p>World</p></html>')
    expect(text).toMatch(/Hello/)
    expect(text).toMatch(/World/)
    expect(text).not.toMatch(/script|x\b/)
  })
})

describe('rtfToText', () => {
  it('extracts plain content from simple RTF', () => {
    const rtf = String.raw`{\rtf1\ansi\deff0 {\fonttbl{\f0 Arial;}}\f0\fs24 Hello\par World}`
    const text = rtfToText(rtf)
    expect(text).toMatch(/Hello/)
    expect(text).toMatch(/World/)
  })
})

describe('jsonToText', () => {
  it('pulls narrative string fields', () => {
    const text = jsonToText(JSON.stringify({
      title: 'Demo',
      chapters: [{ text: 'Once upon a time.' }, { text: 'The end.' }],
    }))
    expect(text).toMatch(/Once upon a time/)
    expect(text).toMatch(/The end/)
  })
})

describe('bookFormats', () => {
  it('accepts popular extensions', () => {
    for (const name of [
      'a.pdf', 'b.epub', 'c.docx', 'd.odt', 'e.rtf', 'f.fb2',
      'g.txt', 'h.md', 'i.html', 'j.csv', 'k.json',
    ]) {
      const file = new File(['x'], name, { type: '' })
      expect(isSupportedBookFile(file), name).toBe(true)
      expect(resolveBookFormat(file)?.kind).toBeTruthy()
    }
  })

  it('rejects unsupported binary formats', () => {
    expect(isSupportedBookFile(new File(['x'], 'book.mobi'))).toBe(false)
    expect(isSupportedBookFile(new File(['x'], 'scan.png'))).toBe(false)
    expect(isSupportedBookFile(new File(['x'], 'old.doc'))).toBe(false)
  })

  it('uses extension-only accept on iOS so Safari opens Files, not Photos', () => {
    const original = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
    })
    try {
      const accept = bookFileInputAccept()
      expect(accept).toMatch(/\.pdf/)
      expect(accept).not.toMatch(/application\/pdf/)
    } finally {
      Object.defineProperty(navigator, 'userAgent', { configurable: true, value: original })
    }
    expect(bookAcceptAttribute()).toMatch(/application\/pdf/)
  })
})
