/**
 * WebKit / Safari helpers. iOS Chrome and Firefox are WebKit too.
 */

export function isIosWebKit(
  userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent,
  maxTouchPoints = typeof navigator === 'undefined' ? 0 : navigator.maxTouchPoints,
  platform = typeof navigator === 'undefined' ? '' : navigator.platform,
) {
  if (/iphone|ipad|ipod/i.test(userAgent)) return true
  return platform === 'MacIntel' && maxTouchPoints > 1
}

export function isMacSafari(
  userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent,
  maxTouchPoints = typeof navigator === 'undefined' ? 0 : navigator.maxTouchPoints,
  platform = typeof navigator === 'undefined' ? '' : navigator.platform,
) {
  if (isIosWebKit(userAgent, maxTouchPoints, platform)) return false
  const ua = userAgent.toLowerCase()
  const mac = /macintosh|mac os x/.test(ua) || platform === 'MacIntel'
  const safari = /safari/.test(ua) && !/chrome|chromium|crios|edg|fxios|android/.test(ua)
  return mac && safari
}

/** True on iOS (all browsers) and desktop Safari — no nested workers, flaky module workers. */
export function isAppleWebKit(
  userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent,
  maxTouchPoints = typeof navigator === 'undefined' ? 0 : navigator.maxTouchPoints,
  platform = typeof navigator === 'undefined' ? '' : navigator.platform,
) {
  return isIosWebKit(userAgent, maxTouchPoints, platform)
    || isMacSafari(userAgent, maxTouchPoints, platform)
}

export function newBrowserId() {
  return globalThis.crypto?.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

/** iCloud / Files.app blobs can fail `arrayBuffer()` on iOS; FileReader still works. */
export async function readFileBuffer(file: Blob): Promise<ArrayBuffer> {
  try {
    const buffer = await file.arrayBuffer()
    if (buffer.byteLength > 0 || file.size === 0) return buffer
  } catch {
    // Fall through to FileReader.
  }
  return await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(reader.result)
        return
      }
      reject(new Error('Could not read the file.'))
    }
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file.'))
    reader.readAsArrayBuffer(file)
  })
}

export function createAudioContext(): AudioContext {
  const win = globalThis as typeof globalThis & {
    AudioContext?: typeof AudioContext
    webkitAudioContext?: typeof AudioContext
  }
  const Ctor = win.AudioContext ?? win.webkitAudioContext
  if (!Ctor) throw new Error('Web Audio is not available in this browser.')
  try {
    return new Ctor({ latencyHint: 'playback' })
  } catch {
    return new Ctor()
  }
}
