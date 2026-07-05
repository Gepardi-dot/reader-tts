import { describe, expect, it } from 'vitest'
import { buildTtsChunks } from './segmenter'

describe('tts v2 segmenter', () => {
  it('builds absolute chunks from a tapped offset', () => {
    const text = [
      'Before the tap. ',
      `${'quick '.repeat(36)}first boundary. `,
      `${'steady '.repeat(80)}second boundary.`,
    ].join('')
    const startOffset = text.indexOf('quick')

    const chunks = buildTtsChunks({
      bookText: text,
      startOffset,
      provider: 'google',
      presynthGrid: null,
      kokoroModelReady: true,
    })

    expect(chunks.length).toBeGreaterThan(2)
    expect(chunks[0]).toMatchObject({
      index: 0,
      start: startOffset,
      text: text.slice(startOffset, chunks[0].end),
      status: 'idle',
      url: null,
      buffer: null,
    })
    expect(chunks.map((chunk) => chunk.text).join('')).toBe(text.slice(startOffset, chunks.at(-1)?.end))
  })

  it('uses the Kokoro grid window only while the local model is cold', () => {
    const text = [
      'Intro words before the tap. ',
      `${'cold '.repeat(40)}grid boundary. `,
      `${'next '.repeat(80)}second boundary.`,
    ].join('')
    const startOffset = text.indexOf('cold')
    const grid = [
      { start: 0, end: text.indexOf('second boundary.') },
      { start: text.indexOf('second boundary.'), end: text.length },
    ]

    const coldChunks = buildTtsChunks({
      bookText: text,
      startOffset,
      provider: 'kokoro',
      presynthGrid: grid,
      kokoroModelReady: false,
    })
    const warmChunks = buildTtsChunks({
      bookText: text,
      startOffset,
      provider: 'kokoro',
      presynthGrid: grid,
      kokoroModelReady: true,
    })

    expect(coldChunks[0].start).toBe(startOffset)
    expect(coldChunks.length).toBeGreaterThan(1)
    expect(warmChunks[0].start).toBe(startOffset)
    expect(warmChunks.map((chunk) => chunk.text).join('')).toContain('second boundary.')
  })

  it('returns no chunks when the tapped position has no readable text', () => {
    expect(buildTtsChunks({
      bookText: 'Readable text.      ',
      startOffset: 15,
      provider: 'google',
      presynthGrid: null,
      kokoroModelReady: true,
    })).toEqual([])
  })
})

