import { afterEach, describe, expect, it, vi } from 'vitest'
import { coverSearchTermsForBook, findBookCover } from './coverLookup'

afterEach(() => {
  vi.unstubAllGlobals()
})

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('coverSearchTermsForBook', () => {
  it('splits dashed filename titles into title and author candidates', () => {
    expect(coverSearchTermsForBook('the-art-of-seduction-robert-greene')).toContainEqual({
      title: 'the art of seduction',
      author: 'Robert Greene',
    })
  })

  it('uses the original file name as a fallback search source', () => {
    expect(coverSearchTermsForBook('Untitled book', 'Storyworthy-_Matthew_Dicks[1].pdf')).toContainEqual({
      title: 'Storyworthy',
      author: 'Matthew Dicks',
    })
  })

  it('splits title plus author and ignores academic suffixes', () => {
    expect(coverSearchTermsForBook('Influence Robert B. Cialdini PhD')).toContainEqual({
      title: 'Influence',
      author: 'Robert B. Cialdini',
    })
    expect(coverSearchTermsForBook('Influence Robert B. Cialdini PhD')).not.toContainEqual({
      title: 'Influence Robert B.',
      author: 'Cialdini Phd',
    })
  })

  it('does not use Google Books during library cover lookup', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ docs: [] }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(findBookCover('Codex TTS Tuning Sample')).resolves.toBeNull()

    const requestedUrls = (fetchMock.mock.calls as unknown[][]).map(([url]) => String(url))
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(requestedUrls.every((url) => url.startsWith('https://openlibrary.org/'))).toBe(true)
    expect(requestedUrls.some((url) => url.includes('googleapis.com'))).toBe(false)
  })

  it('stops cover lookup after OpenLibrary returns a cover id', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ docs: [] }))
      .mockResolvedValueOnce(jsonResponse({ docs: [{ cover_i: 1234 }] }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(findBookCover('The Art of Seduction Robert Greene')).resolves.toBe(
      'https://covers.openlibrary.org/b/id/1234-L.jpg',
    )

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
