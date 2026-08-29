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

type NavigatorAudioSession = {
  type: string
}

/**
 * iOS 16.4+ WebKit: Web Audio is muted by the Ring/Silent switch unless the
 * page takes the "playback" audio session (same category as Music / Podcasts).
 */
export function armNavigatorAudioSession() {
  if (typeof navigator === 'undefined') return
  try {
    const session = (navigator as Navigator & { audioSession?: NavigatorAudioSession }).audioSession
    if (session && session.type !== 'playback') session.type = 'playback'
  } catch {
    // Older WebKit — HTMLAudio unlock is the fallback.
  }
}

/** iOS Safari/Chrome (WebKit) refuse HTMLMediaElement.play() without playsinline. */
export function armHtmlMediaElement(media: HTMLMediaElement) {
  media.setAttribute('playsinline', 'true')
  media.setAttribute('webkit-playsinline', 'true')
  media.setAttribute('x-webkit-airplay', 'deny')
  const video = media as HTMLMediaElement & {
    playsInline?: boolean
    disableRemotePlayback?: boolean
  }
  video.playsInline = true
  media.preload = 'auto'
  media.controls = false
  try {
    video.disableRemotePlayback = true
  } catch {
    // Attribute is optional.
  }
  try {
    if (typeof document === 'undefined' || media.isConnected) return
    media.setAttribute('aria-hidden', 'true')
    media.style.position = 'fixed'
    media.style.left = '0'
    media.style.bottom = '0'
    media.style.width = '1px'
    media.style.height = '1px'
    media.style.opacity = '0.01'
    media.style.pointerEvents = 'none'
    document.body?.appendChild(media)
  } catch {
    // Tests and documents without a body.
  }
}

/**
 * Safari detaches the ArrayBuffer passed to decodeAudioData. iOS IDB/File
 * blobs can also fail `arrayBuffer()` — FileReader still works.
 */
export async function decodeAudioDataSafe(
  ctx: AudioContext,
  source: ArrayBuffer | Blob,
): Promise<AudioBuffer> {
  const raw = source instanceof ArrayBuffer ? source : await readFileBuffer(source)
  const copy = raw.slice(0)
  const decode = ctx.decodeAudioData.bind(ctx) as (
    data: ArrayBuffer,
    success?: (buffer: AudioBuffer) => void,
    error?: (err?: unknown) => void,
  ) => Promise<AudioBuffer> | void

  return await new Promise<AudioBuffer>((resolve, reject) => {
    let settled = false
    const ok = (buffer: AudioBuffer) => {
      if (settled) return
      settled = true
      resolve(buffer)
    }
    const fail = (err?: unknown) => {
      if (settled) return
      settled = true
      reject(err instanceof Error ? err : new Error('Could not decode audio.'))
    }
    try {
      const result = decode(copy, ok, fail)
      if (result && typeof result.then === 'function') {
        void result.then(ok, fail)
      }
    } catch (err) {
      fail(err)
    }
  })
}
