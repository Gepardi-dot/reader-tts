import { describe, expect, it } from 'vitest'
import {
  peekLaunchFiles,
  queueLaunchFiles,
  subscribeLaunchArrival,
  takeLaunchFiles,
} from './pwaLaunch'

describe('pwaLaunch', () => {
  it('queues files until they are taken', () => {
    const file = new File(['hello'], 'book.epub', { type: 'application/epub+zip' })
    queueLaunchFiles([file])
    expect(peekLaunchFiles()).toHaveLength(1)
    expect(takeLaunchFiles()[0]?.name).toBe('book.epub')
    expect(takeLaunchFiles()).toEqual([])
  })

  it('notifies arrival listeners without consuming', () => {
    const file = new File(['x'], 'note.txt', { type: 'text/plain' })
    let hits = 0
    const stop = subscribeLaunchArrival(() => {
      hits += 1
    })
    queueLaunchFiles([file])
    expect(hits).toBe(1)
    expect(peekLaunchFiles()).toHaveLength(1)
    stop()
    queueLaunchFiles([file])
    expect(hits).toBe(1)
    takeLaunchFiles()
  })
})
