import { describe, expect, it } from 'vitest'
import { prepareMagpieSpeech } from './magpieSpeech'

describe('prepareMagpieSpeech', () => {
  it('keeps a comma, which is the breath Magpie already takes', () => {
    const text = 'She opened the door, and the room was dark.'
    expect(prepareMagpieSpeech(text)).toBe(text)
  })

  it('writes an em dash as a comma, the beat Magpie actually pauses on', () => {
    expect(prepareMagpieSpeech('The answer was simple — nobody had looked.')).toBe(
      'The answer was simple, nobody had looked.',
    )
    expect(prepareMagpieSpeech('Wait -- what was that noise?')).toBe(
      'Wait, what was that noise?',
    )
  })

  it('turns a semicolon or a colon into a breath, and leaves a clock alone', () => {
    expect(prepareMagpieSpeech('She waited; the room was still.')).toBe(
      'She waited, the room was still.',
    )
    expect(prepareMagpieSpeech('He said: the door was open.')).toBe(
      'He said, the door was open.',
    )
    expect(prepareMagpieSpeech('The train leaves at 3:45.')).toBe(
      'The train leaves at 3:45.',
    )
  })

  it('leaves a number range alone', () => {
    expect(prepareMagpieSpeech('From 1914–1918 the war went on.')).toBe(
      'From 1914–1918 the war went on.',
    )
    expect(prepareMagpieSpeech('a well-known road')).toBe('a well-known road')
  })

  it('keeps one ellipsis as a weighted pause', () => {
    expect(prepareMagpieSpeech('And then... nothing happened.')).toBe(
      'And then … nothing happened.',
    )
    expect(prepareMagpieSpeech('And then … nothing happened.')).toBe(
      'And then … nothing happened.',
    )
  })

  it('ends a paragraph that would otherwise run on', () => {
    expect(prepareMagpieSpeech('She waited\n\nThen she left.')).toBe(
      'She waited. Then she left.',
    )
    expect(prepareMagpieSpeech('She stopped.\n\nHe left the room.')).toBe(
      'She stopped. He left the room.',
    )
  })

  it('separates a sentence that was glued to the next word', () => {
    expect(prepareMagpieSpeech('She stopped.The room was dark.')).toBe(
      'She stopped. The room was dark.',
    )
  })

  it('speaks titles so the period is not a stop', () => {
    expect(prepareMagpieSpeech('Dr. Smith met Mr. Adler.')).toBe(
      'Doctor Smith met Mister Adler.',
    )
  })

  it('is unchanged for a plain sentence and safe to run twice', () => {
    const text = 'In 1984 the war ended.'
    expect(prepareMagpieSpeech(text)).toBe(text)
    const shaped = prepareMagpieSpeech('Wait — she said...\n\nThen silence.')
    expect(prepareMagpieSpeech(shaped)).toBe(shaped)
  })
})
