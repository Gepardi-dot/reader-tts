/**
 * Built-in pipeline: any supported upload format → extract text → EPUB 3.
 *
 * 1. extractBookText (PDF/DOCX/EPUB/…)
 * 2. split into chapters
 * 3. package as .epub via epubBuilder
 *
 * The app still saves plain text to the API for reading/TTS; the EPUB is the
 * portable normalized form (download or re-import).
 */

import { splitTextIntoChapters } from '@/shared/books/chapterSplit'
import { buildEpub, type BuiltEpub } from '@/shared/books/epubBuilder'
import {
  extractBookText,
  type BookExtractionProgress,
  type ExtractedBookPayload,
} from '@/shared/books/extractBookText'
import { isSupportedBookFile, resolveBookFormat } from '@/shared/books/bookFormats'

export type ConvertProgress = BookExtractionProgress & {
  /** Extra phase after extraction */
  phase: BookExtractionProgress['phase'] | 'converting'
}

export interface ConvertToEpubResult {
  /** Normalized book payload (for API upload / reader) */
  book: ExtractedBookPayload
  /** Generated EPUB package */
  epub: BuiltEpub
  /** Original source kind label */
  sourceLabel: string
  cover?: Blob | null
}

export interface ConvertToEpubOptions {
  title?: string | null
  author?: string
  language?: string
  onProgress?: (progress: ConvertProgress) => void
}

/**
 * Convert any supported file into a clean EPUB 3 blob + extracted text.
 * Already-EPUB files are still re-packaged so structure is consistent.
 */
export async function convertFileToEpub(
  file: File,
  options: ConvertToEpubOptions = {},
): Promise<ConvertToEpubResult> {
  if (!isSupportedBookFile(file)) {
    throw new Error(
      'Unsupported format. Try PDF, EPUB, DOCX, ODT, RTF, FB2, HTML, Markdown, TXT, CSV, or JSON.',
    )
  }

  const format = resolveBookFormat(file)
  const sourceLabel = format?.label ?? 'Document'

  const book = await extractBookText(file, {
    title: options.title,
    onProgress: options.onProgress,
  })

  let cover = book.cover ?? null
  if (!cover) {
    options.onProgress?.({
      phase: 'converting',
      progress: 90,
      message: 'Looking up book cover...',
    })
    try {
      const { lookupRemoteCover } = await import('@/features/library/resolveBookCover')
      const { dataUrlToBlob } = await import('@/shared/books/extractCover')
      const found = await lookupRemoteCover(book.title, file.name)
      if (found) cover = await dataUrlToBlob(found.dataUrl)
    } catch {
      cover = null
    }
  }

  options.onProgress?.({
    phase: 'converting',
    progress: 92,
    message: 'Building EPUB package...',
  })

  const chapters = splitTextIntoChapters(book.text, book.title)
  const epub = await buildEpub({
    title: book.title,
    author: options.author,
    language: options.language,
    chapters,
    fileNameBase: book.fileName.replace(/\.[^.]+$/, '') || book.title,
    cover: cover ?? undefined,
  })

  options.onProgress?.({
    phase: 'converting',
    progress: 98,
    message: `EPUB ready (${epub.chapterCount} chapter${epub.chapterCount === 1 ? '' : 's'})...`,
  })

  return {
    book: {
      ...book,
      // Prefer .epub as the normalized source name for library display
      fileName: book.fileName.replace(/\.[^.]+$/i, '') + '.epub',
      sourceFormat: 'epub',
      cover,
    },
    epub,
    sourceLabel,
    cover,
  }
}
