import * as pdfjs from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url'

interface ExtractPdfRequest {
  id: string
  buffer: ArrayBuffer
}

type ExtractPdfResponse =
  | { id: string; type: 'progress'; progress: number; pageNumber: number; totalPages: number }
  | { id: string; type: 'complete'; text: string; pageCount: number }
  | { id: string; type: 'error'; message: string }

interface PdfTextItem {
  str?: string
  hasEOL?: boolean
}

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope

function post(message: ExtractPdfResponse) {
  ctx.postMessage(message)
}

function cleanPageText(raw: string) {
  return raw
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

ctx.addEventListener('message', (event: MessageEvent<ExtractPdfRequest>) => {
  void extract(event.data)
})

async function extract(message: ExtractPdfRequest) {
  try {
    const loadingTask = pdfjs.getDocument({ data: new Uint8Array(message.buffer) })
    const pdf = await loadingTask.promise
    const pages: string[] = []

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber)
      const content = await page.getTextContent()
      const parts: string[] = []

      for (const item of content.items) {
        const textItem = item as PdfTextItem
        if (!textItem.str) continue
        parts.push(textItem.str)
        if (textItem.hasEOL) parts.push('\n')
      }

      pages.push(cleanPageText(parts.join(' ')))
      post({
        id: message.id,
        type: 'progress',
        progress: Math.round((pageNumber / pdf.numPages) * 100),
        pageNumber,
        totalPages: pdf.numPages,
      })
    }

    const text = cleanPageText(pages.filter(Boolean).join('\n\n'))
    if (!text) {
      throw new Error('No extractable text was found. Scanned PDFs need OCR before upload.')
    }

    post({ id: message.id, type: 'complete', text, pageCount: pdf.numPages })
  } catch (error) {
    post({
      id: message.id,
      type: 'error',
      message: error instanceof Error ? error.message : 'PDF extraction failed.',
    })
  }
}
