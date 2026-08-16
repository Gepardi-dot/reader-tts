import { describe, expect, it } from 'vitest'
import {
  FALLBACK_ABSOLUTE_API,
  isStaticFrontendHost,
  looksLikeMissingApi,
} from './apiOrigin'

describe('isStaticFrontendHost', () => {
  it('treats Vercel production and previews as static frontends', () => {
    expect(isStaticFrontendHost('readertts.vercel.app')).toBe(true)
    expect(isStaticFrontendHost('reader-tts-ku-onlines-projects.vercel.app')).toBe(true)
    expect(isStaticFrontendHost('reader-tts-git-main-ku.vercel.app')).toBe(true)
  })

  it('does not treat unified Cloudflare or localhost as static-only', () => {
    expect(isStaticFrontendHost('reader-tts-api.reader-tts-ari.workers.dev')).toBe(false)
    expect(isStaticFrontendHost('localhost')).toBe(false)
    expect(isStaticFrontendHost('127.0.0.1')).toBe(false)
  })
})

describe('looksLikeMissingApi', () => {
  it('detects Vercel static 405 / HTML shell responses', () => {
    expect(looksLikeMissingApi(405, '')).toBe(true)
    expect(looksLikeMissingApi(404, '')).toBe(true)
    expect(looksLikeMissingApi(200, '<!doctype html><html>')).toBe(true)
    expect(looksLikeMissingApi(401, '{"detail":"Invalid email or password."}')).toBe(false)
  })
})

describe('FALLBACK_ABSOLUTE_API', () => {
  it('points at the production Worker', () => {
    expect(FALLBACK_ABSOLUTE_API).toMatch(/^https:\/\/reader-tts-api\./)
  })
})

describe('looksLikeMissingApi edge cases', () => {
  it('treats empty 405 as missing API but not a real JSON 401', () => {
    expect(looksLikeMissingApi(405, '')).toBe(true)
    expect(looksLikeMissingApi(401, '{"detail":"Invalid email or password."}')).toBe(false)
    expect(looksLikeMissingApi(500, 'Internal error')).toBe(false)
  })
})