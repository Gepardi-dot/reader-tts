import { describe, expect, it } from 'vitest'
import { splitTextIntoChapters } from './chapterSplit'

describe('splitTextIntoChapters', () => {
  it('splits markdown headings', () => {
    const text = '# Intro\n\nHello.\n\n# Middle\n\nWorld.\n\n# End\n\nBye.'
    const ch = splitTextIntoChapters(text, 'Demo')
    expect(ch.length).toBeGreaterThanOrEqual(3)
    expect(ch[0].title).toMatch(/Intro/i)
    expect(ch[0].text).toMatch(/Hello/)
  })

  it('splits Chapter N headings', () => {
    const text = 'Chapter 1\nOnce.\n\nChapter 2\nTwice.\n\nChapter 3\nThrice.'
    const ch = splitTextIntoChapters(text, 'Demo')
    expect(ch.length).toBeGreaterThanOrEqual(3)
  })

  it('returns one chapter for plain prose', () => {
    const ch = splitTextIntoChapters('Just a short story without headings.', 'Tale')
    expect(ch).toHaveLength(1)
    expect(ch[0].text).toMatch(/short story/)
  })
})
