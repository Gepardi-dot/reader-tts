/** Same estimate the worker uses when a book has no stored page count. */
export const ESTIMATED_PAGE_CHARS = 2400

export function estimatedPageCount(textLength: number): number {
  return Math.max(1, Math.ceil(Math.max(0, textLength) / ESTIMATED_PAGE_CHARS))
}

export function bookPageTotal(textLength: number, storedPageCount: number | null | undefined): number {
  if (storedPageCount != null && Number.isFinite(storedPageCount) && storedPageCount > 0) {
    return Math.round(storedPageCount)
  }
  return estimatedPageCount(textLength)
}

/** 0 at the first character, 100 at the last. Page counts are only a fallback. */
export function progressPercent(progress: {
  textStart?: number | null
  textLength?: number | null
  pageNumber?: number | null
  totalPages?: number | null
} | null | undefined): number {
  if (!progress) return 0
  const length = progress.textLength ?? 0
  const start = progress.textStart
  if (length > 0 && start != null && Number.isFinite(start)) {
    if (start <= 0) return 0
    if (start >= length - 1) return 100
    return Math.round((start / length) * 100)
  }
  const total = progress.totalPages ?? 0
  const page = progress.pageNumber ?? 0
  if (total <= 0 || page <= 0) return 0
  return Math.min(100, Math.round((page / total) * 100))
}

/** Book page that contains this character, using the book's own page count. */
export function pagesForOffset(offset: number, textLength: number, totalPages: number): {
  pageNumber: number
  totalPages: number
} {
  const total = Math.max(1, Math.round(totalPages) || 1)
  const length = Math.max(0, textLength)
  if (length <= 1 || offset <= 0) return { pageNumber: 1, totalPages: total }
  if (offset >= length - 1) return { pageNumber: total, totalPages: total }
  const page = Math.min(total, Math.max(1, Math.ceil((offset / length) * total)))
  return { pageNumber: page, totalPages: total }
}
