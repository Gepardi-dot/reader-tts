/**
 * Resolve where `/api/*` lives.
 *
 * - empty → same-origin (Cloudflare unified Worker+SPA, or Vite dev proxy)
 * - absolute URL → cross-origin Worker (Vercel static UI → Cloudflare API)
 *
 * Runtime guard: any `*.vercel.app` host never uses relative `/api`, even if the
 * bundle was built with VITE_API_ORIGIN=relative (Cloudflare deploy default).
 * Vercel only serves static files; POSTing same-origin /api returns 405 and
 * login appears broken.
 */
export const FALLBACK_ABSOLUTE_API = 'https://reader-tts-api.reader-tts-ari.workers.dev'

/** True when this page is on a static frontend that has no Worker /api. */
export function isStaticFrontendHost(hostname = typeof window !== 'undefined' ? window.location.hostname : '') {
  if (!hostname) return false
  // Production + preview + team aliases on Vercel
  if (hostname === 'readertts.vercel.app') return true
  if (hostname.endsWith('.vercel.app')) return true
  return false
}

function envApiOrigin(): string {
  const raw = import.meta.env.VITE_API_ORIGIN as string | undefined
  if (raw === 'relative' || raw === 'same-origin') return ''
  const fromEnv = typeof raw === 'string' ? raw.trim() : ''
  if (fromEnv) return fromEnv.replace(/\/$/, '')
  if (import.meta.env.DEV) return ''
  if (import.meta.env.PROD && import.meta.env.VITE_API_MODE === 'absolute') {
    return FALLBACK_ABSOLUTE_API
  }
  return ''
}

/**
 * Base origin for API calls (no trailing slash), or '' for same-origin `/api`.
 */
export function configuredApiOrigin(): string {
  // Prefer an explicit absolute env URL when present.
  const fromEnv = envApiOrigin()
  if (fromEnv.startsWith('http')) return fromEnv

  // SPA on Vercel (or other static host): never relative — force Worker URL.
  if (typeof window !== 'undefined' && isStaticFrontendHost()) {
    return FALLBACK_ABSOLUTE_API
  }

  return fromEnv
}

export function resolveApiUrl(url: string): string {
  if (url.startsWith('http')) return url
  return `${configuredApiOrigin()}${url}`
}

/** True when a failed response looks like a static host (HTML shell / 405), not the API. */
export function looksLikeMissingApi(status: number, bodyText: string): boolean {
  if (status === 404 || status === 405) return true
  const sample = bodyText.slice(0, 200).toLowerCase()
  return sample.includes('<!doctype') || sample.includes('<html')
}
