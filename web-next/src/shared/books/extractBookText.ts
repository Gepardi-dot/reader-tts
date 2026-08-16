import {
  extensionFor,
  resolveBookFormat,
  type BookFormatKind,
} from '@/shared/books/bookFormats'
import {
  estimatePages,
  htmlToText,
  jsonToText,
  normalizeText,
  rtfToText,
  xmlOrHtmlToText,
} from '@/shared/books/textConverters'

export interface BookExtractionProgress {
  phase: 'reading' | 'extracting' | 'uploading'
  progress: number
  message: string
}

export interface ExtractedBookPayload {
  title: string
  fileName: string
  text: string
  pageCount: number
  sourceFormat: string
}

interface ExtractBookOptions {
  title?: string | null
  onProgress?: (progress: BookExtractionProgress) => void
}

type PdfWorkerResponse =
  | { id: string; type: 'progress'; progress: number; pageNumber: number; totalPages: number }
  | { id: string; type: 'complete'; text: string; pageCount: number }
  | { id: string; type: 'error'; message: string }

function titleFromFileName(fileName: string) {
  return fileName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || 'Untitled book'
}

function emit(options: ExtractBookOptions, progress: BookExtractionProgress) {
  options.onProgress?.(progress)
}

async function extractPdf(file: File, options: ExtractBookOptions) {
  const id = crypto.randomUUID()
  const worker = new Worker(new URL('../../workers/pdfTextWorker.ts', import.meta.url), {
    type: 'module',
    name: 'pdf-text-extractor',
  })

  try {
    emit(options, { phase: 'reading', progress: 1, message: 'Reading PDF...' })
    const buffer = await file.arrayBuffer()
    emit(options, { phase: 'extracting', progress: 2, message: 'Extracting PDF text...' })

    return await new Promise<{ text: string; pageCount: number }>((resolve, reject) => {
      worker.addEventListener('message', (event: MessageEvent<PdfWorkerResponse>) => {
        const message = event.data
        if (!message || message.id !== id) return
        if (message.type === 'progress') {
          emit(options, {
            phase: 'extracting',
            progress: Math.max(2, message.progress),
            message: `Extracting page ${message.pageNumber} of ${message.totalPages}...`,
          })
          return
        }
        if (message.type === 'complete') {
          resolve({ text: message.text, pageCount: message.pageCount })
          return
        }
        reject(new Error(message.message))
      })

      worker.addEventListener('error', (event) => {
        reject(new Error(event.message || 'PDF extraction worker failed.'))
      }, { once: true })

      worker.postMessage({ id, buffer }, [buffer])
    })
  } finally {
    worker.terminate()
  }
}

async function extractDocx(file: File, options: ExtractBookOptions) {
  emit(options, { phase: 'reading', progress: 10, message: 'Reading Word document...' })
  const mammoth = await import('mammoth')
  const buffer = await file.arrayBuffer()
  emit(options, { phase: 'extracting', progress: 40, message: 'Converting DOCX to text...' })
  const result = await mammoth.extractRawText({ arrayBuffer: buffer })
  return normalizeText(result.value || '')
}

async function extractZipXmlText(
  file: File,
  options: ExtractBookOptions,
  entryName: string,
  readingMessage: string,
) {
  emit(options, { phase: 'reading', progress: 10, message: readingMessage })
  const JSZip = (await import('jszip')).default
  const zip = await JSZip.loadAsync(await file.arrayBuffer())
  const entry = zip.file(entryName)
  if (!entry) throw new Error(`Could not find ${entryName} inside the document.`)
  emit(options, { phase: 'extracting', progress: 50, message: 'Extracting text...' })
  const xml = await entry.async('string')
  return normalizeText(xmlOrHtmlToText(xml))
}

async function extractEpub(file: File, options: ExtractBookOptions) {
  emit(options, { phase: 'reading', progress: 5, message: 'Reading EPUB...' })
  const JSZip = (await import('jszip')).default
  const zip = await JSZip.loadAsync(await file.arrayBuffer())

  emit(options, { phase: 'extracting', progress: 20, message: 'Unpacking chapters...' })

  // Prefer spine order from package.opf when present
  const opfPath = Object.keys(zip.files).find((p) => p.toLowerCase().endsWith('.opf'))
  const orderedPaths: string[] = []

  if (opfPath) {
    const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : ''
    const opfXml = await zip.file(opfPath)!.async('string')
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

  return normalizeText(chunks.join('\n\n'))
}

async function extractFb2(file: File, options: ExtractBookOptions) {
  emit(options, { phase: 'reading', progress: 15, message: 'Reading FictionBook...' })
  const raw = await file.text()
  emit(options, { phase: 'extracting', progress: 50, message: 'Extracting FB2 text...' })
  return normalizeText(xmlOrHtmlToText(raw))
}

async function extractByKind(
  kind: BookFormatKind,
  file: File,
  options: ExtractBookOptions,
): Promise<{ text: string; pageCount: number }> {
  switch (kind) {
    case 'pdf': {
      const pdf = await extractPdf(file, options)
      return { text: normalizeText(pdf.text), pageCount: pdf.pageCount }
    }
    case 'plain': {
      emit(options, { phase: 'reading', progress: 25, message: 'Reading text...' })
      return {
        text: normalizeText(await file.text()),
        pageCount: 0,
      }
    }
    case 'html': {
      emit(options, { phase: 'reading', progress: 25, message: 'Reading HTML...' })
      return {
        text: normalizeText(htmlToText(await file.text())),
        pageCount: 0,
      }
    }
    case 'docx':
      return { text: await extractDocx(file, options), pageCount: 0 }
    case 'odt':
      return {
        text: await extractZipXmlText(file, options, 'content.xml', 'Reading OpenDocument...'),
        pageCount: 0,
      }
    case 'epub':
      return { text: await extractEpub(file, options), pageCount: 0 }
    case 'fb2':
      return { text: await extractFb2(file, options), pageCount: 0 }
    case 'rtf': {
      emit(options, { phase: 'reading', progress: 20, message: 'Reading RTF...' })
      return { text: rtfToText(await file.text()), pageCount: 0 }
    }
    case 'json': {
      emit(options, { phase: 'reading', progress: 20, message: 'Reading JSON...' })
      return { text: jsonToText(await file.text()), pageCount: 0 }
    }
    default:
      throw new Error('Unsupported format.')
  }
}

export async function extractBookText(
  file: File,
  options: ExtractBookOptions = {},
): Promise<ExtractedBookPayload> {
  const format = resolveBookFormat(file)
  if (!format) {
    throw new Error(
      'Unsupported format. Try PDF, EPUB, DOCX, ODT, RTF, FB2, HTML, Markdown, TXT, CSV, or JSON.',
    )
  }

  const sourceFormat = extensionFor(file) || format.extensions[0]
  const title = options.title?.trim() || titleFromFileName(file.name)

  const extracted = await extractByKind(format.kind, file, options)
  const text = extracted.text
  const pageCount = extracted.pageCount > 0 ? extracted.pageCount : estimatePages(text)

  if (!text) {
    throw new Error(
      'No extractable text was found. Scanned/image-only PDFs need OCR first; '
      + 'password-protected or empty documents cannot be imported.',
    )
  }

  emit(options, { phase: 'uploading', progress: 100, message: 'Saving book...' })
  return { title, fileName: file.name, text, pageCount, sourceFormat }
}
