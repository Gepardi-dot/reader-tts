import { describe, expect, it } from 'vitest'
import { extractBookText } from './extractBookText'
import { extractMobiBook, palmdocDecompress } from './mobiText'

function putU16(buf: Uint8Array, offset: number, value: number) {
  buf[offset] = (value >> 8) & 0xff
  buf[offset + 1] = value & 0xff
}

function putU32(buf: Uint8Array, offset: number, value: number) {
  buf[offset] = (value >>> 24) & 0xff
  buf[offset + 1] = (value >>> 16) & 0xff
  buf[offset + 2] = (value >>> 8) & 0xff
  buf[offset + 3] = value & 0xff
}

function buildPdb(records: Uint8Array[]) {
  const headerSize = 78 + records.length * 8
  let cursor = headerSize
  const offsets = records.map((record) => {
    const offset = cursor
    cursor += record.length
    return offset
  })
  const out = new Uint8Array(cursor)
  out.set(new TextEncoder().encode('BOOKMOBI'), 60)
  putU16(out, 76, records.length)
  records.forEach((record, index) => {
    putU32(out, 78 + index * 8, offsets[index]!)
    out.set(record, offsets[index]!)
  })
  return out
}

function mobiRecord(options: {
  compression: number
  encryption?: number
  text: Uint8Array
  recordCount: number
  extraFlags?: number
  kf8Header?: number
  title?: string
}) {
  const titleBytes = new TextEncoder().encode(options.title ?? '')
  const exth = options.kf8Header == null
    ? new Uint8Array()
    : new Uint8Array(24)
  if (options.kf8Header != null) {
    exth.set(new TextEncoder().encode('EXTH'), 0)
    putU32(exth, 4, 24)
    putU32(exth, 8, 1)
    putU32(exth, 12, 121)
    putU32(exth, 16, 12)
    putU32(exth, 20, options.kf8Header)
  }
  const headerLength = 232
  const record = new Uint8Array(16 + headerLength + exth.length + titleBytes.length)
  putU16(record, 0, options.compression)
  putU32(record, 4, options.text.length)
  putU16(record, 8, options.recordCount)
  putU16(record, 10, 4096)
  putU16(record, 12, options.encryption ?? 0)
  record.set(new TextEncoder().encode('MOBI'), 16)
  putU32(record, 20, headerLength)
  putU32(record, 24, 2)
  putU32(record, 28, 65001)
  putU32(record, 36, 6)
  if (options.extraFlags) putU16(record, 242, options.extraFlags)
  if (exth.length) putU32(record, 128, 0x40)
  const titleOffset = 16 + headerLength + exth.length
  if (titleBytes.length) {
    putU32(record, 84, titleOffset)
    putU32(record, 88, titleBytes.length)
    record.set(titleBytes, titleOffset)
  }
  record.set(exth, 16 + headerLength)
  return record
}

describe('palmdocDecompress', () => {
  it('expands a length-distance pair', () => {
    expect([...palmdocDecompress(new Uint8Array([0x61, 0x80, 0x08]))]).toEqual([0x61, 0x61, 0x61, 0x61])
  })
})

describe('extractMobiBook', () => {
  it('reads uncompressed Kindle HTML', () => {
    const text = new TextEncoder().encode('<p>Hello from Kindle.</p>')
    const bytes = buildPdb([
      mobiRecord({ compression: 1, text, recordCount: 1, title: 'Demo Book' }),
      text,
    ])
    const book = extractMobiBook(bytes)
    expect(book.text).toMatch(/Hello from Kindle/)
    expect(book.title).toBe('Demo Book')
  })

  it('reads PalmDOC-compressed text and drops trailing bytes', () => {
    const compressed = new Uint8Array([0x61, 0x80, 0x08, 0x00])
    const bytes = buildPdb([
      mobiRecord({
        compression: 2,
        text: new Uint8Array([0x61, 0x61, 0x61, 0x61]),
        recordCount: 1,
        extraFlags: 1,
      }),
      compressed,
    ])
    expect(extractMobiBook(bytes).text).toBe('aaaa')
  })

  it('follows the KF8 section when the Kindle fallback is only a placeholder', () => {
    const placeholder = new TextEncoder().encode('This book requires the Kindle Format 8 reader.')
    const real = new TextEncoder().encode('<p>The real chapter begins here.</p>')
    const bytes = buildPdb([
      mobiRecord({ compression: 1, text: placeholder, recordCount: 1, kf8Header: 3, title: 'Joint' }),
      placeholder,
      new TextEncoder().encode('BOUNDARY'),
      mobiRecord({ compression: 1, text: real, recordCount: 1, title: 'Joint' }),
      real,
    ])
    expect(extractMobiBook(bytes).text).toMatch(/real chapter begins here/)
  })

  it('refuses DRM and Huff/CDIC instead of guessing', () => {
    const text = new TextEncoder().encode('hidden')
    const drm = buildPdb([
      mobiRecord({ compression: 1, encryption: 2, text, recordCount: 1 }),
      text,
    ])
    expect(() => extractMobiBook(drm)).toThrow(/DRM/)
    const huff = buildPdb([
      mobiRecord({ compression: 17480, text, recordCount: 1 }),
      text,
    ])
    expect(() => extractMobiBook(huff)).toThrow(/high compression/)
  })
})

describe('extractBookText kindle and extensionless files', () => {
  it('imports a .azw3 and an extensionless text file iOS may hand back', async () => {
    const text = new TextEncoder().encode('<p>Chapter one of the voyage.</p>')
    const bytes = buildPdb([
      mobiRecord({ compression: 1, text, recordCount: 1, title: 'Voyage' }),
      text,
    ])
    const kindle = await extractBookText(new File([bytes], 'voyage.azw3', { type: '' }))
    expect(kindle.text).toMatch(/Chapter one of the voyage/)
    expect(kindle.sourceFormat).toBe('azw3')
    expect(kindle.title).toBe('Voyage')

    const plain = await extractBookText(new File(['Once upon a time in the city.'], 'Notes', { type: '' }))
    expect(plain.text).toMatch(/Once upon a time/)
    expect(plain.sourceFormat).toBe('txt')
  })
})
