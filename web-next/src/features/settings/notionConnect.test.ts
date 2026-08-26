import { describe, expect, it } from 'vitest'

export function pickNotionHome(items: Array<{ id: string; object: 'page' | 'database'; title: string }>) {
  const pages = items.filter((item) => item.object === 'page')
  const named = pages.find((item) => item.title.trim().toLowerCase() === 'higgsread')
  if (named) return named
  if (pages[0]) return pages[0]
  return items.find((item) => item.object === 'database') ?? null
}

export function isAllowedReturnOrigin(origin: string) {
  try {
    const url = new URL(origin)
    if (url.hostname === 'higgsread.com' || url.hostname === 'www.higgsread.com') return true
    if (url.hostname === 'readertts.vercel.app' || url.hostname.endsWith('.vercel.app')) return true
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return true
    return false
  } catch {
    return false
  }
}

describe('pickNotionHome', () => {
  it('prefers an existing HiggsRead page', () => {
    expect(pickNotionHome([
      { id: 'a', object: 'page', title: 'Projects' },
      { id: 'b', object: 'page', title: 'HiggsRead' },
    ])?.id).toBe('b')
  })

  it('uses the first shared page otherwise', () => {
    expect(pickNotionHome([
      { id: 'a', object: 'page', title: 'Reading' },
    ])?.id).toBe('a')
  })

  it('falls back to a database', () => {
    expect(pickNotionHome([
      { id: 'db', object: 'database', title: 'Books' },
    ])?.id).toBe('db')
  })
})

describe('cleanNotionCredential', () => {
  it('strips quotes and newlines from stored secrets', () => {
    const raw = '"3c8d872b-594c-813a-8bcb-083709ddb4dc"\r\n'
    const cleaned = raw.replace(/^\uFEFF/, '').replace(/[\r\n\t]+/g, '').trim().replace(/^['"]+|['"]+$/g, '')
    expect(cleaned).toBe('3c8d872b-594c-813a-8bcb-083709ddb4dc')
  })
})

describe('isAllowedReturnOrigin', () => {
  it('allows the production app and local Vite', () => {
    expect(isAllowedReturnOrigin('https://www.higgsread.com')).toBe(true)
    expect(isAllowedReturnOrigin('http://localhost:5175')).toBe(true)
    expect(isAllowedReturnOrigin('https://evil.example')).toBe(false)
  })
})
