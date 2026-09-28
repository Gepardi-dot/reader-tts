import {
  extensionFor,
  isZipContainerName,
  looksLikePlainText,
  resolveBookFormat,
  sniffBookKind,
  type BookFormatKind,
  type BookFormatMeta,
} from '@/shared/books/bookFormats'
import { isAppleWebKit, newBrowserId, readFileBuffer } from '@/lib/browser'
import { extractMobiBook } from '@/shared/books/mobiText'
import {
  describePdfError,
  isPdfInfrastructureError,
} from '@/shared/books/pdfCompat'
import {
  extractIsbnsFromText,
  looksLikeAuthorName,
  looksLikeBookTitle,
} from '@/shared/books/bookIdentifiers'
import {
  estimatePages,
  htmlToText,
  jsonToText,
  normalizeText,
  rtfToText,
  xmlOrHtmlToText,
} from '@/shared/books/textConverters'

interface ExtractedKindResult {
  text: string
  pageCount: number
  cover?: Blob | null
  coverKind?: 'package' | 'pdf-page'
  title?: string
  author?: string
  isbn?: string
}

export interface BookExtractionProgress {
  phase: 'reading' | 'extracting' | 'converting' | 'uploading'
  progress: number
  message: string
}

export interface ExtractedBookPayload {
  title: string
  fileName: string
  text: string
  pageCount: number
  sourceFormat: string
  /** Embedded cover from the original file (EPUB/FB2 package art, or PDF page 1). */
  cover?: Blob | null
  /** Package art is the publisher jacket. PDF page 1 is only a fallback. */
  coverKind?: 'package' | 'pdf-page'
  isbn?: string
  author?: string
}

interface ExtractBookOptions {
  title?: string | null
  onProgress?: (progress: BookExtractionProgress) => void
}

type PdfWorkerResponse =
  | { type: 'ready' }
  | { id: string; type: 'progress'; progress: number; pageNumber: number; totalPages: number }
  | { id: string; type: 'complete'; text: string; pageCount: number; cover?: ArrayBuffer; coverType?: string; title?: string; author?: string; isbn?: string }
  | { id: string; type: 'error'; message: string }

const PDF_WORKER_READY_MS = 20_000

function newPdfJobId() {
  return newBrowserId()
}

function waitForPdfWorkerReady(worker: Worker) {
  return new Promise<void>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      cleanup()
      reject(new Error('PDF worker failed to start'))
    }, PDF_WORKER_READY_MS)

    const onMessage = (event: MessageEvent<PdfWorkerResponse>) => {
      if (event.data?.type !== 'ready') return
      cleanup()
      resolve()
    }
    const onError = (event: ErrorEvent) => {
      cleanup()
      reject(new Error(event.message || 'PDF worker failed to start'))
    }
    const cleanup = () => {
      globalThis.clearTimeout(timer)
      worker.removeEventListener('message', onMessage)
      worker.removeEventListener('error', onError)
    }

    worker.addEventListener('message', onMessage)
    worker.addEventListener('error', onError)
  })
}

function titleFromFileName(fileName: string) {
  return fileName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || 'Untitled book'
}

function emit(options: ExtractBookOptions, progress: BookExtractionProgress) {
  options.onProgress?.(progress)
}

async function extractPdfOnMainThread(
  buffer: ArrayBuffer,
  options: ExtractBookOptions,
) {
  const { extractPdfDocument } = await import('@/shared/books/extractPdfDocument')
  const result = await extractPdfDocument(buffer, ({ pageNumber, totalPages }) => {
    emit(options, {
      phase: 'extracting',
      progress: Math.max(2, Math.round((pageNumber / totalPages) * 100)),
      message: `Extracting page ${pageNumber} of ${totalPages}...`,
    })
  })
  return {
    text: result.text,
    pageCount: result.pageCount,
    cover: result.cover
      ? new Blob([result.cover], { type: result.coverType || 'image/jpeg' })
      : undefined,
    coverKind: result.cover ? 'pdf-page' : undefined,
    title: result.title,
    author: result.author,
    isbn: result.isbn,
  }
}

async function extractPdfWithWorker(
  buffer: ArrayBuffer,
  options: ExtractBookOptions,
) {
  if (typeof Worker === 'undefined') {
    throw new Error('PDF worker failed to start')
  }

  const id = newPdfJobId()
  const worker = new Worker(new URL('../../workers/pdfTextWorker.ts', import.meta.url), {
    type: 'module',
    name: 'pdf-text-extractor',
  })

  try {
    await waitForPdfWorkerReady(worker)
    return await new Promise<ExtractedKindResult>((resolve, reject) => {
      const onMessage = (event: MessageEvent<PdfWorkerResponse>) => {
        const message = event.data
        if (!message || !('id' in message) || message.id !== id) return
        if (message.type === 'progress') {
          emit(options, {
            phase: 'extracting',
            progress: Math.max(2, message.progress),
            message: `Extracting page ${message.pageNumber} of ${message.totalPages}...`,
          })
          return
        }
        if (message.type === 'complete') {
          resolve({
            text: message.text,
            pageCount: message.pageCount,
            cover: message.cover
              ? new Blob([message.cover], { type: message.coverType || 'image/jpeg' })
              : undefined,
            coverKind: message.cover ? 'pdf-page' : undefined,
            title: message.title,
            author: message.author,
            isbn: message.isbn,
          })
          return
        }
        reject(new Error(message.message))
      }
      const onError = (event: ErrorEvent) => {
        reject(new Error(event.message || 'PDF worker failed to start'))
      }
      worker.addEventListener('message', onMessage)
      worker.addEventListener('error', onError)
      worker.addEventListener('messageerror', () => {
        reject(new Error('PDF worker failed to start'))
      }, { once: true })
      // Copy, don't transfer — a detached buffer cannot be retried on the main thread.
      worker.postMessage({ id, buffer: buffer.slice(0) })
    })
  } finally {
    worker.terminate()
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer
  }
  return bytes.slice().buffer
}

function decodeLooseText(bytes: Uint8Array) {
  const utf8 = new TextDecoder('utf-8').decode(bytes)
  if (!utf8.includes('\uFFFD')) return utf8
  try {
    return new TextDecoder('windows-1252').decode(bytes)
  } catch {
    return utf8
  }
}

const IOS_READ_ERROR = 'Could not read this file. On iPhone or iPad, open it in the Files app so it finishes downloading, then upload it again.'

async function readUploadBytes(file: File) {
  try {
    const buffer = await readFileBuffer(file)
    const bytes = new Uint8Array(buffer)
    if (file.size > 0 && bytes.byteLength === 0) throw new Error(IOS_READ_ERROR)
    return bytes
  } catch (error) {
    if (error instanceof Error && error.message === IOS_READ_ERROR) throw error
    const message = error instanceof Error ? error.message : ''
    if (/notreadable|could not read|not found|permission|encodingerror/i.test(message)) {
      throw new Error(IOS_READ_ERROR)
    }
    throw error instanceof Error ? error : new Error('Could not read the file.')
  }
}

async function extractPdf(bytes: Uint8Array, options: ExtractBookOptions) {
  emit(options, { phase: 'reading', progress: 1, message: 'Reading PDF...' })
  const buffer = toArrayBuffer(bytes)
  emit(options, { phase: 'extracting', progress: 2, message: 'Extracting PDF text...' })

  // Safari / iOS: module workers are flaky and cannot nest pdf.js workers.
  if (isAppleWebKit()) {
    try {
      return await extractPdfOnMainThread(buffer, options)
    } catch (error) {
      throw new Error(describePdfError(error))
    }
  }

  try {
    return await extractPdfWithWorker(buffer, options)
  } catch (workerError) {
    if (!isPdfInfrastructureError(workerError)) {
      throw new Error(describePdfError(workerError))
    }
    try {
      return await extractPdfOnMainThread(buffer, options)
    } catch (mainError) {
      throw new Error(describePdfError(mainError))
    }
  }
}

async function extractDocx(bytes: Uint8Array, options: ExtractBookOptions) {
  emit(options, { phase: 'reading', progress: 10, message: 'Reading Word document...' })
  const mammoth = await import('mammoth')
  const buffer = toArrayBuffer(bytes)
  emit(options, { phase: 'extracting', progress: 40, message: 'Converting DOCX to text...' })
  const result = await mammoth.extractRawText({ arrayBuffer: buffer })
  return normalizeText(result.value || '')
}

async function loadZip(bytes: Uint8Array) {
  const JSZip = (await import('jszip')).default
  return JSZip.loadAsync(toArrayBuffer(bytes))
}

async function kindFromZip(bytes: Uint8Array): Promise<BookFormatKind | null> {
  let zip: Awaited<ReturnType<typeof loadZip>>
  try {
    zip = await loadZip(bytes)
  } catch {
    return null
  }
  const names = Object.keys(zip.files).map((name) => name.replace(/\\/g, '/'))
  const lower = names.map((name) => name.toLowerCase())
  const mimePath = names.find((name) => name.toLowerCase() === 'mimetype')
  let mime = ''
  if (mimePath) mime = (await zip.file(mimePath)!.async('string')).trim().toLowerCase()
  if (mime === 'application/epub+zip' || lower.some((name) => name.endsWith('.opf'))) return 'epub'
  if (lower.some((name) => name.endsWith('word/document.xml'))) return 'docx'
  if (mime.includes('opendocument.text') || lower.some((name) => name === 'content.xml' || name.endsWith('/content.xml'))) {
    return 'odt'
  }
  const fb2Path = names.find((name) => name.toLowerCase().endsWith('.fb2'))
  if (fb2Path) return 'fb2'
  return null
}

async function extractZipXmlText(
  bytes: Uint8Array,
  options: ExtractBookOptions,
  entryName: string,
  readingMessage: string,
) {
  emit(options, { phase: 'reading', progress: 10, message: readingMessage })
  const zip = await loadZip(bytes)
  const entry = zip.file(entryName)
  if (!entry) throw new Error(`Could not find ${entryName} inside the document.`)
  emit(options, { phase: 'extracting', progress: 50, message: 'Extracting text...' })
  const xml = await entry.async('string')
  return normalizeText(xmlOrHtmlToText(xml))
}

async function extractEpub(bytes: Uint8Array, options: ExtractBookOptions) {
  emit(options, { phase: 'reading', progress: 5, message: 'Reading EPUB...' })
  const zip = await loadZip(bytes)

  emit(options, { phase: 'extracting', progress: 20, message: 'Unpacking chapters...' })

  // Prefer spine order from package.opf when present
  const opfPath = Object.keys(zip.files).find((p) => p.toLowerCase().endsWith('.opf'))
  const orderedPaths: string[] = []
  let opfXml = ''

  if (opfPath) {
    const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : ''
    opfXml = await zip.file(opfPath)!.async('string')
    const hrefs = [...opfXml.matchAll(/idref=["']([^"']+)["']/gi)].map((m) => m[1])
    const idToHref = new Map<string, string>()
    for (const m of opfXml.matchAll(/<item\b[^>]*>/gi)) {
      const tag = m[0]
      const id = tag.match(/\bid=["']([^"']+)["']/i)?.[1]
      const href = tag.match(/\bhref=["']([^"']+)["']/i)?.[1]
      if (id && href) idToHref.set(id, href)
    }
    for (const id of hrefs) {
      const href = idToHref.get(id)
      if (!href) continue
      const path = decodeURIComponent(opfDir + href).replace(/\\/g, '/')
      orderedPaths.push(path)
    }
  }

  if (orderedPaths.length === 0) {
    orderedPaths.push(
      ...Object.keys(zip.files)
        .filter((p) => !zip.files[p].dir)
        .filter((p) => /\.(x?html?|xml)$/i.test(p))
        .filter((p) => !/meta-inf/i.test(p))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
    )
  }

  const chunks: string[] = []
  let done = 0
  for (const path of orderedPaths) {
    const entry = zip.file(path) || zip.file(path.replace(/^\.\//, ''))
    if (!entry) continue
    const markup = await entry.async('string')
    const text = normalizeText(htmlToText(markup))
    if (text) chunks.push(text)
    done += 1
    const progress = 20 + Math.round((done / Math.max(1, orderedPaths.length)) * 70)
    emit(options, {
      phase: 'extracting',
      progress,
      message: `Extracting chapter ${done} of ${orderedPaths.length}...`,
    })
  }

  const { extractCoverFromEpubZip, parseOpfMetadata } = await import('@/shared/books/extractCover')
  const cover = await extractCoverFromEpubZip(zip, opfPath)
  const meta = opfXml ? parseOpfMetadata(opfXml) : {}

  return {
    text: normalizeText(chunks.join('\n\n')),
    cover,
    coverKind: cover ? 'package' as const : undefined,
    title: meta.title,
    author: meta.author,
    isbn: meta.isbn,
  }
}

async function extractFb2(bytes: Uint8Array, options: ExtractBookOptions) {
  emit(options, { phase: 'reading', progress: 15, message: 'Reading FictionBook...' })
  const raw = decodeLooseText(bytes)
  emit(options, { phase: 'extracting', progress: 50, message: 'Extracting FB2 text...' })
  const { extractFb2Cover, parseFb2Metadata } = await import('@/shared/books/extractCover')
  const cover = extractFb2Cover(raw)
  const meta = parseFb2Metadata(raw)
  return {
    text: normalizeText(xmlOrHtmlToText(raw)),
    cover,
    coverKind: cover ? 'package' as const : undefined,
    title: meta.title,
    author: meta.author,
    isbn: meta.isbn,
  }
}

async function extractFb2FromZip(bytes: Uint8Array, options: ExtractBookOptions) {
  const zip = await loadZip(bytes)
  const name = Object.keys(zip.files).find((entry) => entry.toLowerCase().endsWith('.fb2'))
  if (!name) throw new Error('Could not find a FictionBook file inside the archive.')
  const raw = await zip.file(name)!.async('uint8array')
  return extractFb2(raw, options)
}

async function extractByKind(
  kind: BookFormatKind,
  bytes: Uint8Array,
  options: ExtractBookOptions,
): Promise<ExtractedKindResult> {
  switch (kind) {
    case 'pdf': {
      const pdf = await extractPdf(bytes, options)
      return {
        text: normalizeText(pdf.text),
        pageCount: pdf.pageCount,
        cover: pdf.cover,
        coverKind: pdf.cover ? 'pdf-page' : undefined,
        title: pdf.title,
        author: pdf.author,
        isbn: pdf.isbn,
      }
    }
    case 'plain': {
      emit(options, { phase: 'reading', progress: 25, message: 'Reading text...' })
      return {
        text: normalizeText(decodeLooseText(bytes)),
        pageCount: 0,
      }
    }
    case 'html': {
      emit(options, { phase: 'reading', progress: 25, message: 'Reading HTML...' })
      return {
        text: normalizeText(htmlToText(decodeLooseText(bytes))),
        pageCount: 0,
      }
    }
    case 'docx':
      return { text: await extractDocx(bytes, options), pageCount: 0 }
    case 'odt':
      return {
        text: await extractZipXmlText(bytes, options, 'content.xml', 'Reading OpenDocument...'),
        pageCount: 0,
      }
    case 'epub': {
      const epub = await extractEpub(bytes, options)
      return { text: epub.text, pageCount: 0, cover: epub.cover, coverKind: epub.coverKind, title: epub.title, author: epub.author, isbn: epub.isbn }
    }
    case 'fb2': {
      const fb2 = await extractFb2(bytes, options)
      return { text: fb2.text, pageCount: 0, cover: fb2.cover, coverKind: fb2.coverKind, title: fb2.title, author: fb2.author, isbn: fb2.isbn }
    }
    case 'rtf': {
      emit(options, { phase: 'reading', progress: 20, message: 'Reading RTF...' })
      return { text: rtfToText(decodeLooseText(bytes)), pageCount: 0 }
    }
    case 'json': {
      emit(options, { phase: 'reading', progress: 20, message: 'Reading JSON...' })
      return { text: jsonToText(decodeLooseText(bytes)), pageCount: 0 }
    }
    case 'mobi': {
      emit(options, { phase: 'reading', progress: 15, message: 'Reading Kindle book...' })
      const mobi = extractMobiBook(bytes)
      emit(options, { phase: 'extracting', progress: 80, message: 'Extracting Kindle text...' })
      return {
        text: mobi.text,
        pageCount: 0,
        cover: mobi.cover
          ? new Blob([mobi.cover.slice().buffer], { type: mobi.coverType || 'image/jpeg' })
          : undefined,
        coverKind: mobi.cover ? 'package' : undefined,
        title: mobi.title,
        author: mobi.author,
        isbn: mobi.isbn,
      }
    }
    default:
      throw new Error('Unsupported format.')
  }
}

function metaForKind(kind: BookFormatKind): BookFormatMeta {
  return {
    extensions: [kind === 'mobi' ? 'mobi' : kind === 'plain' ? 'txt' : kind],
    mimeTypes: [],
    kind,
    label: kind,
  }
}

async function resolveUploadFormat(file: File, bytes: Uint8Array): Promise<BookFormatMeta | null> {
  const ext = extensionFor(file)
  if (ext === 'kfx' || ext === 'azw8') {
    throw new Error('KFX files are locked to Kindle. Export this book as EPUB and upload that.')
  }
  if (ext === 'doc') {
    throw new Error('Old Word .doc files are not supported. Save the document as DOCX or EPUB and upload that.')
  }
  const named = resolveBookFormat(file)
  const sniffed = sniffBookKind(bytes)
  if (sniffed === 'doc') {
    throw new Error('Old Word .doc files are not supported. Save the document as DOCX or EPUB and upload that.')
  }
  if (!named || isZipContainerName(file.name) || sniffed === 'mobi' || sniffed === 'pdf') {
    if (sniffed === 'mobi' || sniffed === 'pdf' || sniffed === 'rtf' || sniffed === 'html' || sniffed === 'fb2' || sniffed === 'json') {
      if (!named || named.kind === 'plain' || isZipContainerName(file.name) || !ext) return metaForKind(sniffed)
    }
    if (sniffed === 'zip' || isZipContainerName(file.name)) {
      const zipped = await kindFromZip(bytes)
      if (zipped) return metaForKind(zipped)
    }
  }
  if (named) return named
  if (sniffed && sniffed !== 'zip') return metaForKind(sniffed)
  if (looksLikePlainText(bytes)) return metaForKind('plain')
  return null
}

export async function extractBookText(
  file: File,
  options: ExtractBookOptions = {},
): Promise<ExtractedBookPayload> {
  const bytes = await readUploadBytes(file)
  const format = await resolveUploadFormat(file, bytes)
  if (!format) {
    throw new Error(
      'Unsupported format. Try PDF, EPUB, Kindle (MOBI, AZW, AZW3), DOCX, ODT, RTF, FB2, HTML, Markdown, or TXT.',
    )
  }

  const zippedFb2 = format.kind === 'fb2' && (sniffBookKind(bytes) === 'zip' || isZipContainerName(file.name))
  const extracted = zippedFb2
    ? { ...(await extractFb2FromZip(bytes, options)), pageCount: 0 }
    : await extractByKind(format.kind, bytes, options)
  return finishExtract(file, format, extracted, options)
}

function finishExtract(
  file: File,
  format: BookFormatMeta,
  extracted: ExtractedKindResult,
  options: ExtractBookOptions,
): ExtractedBookPayload {
  const text = extracted.text
  const pageCount = extracted.pageCount > 0 ? extracted.pageCount : estimatePages(text)
  const isbn = extracted.isbn || extractIsbnsFromText(`${options.title ?? ''} ${file.name} ${text.slice(0, 4000)}`)[0]
  const author = extracted.author && looksLikeAuthorName(extracted.author) ? extracted.author : undefined
  const title = options.title?.trim()
    || (extracted.title && looksLikeBookTitle(extracted.title) ? extracted.title : '')
    || titleFromFileName(file.name)

  if (!text) {
    throw new Error(
      'No extractable text was found. Scanned/image-only PDFs need OCR first; '
      + 'password-protected or empty documents cannot be imported.',
    )
  }

  emit(options, { phase: 'uploading', progress: 100, message: 'Saving book...' })
  const ext = extensionFor(file)
  const sourceFormat = file.name.includes('.') && ext ? ext : format.extensions[0]
  return {
    title,
    fileName: file.name,
    text,
    pageCount,
    sourceFormat,
    cover: extracted.cover,
    coverKind: extracted.coverKind,
    isbn,
    author,
  }
}
