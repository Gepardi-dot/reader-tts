import * as pdfjs from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url'

interface ExtractPdfRequest {
  id: string
  buffer: ArrayBuffer
}

type ExtractPdfResponse =
  | { id: string; type: 'progress'; progress: number; pageNumber: number; totalPages: number }
  | { id: string; type: 'complete'; text: string; pageCount: number; cover?: ArrayBuffer; coverType?: string }
  | { id: string; type: 'error'; message: string }

interface PdfTextItem {
  str?: string
  hasEOL?: boolean
}

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope

function post(message: ExtractPdfResponse, transfer: Transferable[] = []) {
  ctx.postMessage(message, transfer)
}

async function renderCover(page: pdfjs.PDFPageProxy) {
  if (typeof OffscreenCanvas !== 'function') return null
  const base = page.getViewport({ scale: 1 })
  const scale = Math.min(1.5, 720 / Math.max(base.width, base.height))
  const viewport = page.getViewport({ scale })
  const canvas = new OffscreenCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)))
  const context = canvas.getContext('2d')
  if (!context) return null
  await page.render({
    canvas: null,
    canvasContext: context as unknown as CanvasRenderingContext2D,
    viewport,
  }).promise
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.84 })
  return blob.arrayBuffer()
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
    let cover: ArrayBuffer | undefined

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber)
      if (pageNumber === 1) {
        try {
          cover = await renderCover(page) ?? undefined
        } catch {
          cover = undefined
        }
      }
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

    post(
      { id: message.id, type: 'complete', text, pageCount: pdf.numPages, cover, coverType: cover ? 'image/jpeg' : undefined },
      cover ? [cover] : [],
    )
  } catch (error) {
    post({
      id: message.id,
      type: 'error',
      message: error instanceof Error ? error.message : 'PDF extraction failed.',
    })
  }
}
