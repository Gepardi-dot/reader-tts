/**
 * Supported book upload formats.
 * Extraction always happens in the browser and uploads plain text to the API.
 */

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

/** Short UI helper under the drop zone. */
export function bookFormatsHelpText() {
  return 'PDF, EPUB, DOCX, ODT, RTF, FB2, HTML, Markdown, TXT, CSV, JSON…'
}

export function unsupportedBookMessage() {
  return (
    'Unsupported format. Try PDF, EPUB, Word (DOCX), OpenDocument (ODT), RTF, '
    + 'FictionBook (FB2), HTML, Markdown, TXT, CSV, or JSON. '
    + 'Old .doc and Kindle (.mobi/.azw) are not supported — convert to DOCX or EPUB first.'
  )
}

/** Map extension → Content-Type for any future binary upload path. */
export function contentTypeForExtension(ext: string) {
  const meta = EXT_TO_META.get(ext.toLowerCase())
  return meta?.mimeTypes[0] ?? 'application/octet-stream'
}
