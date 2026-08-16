import { isRouteErrorResponse, useNavigate, useRouteError } from 'react-router-dom'
import { isChunkLoadError, tryReloadForStaleChunk } from '@/app/chunkLoad'
import { Button } from '@/components/ui/button'

/**
 * Friendly fallback for route loaders / lazy chunks.
 * Replaces React Router's default "Unexpected Application Error!" page.
 */
export function RouteError() {
  const error = useRouteError()
  const navigate = useNavigate()

  // Attempt one more auto-reload if this is a stale chunk (no-op if cooldown).
  if (isChunkLoadError(error) && tryReloadForStaleChunk(error)) {
    return (
      <div className="flex min-h-svh items-center justify-center px-4 text-sm text-muted-foreground">
        Updating app…
      </div>
    )
  }

  let title = 'Something went wrong'
  let detail = 'An unexpected error occurred.'
  let showReload = true

  if (isRouteErrorResponse(error)) {
    title = error.status === 404 ? 'Page not found' : `Error ${error.status}`
    detail = typeof error.data === 'string' ? error.data : error.statusText || detail
    showReload = error.status !== 404
  } else if (isChunkLoadError(error)) {
    title = 'App update available'
    detail =
      'This page was still using an older version after a deploy. Reload to get the latest app.'
    showReload = true
  } else if (error instanceof Error) {
    detail = error.message
  }

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-4 bg-background px-4 text-center">
      <span className="text-3xl" aria-hidden>📚</span>
      <div className="max-w-md space-y-2">
        <h1 className="text-lg font-semibold text-foreground">{title}</h1>
        <p className="text-sm text-muted-foreground">{detail}</p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {showReload && (
          <Button
            type="button"
            onClick={() => {
              const url = new URL(window.location.href)
              url.searchParams.set('_chunk', String(Date.now()))
              window.location.replace(url.toString())
            }}
          >
            Reload app
          </Button>
        )}
        <Button type="button" variant="outline" onClick={() => navigate('/library', { replace: true })}>
          Go to library
        </Button>
      </div>
    </div>
  )
}
