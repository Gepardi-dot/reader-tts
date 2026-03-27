const LOCAL_HOST_PATTERN =
  /^(localhost|127\.0\.0\.1|0\.0\.0\.0|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})$/
export const HOSTED_UPLOAD_BODY_LIMIT_BYTES = Math.floor(4.5 * 1024 * 1024)

function configuredApiOrigin() {
  const configured = import.meta.env.VITE_API_ORIGIN?.trim()
  return configured ? configured.replace(/\/$/, '') : null
}

function fallbackApiOrigin() {
  if (typeof window === 'undefined') {
    return null
  }

  const { protocol, hostname, port } = window.location
  if (!LOCAL_HOST_PATTERN.test(hostname)) {
    return null
  }

  if (port === '8000') {
    return null
  }

  return `${protocol}//${hostname}:8000`
}

function canUseFallbackOrigin(input: string) {
  return input.startsWith('/api/') || input.startsWith('/library/')
}

export function usesHostedFunctionUploadLimit() {
  if (typeof window === 'undefined') {
    return false
  }

  return !configuredApiOrigin() && !LOCAL_HOST_PATTERN.test(window.location.hostname)
}

function shouldRetryWithFallback(input: string, response: Response) {
  if (!canUseFallbackOrigin(input)) {
    return false
  }

  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  const looksLikeBackendResponse = contentType.includes('application/json') || contentType.includes('audio/')
  return !looksLikeBackendResponse && [404, 405, 502, 503, 504].includes(response.status)
}

export async function apiRequest<T>(input: string, init?: RequestInit): Promise<T> {
  const explicitOrigin = configuredApiOrigin()
  const fallbackOrigin = explicitOrigin ?? fallbackApiOrigin()
  const primaryUrl = explicitOrigin && input.startsWith('/') ? `${explicitOrigin}${input}` : input
  let response: Response | null = null

  try {
    response = await fetch(primaryUrl, init)
  } catch {
    if (!explicitOrigin && fallbackOrigin && input.startsWith('/')) {
      try {
        response = await fetch(`${fallbackOrigin}${input}`, init)
      } catch {
        const hint = ` Make sure the API is running at ${fallbackOrigin}.`
        throw new Error(`Failed to reach Storybook Reader.${hint}`)
      }
    } else {
      const hint = fallbackOrigin
        ? ` Make sure the API is running at ${fallbackOrigin}.`
        : ' Make sure the API server is running and reachable from this browser.'
      throw new Error(`Failed to reach Storybook Reader.${hint}`)
    }
  }

  if (
    response &&
    !response.ok &&
    !explicitOrigin &&
    fallbackOrigin &&
    input.startsWith('/') &&
    shouldRetryWithFallback(input, response)
  ) {
    try {
      response = await fetch(`${fallbackOrigin}${input}`, init)
    } catch {
      const hint = ` Make sure the API is running at ${fallbackOrigin}.`
      throw new Error(`Failed to reach Storybook Reader.${hint}`)
    }
  }

  if (!response) {
    throw new Error('Failed to reach Storybook Reader.')
  }

  const isJson = response.headers.get('content-type')?.includes('application/json')
  const payload = isJson ? await response.json() : null

  if (!response.ok) {
    if (response.status === 413) {
      throw new Error(
        'This PDF is too large for the current production upload path. Vercel only allows 4.5 MB request bodies, so larger books need direct-to-storage uploads.',
      )
    }

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

export async function uploadBookDirectToStorage(file: File) {
  const init = await apiRequest<{
    bookId: string
    upload: {
      url: string
      fields: Record<string, string>
    }
  }>('/api/books/direct-upload', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      fileName: file.name,
      contentType: file.type || 'application/pdf',
      size: file.size,
    }),
  })

  const payload = new FormData()
  for (const [key, value] of Object.entries(init.upload.fields)) {
    payload.append(key, value)
  }
  payload.append('file', file)

  let uploadResponse: Response
  try {
    uploadResponse = await fetch(init.upload.url, {
      method: 'POST',
      body: payload,
    })
  } catch {
    throw new Error(
      'Direct storage upload failed before the file reached the API. Check the storage bucket CORS settings and the network connection.',
    )
  }

  if (!uploadResponse.ok) {
    throw new Error(`Direct storage upload failed with status ${uploadResponse.status}.`)
  }

  return apiRequest<import('./types').Book>('/api/books/direct-upload/complete', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      bookId: init.bookId,
      fileName: file.name,
    }),
  })
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
