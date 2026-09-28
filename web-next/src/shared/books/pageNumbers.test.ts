import { describe, expect, it } from 'vitest'
import {
  isPageNumberBlock,
  isPageNumberLine,
  speechTextWithoutPageNumbers,
  splitPageNumberLines,
} from './pageNumbers'

describe('page number lines', () => {
  it('recognizes printed page furniture and leaves prose alone', () => {
    expect(isPageNumberLine('42')).toBe(true)
    expect(isPageNumberLine('  7. ')).toBe(true)
    expect(isPageNumberLine('Page 12')).toBe(true)
    expect(isPageNumberLine('p. 3')).toBe(true)
    expect(isPageNumberLine('- 18 -')).toBe(true)
    expect(isPageNumberLine('—12—')).toBe(true)
    expect(isPageNumberLine('[204]')).toBe(true)
    expect(isPageNumberLine('12 / 340')).toBe(true)
    expect(isPageNumberLine('12 of 340')).toBe(true)

    expect(isPageNumberLine('He turned 12.')).toBe(false)
    expect(isPageNumberLine('Chapter 1')).toBe(false)
    expect(isPageNumberLine('1984')).toBe(false)
    expect(isPageNumberLine('1776')).toBe(false)
    expect(isPageNumberLine('"42."')).toBe(false)
    expect(isPageNumberLine('1. Buy milk')).toBe(false)
  })

  it('hides a paragraph that is only a page number', () => {
    expect(isPageNumberBlock('42')).toBe(true)
    expect(isPageNumberBlock('\n- 9 -\n')).toBe(true)
    expect(isPageNumberBlock('He left.\n42')).toBe(false)
  })

  it('keeps every character when splitting, and drops numbers from speech', () => {
    const text = 'He left the room.\n\n42\n\nShe opened the door.'
    const runs = splitPageNumberLines(text)
    expect(runs.map((run) => run.text).join('')).toBe(text)
    expect(runs.filter((run) => run.pageNumber).map((run) => run.text).join('')).toBe('42\n')
    expect(speechTextWithoutPageNumbers(text)).toBe('He left the room.\n\nShe opened the door.')
  })

  it('drops a page number glued to the end of a line and keeps fig. 12', () => {
    const text = 'She opened the door. 42\nSee fig. 12 tomorrow.'
    const runs = splitPageNumberLines(text)
    expect(runs.map((run) => run.text).join('')).toBe(text)
    expect(runs.some((run) => run.pageNumber && run.text.includes('42'))).toBe(true)
    expect(speechTextWithoutPageNumbers(text)).toBe('She opened the door.\nSee fig. 12 tomorrow.')
  })

  it('returns the original string when there is no page number', () => {
    const text = 'He left the room.\n\nShe opened the door.'
    expect(speechTextWithoutPageNumbers(text)).toBe(text)
  })

  it('speaks nothing for a slice that is only a page number', () => {
    expect(speechTextWithoutPageNumbers('\n\n42\n\n')).toBe('')
  })
})
