import type { TtsPhase } from './types'

/**
 * Hold the display on while speech is playing or buffering.
 *
 * A manual lock hides the page, and the browser releases this sentinel on
 * its own. This module does not pause audio. The lock is requested again
 * once the page is visible and speech is still going.
 *
 * Release waits one microtask so stop()+start() in the same turn (a voice
 * change) does not drop a lock the new session still needs.
 */

let wanted = false
let keepAwake = false
let epoch = 0
let pendingTicket = 0
let sentinel: WakeLockSentinel | null = null
let listening = false

export function screenWakeForPhase(phase: TtsPhase): void {
  if (phase === 'playing' || phase === 'buffering') {
    keepAwake = true
    holdScreenAwake()
    return
  }
  keepAwake = false
  queueMicrotask(() => {
    if (!keepAwake) releaseScreenAwake()
  })
}

export function holdScreenAwake(): void {
  wanted = true
  listen()
  void acquire()
}

export function releaseScreenAwake(): void {
  wanted = false
  epoch += 1
  pendingTicket = 0
  const current = sentinel
  sentinel = null
  if (!current) return
  void current.release().catch(() => undefined)
}

function listen(): void {
  if (listening || typeof document === 'undefined') return
  listening = true
  document.addEventListener('visibilitychange', () => {
    if (!wanted || document.visibilityState !== 'visible') return
    void acquire()
  })
  if (typeof window === 'undefined') return
  const rearm = () => {
    if (!wanted) return
    void acquire()
  }
  window.addEventListener('pointerdown', rearm, true)
  window.addEventListener('keydown', rearm, true)
  window.addEventListener('pageshow', rearm)
}

function wakeLockApi(): WakeLock | null {
  if (typeof navigator === 'undefined') return null
  const lock = navigator.wakeLock
  if (!lock || typeof lock.request !== 'function') return null
  return lock
}

async function acquire(): Promise<void> {
  if (!wanted) return
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
  if (sentinel && !sentinel.released) return
  // Play calls this twice in one turn (before unlock, then on emit) before
  // the first request resolves. One request is enough.
  if (pendingTicket !== 0) return
  const lock = wakeLockApi()
  if (!lock) return
  const ticket = ++epoch
  pendingTicket = ticket
  try {
    const next = await lock.request('screen')
    if (!wanted || ticket !== epoch) {
      void next.release().catch(() => undefined)
      return
    }
    sentinel = next
    next.addEventListener('release', () => {
      if (sentinel === next) sentinel = null
    })
  } catch {
    // Denied (hidden page, low-power mode, or no user gesture). A later
    // tap or a return to the visible page tries again while speech continues.
  } finally {
    if (pendingTicket === ticket) pendingTicket = 0
  }
}
