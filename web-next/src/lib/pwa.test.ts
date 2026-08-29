import { describe, expect, it, vi } from 'vitest'
import {
  PWA_INSTALL_AFTER_MS,
  addUsageMs,
  canOneClickInstall,
  canShareIosHomeScreen,
  detectInstalledRelatedApp,
  getInstallSurface,
  installCtaLabel,
  iosSharePlacement,
  isAndroidDevice,
  isInstallDismissed,
  isIosChromeLike,
  isIosDevice,
  isMacSafari,
  isStandaloneDisplay,
  isUsageEligible,
  promptPwaInstall,
  shareIosAddToHomeScreen,
  setDeferredInstallPrompt,
  shouldCountInstallUsage,
  shouldDeferSwReload,
  shouldShowInstallHint,
  supportsInstallElement,
  supportsWebInstallApi,
  type BeforeInstallPromptEvent,
} from './pwa'

describe('isStandaloneDisplay', () => {
  it('detects iOS navigator.standalone', () => {
    const win = {
      navigator: { standalone: true },
      matchMedia: () => ({ matches: false }),
    } as unknown as Window
    expect(isStandaloneDisplay(win)).toBe(true)
  })

  it('detects display-mode media', () => {
    const win = {
      navigator: {},
      matchMedia: (query: string) => ({
        matches: query.includes('standalone'),
      }),
    } as unknown as Window
    expect(isStandaloneDisplay(win)).toBe(true)
  })
})

describe('isIosDevice', () => {
  it('matches iPhone and iPadOS-as-Mac', () => {
    expect(isIosDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)', 5, 'iPhone')).toBe(true)
    expect(isIosDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5, 'MacIntel')).toBe(true)
    expect(isIosDevice('Mozilla/5.0 (Windows NT 10.0)', 0, 'Win32')).toBe(false)
  })
})

describe('install hint', () => {
  it('waits for five minutes of use on non-iOS platforms', () => {
    expect(
      shouldShowInstallHint({
        standalone: false,
        dismissed: false,
        usageEligible: false,
        pathname: '/library',
        ios: false,
      }),
    ).toBe(false)
    expect(
      shouldShowInstallHint({
        standalone: false,
        dismissed: false,
        usageEligible: true,
        pathname: '/library',
        ios: false,
      }),
    ).toBe(true)
  })

  it('shows the iOS Share coach without a usage wait', () => {
    expect(
      shouldShowInstallHint({
        standalone: false,
        dismissed: false,
        usageEligible: false,
        pathname: '/library',
        ios: true,
      }),
    ).toBe(true)
  })

  it('hides in standalone, after dismiss, or on login', () => {
    expect(
      shouldShowInstallHint({
        standalone: true,
        dismissed: false,
        usageEligible: true,
        pathname: '/library',
        ios: true,
      }),
    ).toBe(false)
    expect(
      shouldShowInstallHint({
        standalone: false,
        dismissed: true,
        usageEligible: true,
        pathname: '/library',
      }),
    ).toBe(false)
    expect(
      shouldShowInstallHint({
        standalone: false,
        dismissed: false,
        usageEligible: true,
        pathname: '/login',
      }),
    ).toBe(false)
  })

  it('treats a fresh dismiss as dismissed', () => {
    expect(isInstallDismissed(1_000, '500')).toBe(true)
    expect(isInstallDismissed(1_000 + 15 * 24 * 60 * 60 * 1000, '1000')).toBe(false)
  })
})

describe('install usage', () => {
  it('does not count the login screen', () => {
    expect(shouldCountInstallUsage('/login')).toBe(false)
    expect(shouldCountInstallUsage('/library')).toBe(true)
    expect(shouldCountInstallUsage('/book/1')).toBe(true)
  })

  it('becomes eligible at five minutes', () => {
    expect(isUsageEligible(0)).toBe(false)
    expect(isUsageEligible(PWA_INSTALL_AFTER_MS - 1)).toBe(false)
    expect(isUsageEligible(PWA_INSTALL_AFTER_MS)).toBe(true)
  })

  it('ignores empty usage deltas', () => {
    expect(addUsageMs(0)).toBe(false)
    expect(addUsageMs(-10)).toBe(false)
  })
})

describe('install surface', () => {
  it('picks iOS, Android, Mac Safari, or a native prompt', () => {
    expect(isAndroidDevice('Mozilla/5.0 (Linux; Android 14)')).toBe(true)
    expect(
      isMacSafari('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Safari/17.0', 0, 'MacIntel'),
    ).toBe(true)
    expect(
      isMacSafari('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Chrome/120', 0, 'MacIntel'),
    ).toBe(false)
    expect(getInstallSurface({ ios: true, canPrompt: true })).toBe('ios')
    expect(getInstallSurface({ ios: false, android: true, canPrompt: true })).toBe('prompt')
    expect(getInstallSurface({ ios: false, android: true, canPrompt: false })).toBe('android-menu')
    expect(
      getInstallSurface({ ios: false, android: false, macSafari: true, canPrompt: false }),
    ).toBe('mac-dock')
    expect(
      getInstallSurface({ ios: false, android: false, macSafari: false, canPrompt: false }),
    ).toBe('desktop-menu')
  })

  it('always offers an install button label', () => {
    expect(installCtaLabel('prompt')).toBe('Install as app')
    expect(installCtaLabel('desktop-menu')).toBe('Install as app')
    expect(installCtaLabel('android-menu')).toBe('Install as app')
    expect(installCtaLabel('ios')).toBe('Open Share menu')
    expect(installCtaLabel('mac-dock')).toBe('Install as app')
  })

  it('puts Chrome-like iOS Share in the top bar and Safari at the bottom', () => {
    const chromeUa = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) CriOS/120.0.0.0'
    const safariUa = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15 Version/17.0'
    expect(isIosChromeLike(chromeUa, 5, 'iPhone')).toBe(true)
    expect(isIosChromeLike(safariUa, 5, 'iPhone')).toBe(false)
    expect(iosSharePlacement(chromeUa, 5, 'iPhone')).toBe('top')
    expect(iosSharePlacement(safariUa, 5, 'iPhone')).toBe('bottom')
  })

  it('detects the Web Share API used to open the iOS sheet', () => {
    expect(canShareIosHomeScreen({ share: async () => undefined })).toBe(true)
    expect(canShareIosHomeScreen({})).toBe(false)
  })

  it('does not claim a one-click prompt without a captured event', () => {
    expect(canOneClickInstall()).toBe(false)
  })

  it('detects navigator.install and the HTML install element', () => {
    expect(supportsWebInstallApi({ install: async () => undefined })).toBe(true)
    expect(supportsWebInstallApi({})).toBe(false)
    expect(supportsInstallElement(undefined)).toBe(false)
  })
})

describe('shareIosAddToHomeScreen', () => {
  it('opens the system share sheet', async () => {
    const share = vi.fn(async () => undefined)
    expect(await shareIosAddToHomeScreen({ share })).toBe('shared')
    expect(share).toHaveBeenCalled()
  })

  it('treats a user cancel as aborted', async () => {
    expect(await shareIosAddToHomeScreen({
      share: async () => {
        throw new DOMException('The user aborted a request.', 'AbortError')
      },
    })).toBe('aborted')
  })
})

describe('promptPwaInstall', () => {
  it('calls prompt() on the captured event without dropping it first', async () => {
    const calls: string[] = []
    const event = {
      prompt: async () => {
        calls.push('prompt')
      },
      userChoice: Promise.resolve({ outcome: 'accepted' as const }),
    } as BeforeInstallPromptEvent
    setDeferredInstallPrompt(event)
    const outcome = await promptPwaInstall()
    expect(calls).toEqual(['prompt'])
    expect(outcome).toBe('accepted')
  })

  it('returns unavailable when Chromium has no install API', async () => {
    setDeferredInstallPrompt(null)
    expect(await promptPwaInstall()).toBe('unavailable')
  })
})

describe('detectInstalledRelatedApp', () => {
  it('is false without the related-apps API', async () => {
    expect(await detectInstalledRelatedApp({} as Navigator)).toBe(false)
  })

  it('is true when Chrome reports this web app as installed', async () => {
    const nav = {
      getInstalledRelatedApps: async () => [{ platform: 'webapp', url: '/manifest.webmanifest' }],
    } as unknown as Navigator
    expect(await detectInstalledRelatedApp(nav)).toBe(true)
  })
})

describe('shouldDeferSwReload', () => {
  it('defers only while reading or practicing', () => {
    expect(shouldDeferSwReload('/book/abc')).toBe(true)
    expect(shouldDeferSwReload('/studio')).toBe(true)
    expect(shouldDeferSwReload('/library')).toBe(false)
    expect(shouldDeferSwReload('/login')).toBe(false)
  })
})
