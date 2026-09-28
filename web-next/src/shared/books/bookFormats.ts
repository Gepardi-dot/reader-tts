/**
 * Supported book upload formats.
 * Extraction always happens in the browser and uploads plain text to the API.
 */

import { isIosWebKit } from '@/lib/browser'

export type BookFormatKind =
  | 'pdf'
  | 'plain'
  | 'html'
  | 'docx'
  | 'odt'
  | 'epub'
  | 'fb2'
  | 'rtf'
  | 'json'
  | 'mobi'

export interface BookFormatMeta {
  extensions: string[]
  mimeTypes: string[]
  kind: BookFormatKind
  label: string
}

/** Catalog of formats we convert client-side into readable text. */
export const BOOK_FORMATS: BookFormatMeta[] = [
  {
    extensions: ['pdf'],
    mimeTypes: ['application/pdf'],
    kind: 'pdf',
    label: 'PDF',
  },
  {
    extensions: ['txt', 'text', 'log', 'md', 'markdown', 'mdown', 'rst', 'org', 'csv', 'tsv'],
    mimeTypes: [
      'text/plain',
      'text/markdown',
      'text/x-markdown',
      'text/csv',
      'text/tab-separated-values',
      'text/x-rst',
    ],
    kind: 'plain',
    label: 'Text / Markdown / CSV',
  },
  {
    extensions: ['html', 'htm', 'xhtml'],
    mimeTypes: ['text/html', 'application/xhtml+xml'],
    kind: 'html',
    label: 'HTML',
  },
  {
    extensions: ['docx'],
    mimeTypes: [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ],
    kind: 'docx',
    label: 'Word (DOCX)',
  },
  {
    extensions: ['odt'],
    mimeTypes: ['application/vnd.oasis.opendocument.text'],
    kind: 'odt',
    label: 'OpenDocument (ODT)',
  },
  {
    extensions: ['epub'],
    mimeTypes: ['application/epub+zip', 'application/epub'],
    kind: 'epub',
    label: 'EPUB',
  },
  {
    extensions: ['fb2'],
    mimeTypes: ['application/x-fictionbook+xml', 'text/xml', 'application/xml'],
    kind: 'fb2',
    label: 'FictionBook (FB2)',
  },
  {
    extensions: ['rtf'],
    mimeTypes: ['application/rtf', 'text/rtf'],
    kind: 'rtf',
    label: 'RTF',
  },
  {
    extensions: ['json'],
    mimeTypes: ['application/json'],
    kind: 'json',
    label: 'JSON',
  },
  {
    extensions: ['mobi', 'azw', 'azw3', 'prc'],
    mimeTypes: [
      'application/x-mobipocket-ebook',
      'application/vnd.amazon.ebook',
      'application/x-mobi',
    ],
    kind: 'mobi',
    label: 'Kindle (MOBI, AZW, AZW3)',
  },
]

const EXT_TO_META = new Map<string, BookFormatMeta>()
const MIME_TO_META = new Map<string, BookFormatMeta>()

for (const meta of BOOK_FORMATS) {
  for (const ext of meta.extensions) EXT_TO_META.set(ext, meta)
  for (const mime of meta.mimeTypes) MIME_TO_META.set(mime.toLowerCase(), meta)
}

export function extensionFor(file: File | string) {
  const name = typeof file === 'string' ? file : file.name
  return name.split('.').pop()?.toLowerCase() ?? ''
}

export function resolveBookFormat(file: File): BookFormatMeta | null {
  const ext = extensionFor(file)
  if (ext && EXT_TO_META.has(ext)) return EXT_TO_META.get(ext)!

  const mime = (file.type || '').toLowerCase().split(';')[0].trim()
  if (mime && MIME_TO_META.has(mime)) return MIME_TO_META.get(mime)!

  // Generic text/*
  if (mime.startsWith('text/')) {
    return EXT_TO_META.get('txt') ?? null
  }
  return null
}

export function isSupportedBookFile(file: File) {
  return resolveBookFormat(file) !== null
}

/** Value for <input accept="..."> */
export function bookAcceptAttribute() {
  const parts = new Set<string>()
  for (const meta of BOOK_FORMATS) {
    for (const ext of meta.extensions) parts.add(`.${ext}`)
    for (const mime of meta.mimeTypes) parts.add(mime)
  }
  return [...parts].join(',')
}

/**
 * iOS greys out or errors on uncommon extensions (EPUB, Kindle, FB2) when
 * `accept` is extensions only. `application/octet-stream` lets Files hand
 * those books over. image/* and application/pdf pull in the photo library.
 */
export function bookFileInputAccept() {
  const extensions: string[] = []
  for (const meta of BOOK_FORMATS) {
    for (const ext of meta.extensions) extensions.push(`.${ext}`)
  }
  if (typeof navigator !== 'undefined' && isIosWebKit()) {
    return ['application/octet-stream', ...extensions].join(',')
  }
  return bookAcceptAttribute()
}

/** Short UI helper under the drop zone. */
export function bookFormatsHelpText() {
  return 'PDF, EPUB, Kindle (MOBI, AZW, AZW3), DOCX, ODT, RTF, FB2, HTML, TXT…'
}

export function unsupportedBookMessage() {
  return (
    'Unsupported format. Try PDF, EPUB, Kindle (MOBI, AZW, AZW3), Word (DOCX), '
    + 'OpenDocument (ODT), RTF, FictionBook (FB2), HTML, Markdown, or TXT. '
    + 'DRM-locked Kindle files, old Word (.doc), and KFX need to be exported as EPUB first.'
  )
}

const ZIP_EXTENSIONS = new Set(['zip', 'fbz', 'fb2.zip'])

export function isZipContainerName(name: string) {
  const lower = name.toLowerCase()
  if (lower.endsWith('.fb2.zip')) return true
  const ext = extensionFor(lower)
  return ZIP_EXTENSIONS.has(ext)
}

/** Magic-byte kind when iOS drops the extension or labels the file octet-stream. */
export function sniffBookKind(bytes: Uint8Array): BookFormatKind | 'zip' | 'doc' | null {
  if (bytes.length >= 5 && asciiAt(bytes, 0, 5) === '%PDF-') return 'pdf'
  if (bytes.length >= 5 && asciiAt(bytes, 0, 5) === '{\\rtf') return 'rtf'
  if (bytes.length >= 68) {
    const ident = asciiAt(bytes, 60, 8)
    if (ident === 'BOOKMOBI' || ident === 'TEXtREAd') return 'mobi'
  }
  if (
    bytes.length >= 4
    && bytes[0] === 0x50
    && bytes[1] === 0x4b
    && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)
  ) {
    return 'zip'
  }
  if (bytes.length >= 8 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    return 'doc'
  }
  const head = asciiAt(bytes, 0, Math.min(bytes.length, 240)).trimStart().toLowerCase()
  if (head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<head')) return 'html'
  if (head.includes('<fictionbook')) return 'fb2'
  if (head.startsWith('{') || head.startsWith('[')) return 'json'
  return null
}

function asciiAt(bytes: Uint8Array, offset: number, length: number) {
  let out = ''
  const end = Math.min(bytes.length, offset + length)
  for (let i = offset; i < end; i += 1) out += String.fromCharCode(bytes[i] ?? 0)
  return out
}

export function looksLikePlainText(bytes: Uint8Array) {
  if (bytes.length < 8) return false
  const sample = bytes.subarray(0, Math.min(bytes.length, 4096))
  let weird = 0
  for (const b of sample) {
    if (b === 0) return false
    if (b < 9 || (b > 13 && b < 32)) weird += 1
  }
  return weird / sample.length < 0.02
}

/** Map extension → Content-Type for any future binary upload path. */
export function contentTypeForExtension(ext: string) {
  const meta = EXT_TO_META.get(ext.toLowerCase())
  return meta?.mimeTypes[0] ?? 'application/octet-stream'
}
