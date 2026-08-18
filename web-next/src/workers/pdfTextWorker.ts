/// <reference lib="webworker" />

import { extractPdfDocument } from '@/shared/books/extractPdfDocument'

interface ExtractPdfRequest {
  id: string
  buffer: ArrayBuffer
}

type ExtractPdfResponse =
  | { type: 'ready' }
  | { id: string; type: 'progress'; progress: number; pageNumber: number; totalPages: number }
  | { id: string; type: 'complete'; text: string; pageCount: number; cover?: ArrayBuffer; coverType?: string }
  | { id: string; type: 'error'; message: string }

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope

function post(message: ExtractPdfResponse) {
  ctx.postMessage(message)
}

ctx.addEventListener('message', (event: MessageEvent<ExtractPdfRequest>) => {
  void extract(event.data)
})

post({ type: 'ready' })

async function extract(message: ExtractPdfRequest) {
  if (!message?.id || !message.buffer) return
  try {
    const result = await extractPdfDocument(message.buffer, ({ pageNumber, totalPages }) => {
      post({
        id: message.id,
        type: 'progress',
        progress: Math.round((pageNumber / totalPages) * 100),
        pageNumber,
        totalPages,
      })
    })
    post({
      id: message.id,
      type: 'complete',
      text: result.text,
      pageCount: result.pageCount,
      cover: result.cover,
      coverType: result.coverType,
    })
  } catch (error) {
    post({
      id: message.id,
      type: 'error',
      message: error instanceof Error ? error.message : 'PDF extraction failed.',
    })
  }
}
