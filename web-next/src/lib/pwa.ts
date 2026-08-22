/**
 * Installable PWA helpers.
 *
 * The service worker stays models/covers-only. This module never caches
 * the app shell — it only detects display-mode, install eligibility,
 * and when a worker update should wait until the reader is idle.
 */

import { isIosWebKit as isIosDevice, isMacSafari } from './browser'

export const PWA_INSTALL_DISMISS_KEY = 'higgsread-pwa-install-dismissed'
export const PWA_INSTALL_DISMISS_MS = 14 * 24 * 60 * 60 * 1000
export const PWA_USAGE_MS_KEY = 'higgsread-pwa-usage-ms'
export const PWA_INSTALL_AFTER_MS = 5 * 60 * 1000

export type InstallSurface = 'prompt' | 'ios' | 'android-menu' | 'mac-dock' | 'desktop-menu'

export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export interface HiggsPwaCapture {
  promptEvent: BeforeInstallPromptEvent | null
}

declare global {
  interface Window {
    __higgsPwa?: HiggsPwaCapture
  }
  interface Navigator {
    install?: (installUrl?: string, manifestId?: string) => Promise<void>
  }
}

const updateListeners = new Set<(available: boolean) => void>()
const installListeners = new Set<() => void>()

let deferredPrompt: BeforeInstallPromptEvent | null = null
let swUpdateAvailable = false

export function isStandaloneDisplay(win: Window = window): boolean {
  const nav = win.navigator as Navigator & { standalone?: boolean }
  if (nav.standalone === true) return true
  if (typeof win.matchMedia !== 'function') return false
  return (
    win.matchMedia('(display-mode: standalone)').matches ||
    win.matchMedia('(display-mode: window-controls-overlay)').matches ||
    win.matchMedia('(display-mode: minimal-ui)').matches
  )
}

export { isIosDevice, isMacSafari }

export function isAndroidDevice(
  userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent,
): boolean {
  return /android/i.test(userAgent)
}

export function adoptCapturedInstallPrompt(): BeforeInstallPromptEvent | null {
  if (typeof window === 'undefined') return deferredPrompt
  const captured = window.__higgsPwa?.promptEvent
  if (captured && captured !== deferredPrompt) {
    deferredPrompt = captured
  }
  return deferredPrompt
}

export function supportsWebInstallApi(
  nav: { install?: Navigator['install'] } | null | undefined = typeof navigator === 'undefined'
    ? undefined
    : navigator,
): boolean {
  return typeof nav?.install === 'function'
}

export function supportsInstallElement(
  win: Window | undefined = typeof window === 'undefined' ? undefined : window,
): boolean {
  return Boolean(win && 'HTMLInstallElement' in win)
}

export function canOneClickInstall(): boolean {
  if (adoptCapturedInstallPrompt()) return true
  if (supportsWebInstallApi()) return true
  return supportsInstallElement()
}

export function getInstallSurface(options?: {
  ios?: boolean
  android?: boolean
  macSafari?: boolean
  canPrompt?: boolean
}): InstallSurface {
  if (options?.ios ?? isIosDevice()) return 'ios'
  if (options?.canPrompt ?? canOneClickInstall()) return 'prompt'
  if (options?.android ?? isAndroidDevice()) return 'android-menu'
  if (options?.macSafari ?? isMacSafari()) return 'mac-dock'
  return 'desktop-menu'
}

function attachInstallCapture() {
  if (typeof window === 'undefined') return
  window.__higgsPwa = window.__higgsPwa ?? { promptEvent: null }
  adoptCapturedInstallPrompt()
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault()
    const promptEvent = event as BeforeInstallPromptEvent
    window.__higgsPwa = window.__higgsPwa ?? { promptEvent: null }
    window.__higgsPwa.promptEvent = promptEvent
    setDeferredInstallPrompt(promptEvent)
  })
  window.addEventListener('appinstalled', () => {
    if (window.__higgsPwa) window.__higgsPwa.promptEvent = null
    markAppInstalled()
  })
}

if (typeof window !== 'undefined') {
  attachInstallCapture()
}

export function shouldCountInstallUsage(pathname: string): boolean {
  return pathname !== '/login' && !pathname.startsWith('/login?')
}

export function readUsageMs(
  raw: string | null = typeof window === 'undefined'
    ? null
    : window.localStorage.getItem(PWA_USAGE_MS_KEY),
): number {
  const ms = Number(raw)
  if (!Number.isFinite(ms) || ms < 0) return 0
  return ms
}

export function isUsageEligible(ms = readUsageMs()): boolean {
  return ms >= PWA_INSTALL_AFTER_MS
}

export function addUsageMs(deltaMs: number): boolean {
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) return isUsageEligible()
  const next = Math.min(readUsageMs() + deltaMs, PWA_INSTALL_AFTER_MS)
  const wasEligible = isUsageEligible()
  try {
    window.localStorage.setItem(PWA_USAGE_MS_KEY, String(next))
  } catch {
    /* private mode */
  }
  const eligible = next >= PWA_INSTALL_AFTER_MS
  if (eligible && !wasEligible) emitInstallChange()
  return eligible
}

/** Visible time in the app (not login). Pauses when the tab is hidden. */
export function startInstallUsageTracking(getPathname: () => string): () => void {
  if (typeof window === 'undefined') return () => {}
  if (isStandaloneDisplay() || isInstallDismissed() || isUsageEligible()) {
    if (isUsageEligible()) emitInstallChange()
    return () => {}
  }

  let last = Date.now()
  let timer: ReturnType<typeof setInterval> | null = null

  const tick = () => {
    const now = Date.now()
    const delta = Math.max(0, Math.min(now - last, 2000))
    last = now
    if (document.visibilityState !== 'visible') return
    if (!shouldCountInstallUsage(getPathname())) return
    if (isStandaloneDisplay() || isInstallDismissed()) return
    if (addUsageMs(delta) && timer) {
      clearInterval(timer)
      timer = null
    }
  }

  const start = () => {
    last = Date.now()
    if (timer == null) timer = setInterval(tick, 1000)
  }
  const stop = () => {
    if (timer == null) return
    clearInterval(timer)
    timer = null
  }

  const onVisibility = () => {
    if (document.visibilityState === 'visible') start()
    else {
      tick()
      stop()
    }
  }

  document.addEventListener('visibilitychange', onVisibility)
  if (document.visibilityState === 'visible') start()

  return () => {
    document.removeEventListener('visibilitychange', onVisibility)
    stop()
  }
}

export function isInstallDismissed(
  now = Date.now(),
  raw: string | null = typeof window === 'undefined'
    ? null
    : window.localStorage.getItem(PWA_INSTALL_DISMISS_KEY),
): boolean {
  if (!raw) return false
  const ts = Number(raw)
  if (!Number.isFinite(ts) || ts <= 0) return false
  return now - ts < PWA_INSTALL_DISMISS_MS
}

export function dismissInstallHint(now = Date.now()): void {
  try {
    window.localStorage.setItem(PWA_INSTALL_DISMISS_KEY, String(now))
  } catch {
    /* private mode */
  }
  emitInstallChange()
}

export function clearInstallDismiss(): void {
  try {
    window.localStorage.removeItem(PWA_INSTALL_DISMISS_KEY)
  } catch {
    /* ignore */
  }
  emitInstallChange()
}

export function shouldShowInstallHint(options?: {
  standalone?: boolean
  dismissed?: boolean
  usageEligible?: boolean
  pathname?: string
}): boolean {
  const standalone = options?.standalone ?? isStandaloneDisplay()
  const dismissed = options?.dismissed ?? isInstallDismissed()
  const usageEligible = options?.usageEligible ?? isUsageEligible()
  const pathname =
    options?.pathname ?? (typeof window === 'undefined' ? '' : window.location.pathname)
  if (standalone || dismissed || !usageEligible) return false
  return shouldCountInstallUsage(pathname)
}

export function shouldDeferSwReload(pathname: string): boolean {
  return pathname.startsWith('/book/') || pathname === '/studio' || pathname.startsWith('/studio/')
}

export function applyDisplayModeClass(el: HTMLElement = document.documentElement): void {
  const standalone = isStandaloneDisplay()
  el.dataset.displayMode = standalone ? 'standalone' : 'browser'
  el.classList.toggle('pwa-standalone', standalone)
}

export function setDeferredInstallPrompt(event: BeforeInstallPromptEvent | null): void {
  deferredPrompt = event
  emitInstallChange()
}

export function getDeferredInstallPrompt(): BeforeInstallPromptEvent | null {
  return adoptCapturedInstallPrompt()
}

export function installCtaLabel(_surface?: InstallSurface): string {
  return 'Install as app'
}

export async function promptPwaInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const event = adoptCapturedInstallPrompt()
  if (event) {
    try {
      // Keep the event until Chrome accepts the prompt. Clearing it first made
      // retries impossible, and emitInstallChange() re-rendered the banner
      // before prompt() ran on a user gesture.
      await event.prompt()
      const choice = await event.userChoice
      if (choice.outcome === 'accepted') {
        markAppInstalled()
      } else {
        deferredPrompt = null
        if (typeof window !== 'undefined' && window.__higgsPwa) {
          window.__higgsPwa.promptEvent = null
        }
        emitInstallChange()
      }
      return choice.outcome
    } catch {
      // Event is stale (already used, or the tab sat too long). Do not call
      // navigator.install() here — the user gesture is gone after this await.
    }
  } else {
    const installFn = typeof navigator === 'undefined' ? undefined : navigator.install
    if (typeof installFn === 'function') {
      try {
        await installFn.call(navigator)
        markAppInstalled()
        return 'accepted'
      } catch {
        return 'dismissed'
      }
    }
  }

  return 'unavailable'
}

export async function detectInstalledRelatedApp(
  nav: Navigator | undefined = typeof navigator === 'undefined' ? undefined : navigator,
): Promise<boolean> {
  try {
    const related = nav as
      | (Navigator & {
          getInstalledRelatedApps?: () => Promise<Array<{ platform?: string; url?: string }>>
        })
      | undefined
    if (typeof related?.getInstalledRelatedApps !== 'function') return false
    const apps = await related.getInstalledRelatedApps()
    return Array.isArray(apps) && apps.length > 0
  } catch {
    return false
  }
}

export function markAppInstalled(): void {
  deferredPrompt = null
  if (typeof window !== 'undefined' && window.__higgsPwa) {
    window.__higgsPwa.promptEvent = null
  }
  dismissInstallHint()
  void requestPersistentStorage()
}

export function subscribeInstallState(listener: () => void): () => void {
  installListeners.add(listener)
  return () => {
    installListeners.delete(listener)
  }
}

function emitInstallChange() {
  for (const listener of installListeners) listener()
}

export function setSwUpdateAvailable(available: boolean): void {
  if (swUpdateAvailable === available) return
  swUpdateAvailable = available
  for (const listener of updateListeners) listener(available)
}

export function getSwUpdateAvailable(): boolean {
  return swUpdateAvailable
}

export function subscribeSwUpdate(listener: (available: boolean) => void): () => void {
  updateListeners.add(listener)
  listener(swUpdateAvailable)
  return () => {
    updateListeners.delete(listener)
  }
}

export function reloadForSwUpdate(): void {
  window.location.reload()
}

export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (!('storage' in navigator) || !navigator.storage?.persist) return false
    return await navigator.storage.persist()
  } catch {
    return false
  }
}
