/**
 * Run pdf.js in the current realm (worker or main thread).
 *
 * Importing the worker module sets globalThis.pdfjsWorker so pdf.js uses its
 * in-process "fake worker" instead of `new Worker()` — Safari cannot nest
 * dedicated workers, which is what the previous setup tried to do.
 */

import { collectPdfTextItems } from '@/shared/books/pdfCompat'
import { extractIsbnsFromText, looksLikeAuthorName, looksLikeBookTitle } from '@/shared/books/bookIdentifiers'
import 'pdfjs-dist/legacy/build/pdf.worker.mjs'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'

export interface ExtractPdfProgress {
  pageNumber: number
  totalPages: number
}

export interface ExtractedPdfDocument {
  text: string
  pageCount: number
  cover?: ArrayBuffer
  coverType?: string
  title?: string
  author?: string
  isbn?: string
}

const ISBN_SCAN_PAGES = 4

async function readPdfMetadata(pdf: pdfjs.PDFDocumentProxy): Promise<{
  title?: string
  author?: string
  isbn?: string
}> {
  try {
    const data = await pdf.getMetadata()
    const info = (data?.info ?? {}) as Record<string, unknown>
    const chunks: string[] = []
    const titleRaw = typeof info.Title === 'string' ? info.Title : ''
    const authorRaw = typeof info.Author === 'string' ? info.Author : ''
    for (const value of [info.Title, info.Author, info.Subject, info.Keywords]) {
      if (typeof value === 'string' && value.trim()) chunks.push(value)
    }
    const metadata = data?.metadata as { get?: (name: string) => unknown } | undefined
    if (typeof metadata?.get === 'function') {
      for (const key of ['dc:title', 'dc:creator', 'dc:identifier', 'dc:subject']) {
        const value = metadata.get(key)
        if (typeof value === 'string' && value.trim()) chunks.push(value)
      }
    }
    return {
      title: looksLikeBookTitle(titleRaw) ? titleRaw.replace(/\s+/g, ' ').trim() : undefined,
      author: looksLikeAuthorName(authorRaw) ? authorRaw.replace(/\s+/g, ' ').trim() : undefined,
      isbn: extractIsbnsFromText(chunks.join('\n'))[0],
    }
  } catch {
    return {}
  }
}

function cleanPageText(raw: string) {
  return raw
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

async function renderCover(page: pdfjs.PDFPageProxy) {
  if (typeof OffscreenCanvas !== 'function') return null
  const base = page.getViewport({ scale: 1 })
  const scale = Math.min(1.5, 720 / Math.max(base.width, base.height))
  const viewport = page.getViewport({ scale })
  const canvas = new OffscreenCanvas(
    Math.max(1, Math.ceil(viewport.width)),
    Math.max(1, Math.ceil(viewport.height)),
  )
  const context = canvas.getContext('2d')
  if (!context) return null
  await page.render({
    canvas: null,
    canvasContext: context as unknown as CanvasRenderingContext2D,
    viewport,
  }).promise
  if (typeof canvas.convertToBlob !== 'function') return null
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.84 })
  return blob.arrayBuffer()
}

export async function extractPdfDocument(
  data: ArrayBuffer,
  onProgress?: (progress: ExtractPdfProgress) => void,
): Promise<ExtractedPdfDocument> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)

  const loadingTask = pdfjs.getDocument({
    data: copy,
    disableFontFace: true,
    useSystemFonts: false,
    useWasm: false,
    verbosity: 0,
  })

  try {
    const pdf = await loadingTask.promise
    const pages: string[] = []
    let cover: ArrayBuffer | undefined
    const meta = await readPdfMetadata(pdf)
    let isbn = meta.isbn

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
      const pageText = cleanPageText(collectPdfTextItems(content.items))
      pages.push(pageText)
      if (!isbn && pageNumber <= ISBN_SCAN_PAGES) {
        isbn = extractIsbnsFromText(pageText)[0]
      }
      onProgress?.({ pageNumber, totalPages: pdf.numPages })
    }

    const text = cleanPageText(pages.filter(Boolean).join('\n\n'))
    if (!text) {
      throw new Error('No extractable text was found. Scanned PDFs need OCR before upload.')
    }

    return {
      text,
      pageCount: pdf.numPages,
      cover,
      coverType: cover ? 'image/jpeg' : undefined,
      title: meta.title,
      author: meta.author,
      isbn,
    }
  } finally {
    try {
      await loadingTask.destroy()
    } catch {
      // Ignore teardown races on older WebKit.
    }
  }
}
