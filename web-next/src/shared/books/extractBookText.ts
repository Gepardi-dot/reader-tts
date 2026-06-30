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

const TEXT_EXTENSIONS = new Set(['txt', 'md', 'markdown'])
const HTML_EXTENSIONS = new Set(['html', 'htm', 'xhtml'])

function extensionFor(file: File) {
  return file.name.split('.').pop()?.toLowerCase() ?? ''
}

function titleFromFileName(fileName: string) {
  return fileName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || 'Untitled book'
}

function emit(options: ExtractBookOptions, progress: BookExtractionProgress) {
  options.onProgress?.(progress)
}

function htmlToText(html: string) {
  if (typeof DOMParser === 'undefined') {
    return html.replace(/<[^>]+>/g, ' ')
  }
  const document = new DOMParser().parseFromString(html, 'text/html')
  document.querySelectorAll('script, style, noscript').forEach((node) => node.remove())
  return document.body.textContent ?? ''
}

function normalizeText(text: string) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

function estimatePages(text: string) {
  return Math.max(1, Math.ceil(text.length / 2400))
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

export async function extractBookText(file: File, options: ExtractBookOptions = {}): Promise<ExtractedBookPayload> {
  const sourceFormat = extensionFor(file)
  const title = options.title?.trim() || titleFromFileName(file.name)
  let text = ''
  let pageCount = 1

  if (sourceFormat === 'pdf' || file.type === 'application/pdf') {
    const pdf = await extractPdf(file, options)
    text = pdf.text
    pageCount = pdf.pageCount
  } else if (TEXT_EXTENSIONS.has(sourceFormat) || file.type.startsWith('text/plain')) {
    emit(options, { phase: 'reading', progress: 20, message: 'Reading text...' })
    text = normalizeText(await file.text())
    pageCount = estimatePages(text)
  } else if (HTML_EXTENSIONS.has(sourceFormat) || file.type.includes('html')) {
    emit(options, { phase: 'reading', progress: 20, message: 'Reading HTML...' })
    text = normalizeText(htmlToText(await file.text()))
    pageCount = estimatePages(text)
  } else {
    throw new Error('This Cloudflare build currently supports PDF, TXT, Markdown, and HTML uploads.')
  }

  if (!text) {
    throw new Error('No extractable text was found in this file.')
  }

  emit(options, { phase: 'uploading', progress: 100, message: 'Saving book...' })
  return { title, fileName: file.name, text, pageCount, sourceFormat }
}
