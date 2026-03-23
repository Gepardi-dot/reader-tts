export async function apiRequest<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init)
  const isJson = response.headers.get('content-type')?.includes('application/json')
  const payload = isJson ? await response.json() : null

  if (!response.ok) {
    const detail =
      typeof payload?.detail === 'string'
        ? payload.detail
        : typeof payload?.message === 'string'
          ? payload.message
          : `Request failed with status ${response.status}.`
    throw new Error(detail)
  }

  return payload as T
}

export function fetchProviders() {
  return apiRequest<{
    defaultNarrationStyle: string
    providers: import('./types').ProviderCatalog[]
  }>('/api/providers')
}

export function fetchBooks() {
  return apiRequest<{ items: import('./types').Book[] }>('/api/books')
}

export function deleteBook(bookId: string) {
  return apiRequest<{ ok: boolean }>(`/api/books/${bookId}`, {
    method: 'DELETE',
  })
}

export function fetchBookReader(bookId: string) {
  return apiRequest<import('./types').ReaderPayload>(`/api/books/${bookId}/reader`)
}

export function createLiveAudioSegment(
  bookId: string,
  payload: {
    provider: import('./types').ProviderCatalog['id']
    voice?: string
    model?: string
    output_format?: 'mp3' | 'wav'
    narration_style: string
    length_scale: number
    sentence_silence: number
    pageNumber: number
    start: number
    end: number
    text: string
  },
) {
  return apiRequest<import('./types').LiveAudioSegment>(`/api/books/${bookId}/live-audio`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
}

export function fetchBookProgress(bookId: string) {
  return apiRequest<import('./types').BookProgress>(`/api/books/${bookId}/progress`)
}

export function updateBookReadingProgress(
  bookId: string,
  payload: {
    pageNumber: number
    totalPages: number
    textStart: number
    textEnd: number
    textLength: number
    updatedAt: string
  },
  options?: { keepalive?: boolean },
) {
  return apiRequest<import('./types').ReadingProgress>(`/api/books/${bookId}/progress/reading`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    keepalive: options?.keepalive,
  })
}

export function updateBookAudioProgress(
  bookId: string,
  payload: {
    audioUrl: string
    currentTime: number
    wasPlaying: boolean
    updatedAt: string
  },
  options?: { keepalive?: boolean },
) {
  return apiRequest<import('./types').StoredAudioProgress>(`/api/books/${bookId}/progress/audio`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    keepalive: options?.keepalive,
  })
}

export function clearBookAudioProgress(bookId: string, options?: { keepalive?: boolean }) {
  return apiRequest<{ ok: boolean }>(`/api/books/${bookId}/progress/audio`, {
    method: 'DELETE',
    keepalive: options?.keepalive,
  })
}

export function fetchPollyHealth() {
  return apiRequest<import('./types').PollyHealth>('/api/providers/polly/health')
}

export function createHighlight(
  bookId: string,
  payload: {
    start: number
    end: number
    color: import('./types').HighlightColor
    text: string
    note?: string
  },
) {
  return apiRequest<import('./types').Highlight>(`/api/books/${bookId}/highlights`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
}

export function deleteHighlight(bookId: string, highlightId: string) {
  return apiRequest<{ ok: boolean }>(`/api/books/${bookId}/highlights/${highlightId}`, {
    method: 'DELETE',
  })
}

export function testProvider(
  payload: {
    provider: import('./types').ProviderCatalog['id']
    voice?: string
    model?: string
    narration_style: string
    length_scale: number
    sentence_silence: number
  },
) {
  return apiRequest<import('./types').ProviderTestResult>('/api/providers/test', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
}

export function cancelJob(jobId: string) {
  return apiRequest<import('./types').JobStatus>(`/api/jobs/${jobId}/cancel`, {
    method: 'POST',
  })
}
