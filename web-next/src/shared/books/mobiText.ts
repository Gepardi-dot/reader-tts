/**
 * Kindle / Mobipocket text (MOBI, AZW, AZW3, PRC).
 * PalmDOC and uncompressed records only. DRM and Huff/CDIC get a clear error.
 * AZW3 joint files prefer the readable section (KF7 fallback or KF8).
 */

import { htmlToText, normalizeText } from '@/shared/books/textConverters'

export interface MobiBook {
  text: string
  title?: string
  author?: string
  isbn?: string
  cover?: Uint8Array
  coverType?: string
}

const NULL_INDEX = 0xffffffff
const HUFF = 17480

function u16(bytes: Uint8Array, offset: number) {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0)
}

function u32(bytes: Uint8Array, offset: number) {
  return (
    ((bytes[offset] ?? 0) * 0x1000000)
    + ((bytes[offset + 1] ?? 0) << 16)
    + ((bytes[offset + 2] ?? 0) << 8)
    + (bytes[offset + 3] ?? 0)
  ) >>> 0
}

function ascii(bytes: Uint8Array, offset: number, length: number) {
  let out = ''
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(bytes[offset + i] ?? 0)
  return out
}

export function looksLikeMobi(bytes: Uint8Array) {
  if (bytes.length < 68) return false
  const ident = ascii(bytes, 60, 8)
  return ident === 'BOOKMOBI' || ident === 'TEXtREAd'
}

function pdbRecords(bytes: Uint8Array) {
  if (bytes.length < 78) throw new Error('This Kindle file is incomplete.')
  const count = u16(bytes, 76)
  if (count < 1 || 78 + count * 8 > bytes.length) {
    throw new Error('This Kindle file is incomplete.')
  }
  const offsets: number[] = []
  for (let i = 0; i < count; i += 1) offsets.push(u32(bytes, 78 + i * 8))
  return offsets.map((start, index) => {
    const end = index + 1 < offsets.length ? offsets[index + 1] : bytes.length
    if (start > end || end > bytes.length) return new Uint8Array()
    return bytes.subarray(start, end)
  })
}

/** PalmDOC LZ77. Each text record is decompressed on its own. */
export function palmdocDecompress(src: Uint8Array) {
  const out: number[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i++]
    if (c === 0 || (c >= 9 && c <= 0x7f)) {
      out.push(c)
    } else if (c >= 1 && c <= 8) {
      for (let n = 0; n < c && i < src.length; n += 1) out.push(src[i++])
    } else if (c >= 0x80 && c <= 0xbf) {
      if (i >= src.length) break
      const next = src[i++]
      const distance = ((c & 0x3f) << 5) | (next >> 3)
      const length = (next & 7) + 3
      if (distance < 1 || distance > out.length) continue
      for (let n = 0; n < length; n += 1) out.push(out[out.length - distance])
    } else {
      out.push(0x20)
      out.push(c ^ 0x80)
    }
  }
  return Uint8Array.from(out)
}

function trailingSize(data: Uint8Array, flags: number) {
  let num = 0
  let bits = flags >> 1
  const sizeofEntry = (end: number) => {
    let result = 0
    let bitpos = 0
    let pos = end
    while (pos > 0 && bitpos < 28) {
      const v = data[pos - 1] ?? 0
      result |= (v & 0x7f) << bitpos
      bitpos += 7
      pos -= 1
      if ((v & 0x80) !== 0) return result
    }
    return result
  }
  while (bits) {
    if (bits & 1) {
      const size = sizeofEntry(data.length - num)
      if (!size || num + size > data.length) return 0
      num += size
    }
    bits >>= 1
  }
  if (flags & 1) {
    const off = data.length - num - 1
    if (off < 0) return num
    num += ((data[off] ?? 0) & 0x3) + 1
  }
  return num > data.length ? 0 : num
}

function trimTrailers(data: Uint8Array, flags: number) {
  if (!flags) return data
  const size = trailingSize(data, flags)
  if (!size) return data
  return data.subarray(0, data.length - size)
}

function decodeBytes(bytes: Uint8Array, encoding: number) {
  const label = encoding === 65001 ? 'utf-8' : 'windows-1252'
  try {
    return new TextDecoder(label).decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

interface Exth {
  title?: string
  author?: string
  isbn?: string
  kf8Header?: number
  coverOffset?: number
}

function parseExth(raw: Uint8Array, encoding: number): Exth {
  const exth: Exth = {}
  if (ascii(raw, 0, 4) !== 'EXTH' || raw.length < 12) return exth
  const count = u32(raw, 8)
  let pos = 12
  for (let i = 0; i < count && pos + 8 <= raw.length; i += 1) {
    const type = u32(raw, pos)
    const size = u32(raw, pos + 4)
    if (size < 8 || pos + size > raw.length) break
    const data = raw.subarray(pos + 8, pos + size)
    if (type === 100 && !exth.author) exth.author = decodeBytes(data, encoding).replace(/\0/g, '').trim()
    if (type === 104 && !exth.isbn) exth.isbn = decodeBytes(data, encoding).replace(/\0/g, '').trim()
    if (type === 503) exth.title = decodeBytes(data, encoding).replace(/\0/g, '').trim()
    if (type === 121 && data.length >= 4) {
      const index = u32(data, 0)
      if (index !== NULL_INDEX) exth.kf8Header = index
    }
    if (type === 201 && data.length >= 4) {
      const cover = u32(data, 0)
      if (cover !== NULL_INDEX) exth.coverOffset = cover
    }
    pos += size
  }
  return exth
}

interface Section {
  text: string
  title?: string
  author?: string
  isbn?: string
  firstImage?: number
  coverOffset?: number
}

function readSection(records: Uint8Array[], headerIndex: number): Section {
  const header = records[headerIndex]
  if (!header || header.length < 16) throw new Error('This Kindle file has no readable text.')
  const compression = u16(header, 0)
  const textLength = u32(header, 4)
  const recordCount = u16(header, 8)
  const encryption = u16(header, 12)
  if (encryption === 1 || encryption === 2) {
    throw new Error('This Kindle file is locked with DRM. Export a DRM-free EPUB and upload that.')
  }
  if (compression === HUFF) {
    throw new Error('This Kindle file uses high compression. Export it as EPUB and upload that.')
  }
  if (compression !== 1 && compression !== 2) {
    throw new Error('This Kindle file uses an unsupported compression.')
  }

  let encoding = 1252
  let extraFlags = 0
  let title = ''
  let exth: Exth = {}
  let firstImage: number | undefined
  const mobi = header.length > 20 && ascii(header, 16, 4) === 'MOBI'
  if (mobi) {
    const headerLength = u32(header, 20)
    encoding = u32(header, 28) || 1252
    if (headerLength >= 228 && header.length >= 244) extraFlags = u16(header, 242)
    if (header.length >= 92) {
      const nameOffset = u32(header, 84)
      const nameLength = u32(header, 88)
      if (nameLength > 0 && nameLength < 500 && nameOffset + nameLength <= header.length) {
        title = decodeBytes(header.subarray(nameOffset, nameOffset + nameLength), encoding).replace(/\0/g, '').trim()
      }
    }
    if (header.length >= 112) {
      const image = u32(header, 108)
      if (image !== NULL_INDEX) firstImage = image
    }
    if (header.length >= 132 && (u32(header, 128) & 0x40) && headerLength >= 16) {
      exth = parseExth(header.subarray(16 + headerLength), encoding)
    }
  }

  const parts: Uint8Array[] = []
  let produced = 0
  for (let n = 0; n < recordCount; n += 1) {
    const rec = records[headerIndex + 1 + n]
    if (!rec) break
    const trimmed = trimTrailers(rec, extraFlags)
    const chunk = compression === 2 ? palmdocDecompress(trimmed) : trimmed
    parts.push(chunk)
    produced += chunk.length
    if (textLength > 0 && produced >= textLength) break
  }
  const merged = new Uint8Array(Math.min(produced, textLength > 0 ? textLength : produced))
  let offset = 0
  for (const part of parts) {
    const take = Math.min(part.length, merged.length - offset)
    if (take <= 0) break
    merged.set(part.subarray(0, take), offset)
    offset += take
  }
  const markup = decodeBytes(merged, encoding)
  const text = /<[a-z!/?]/i.test(markup) ? htmlToText(markup) : markup
  return {
    text: normalizeText(text),
    title: exth.title || title || undefined,
    author: exth.author,
    isbn: exth.isbn,
    firstImage,
    coverOffset: exth.coverOffset,
  }
}

function isPlaceholder(text: string) {
  return /kindle format 8|enhanced typesetting|this (?:book|ebook) (?:is|requires)|cannot be opened/i.test(text)
    && text.length < 600
}

function coverFrom(records: Uint8Array[], section: Section) {
  if (section.firstImage == null) return null
  const index = section.firstImage + (section.coverOffset ?? 0)
  const rec = records[index]
  if (!rec || rec.length < 8) return null
  if (rec[0] === 0xff && rec[1] === 0xd8) return { cover: rec, coverType: 'image/jpeg' }
  if (rec[0] === 0x89 && rec[1] === 0x50 && rec[2] === 0x4e && rec[3] === 0x47) {
    return { cover: rec, coverType: 'image/png' }
  }
  return null
}

export function extractMobiBook(bytes: Uint8Array): MobiBook {
  if (!looksLikeMobi(bytes)) throw new Error('This is not a Kindle (MOBI/AZW) file.')
  const records = pdbRecords(bytes)
  let primary: Section | null = null
  let primaryError: Error | null = null
  try {
    primary = readSection(records, 0)
  } catch (error) {
    primaryError = error instanceof Error ? error : new Error('Could not read this Kindle file.')
    if (/DRM/.test(primaryError.message)) throw primaryError
  }

  let kf8: Section | null = null
  const kf8Index = (() => {
    const header = records[0]
    if (!header || ascii(header, 16, 4) !== 'MOBI') return undefined
    const headerLength = u32(header, 20)
    if (header.length < 132 || (u32(header, 128) & 0x40) === 0) return undefined
    return parseExth(header.subarray(16 + headerLength), u32(header, 28) || 1252).kf8Header
  })()
  if (kf8Index != null && kf8Index > 0 && kf8Index < records.length) {
    try {
      kf8 = readSection(records, kf8Index)
    } catch {
      kf8 = null
    }
  }

  const usable = (section: Section | null) => {
    if (!section?.text) return false
    return !isPlaceholder(section.text)
  }
  let chosen = usable(primary) ? primary : null
  if (usable(kf8) && (!chosen || (kf8!.text.length > chosen.text.length))) chosen = kf8
  if (!chosen) {
    if (primaryError) throw primaryError
    if (primary?.text) chosen = primary
    else throw new Error('No extractable text was found in this Kindle file.')
  }

  const art = coverFrom(records, chosen!)
  return {
    text: chosen!.text,
    title: chosen!.title,
    author: chosen!.author,
    isbn: chosen!.isbn,
    cover: art?.cover,
    coverType: art?.coverType,
  }
}
