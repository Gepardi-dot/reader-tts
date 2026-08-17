import { describe, expect, it } from 'vitest'
import {
  PWA_INSTALL_AFTER_MS,
  addUsageMs,
  getInstallSurface,
  isAndroidDevice,
  isInstallDismissed,
  isIosDevice,
  isMacSafari,
  isStandaloneDisplay,
  isUsageEligible,
  shouldCountInstallUsage,
  shouldDeferSwReload,
  shouldShowInstallHint,
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
  it('waits for five minutes of use on every platform', () => {
    expect(
      shouldShowInstallHint({
        standalone: false,
        dismissed: false,
        usageEligible: false,
        pathname: '/library',
      }),
    ).toBe(false)
    expect(
      shouldShowInstallHint({
        standalone: false,
        dismissed: false,
        usageEligible: true,
        pathname: '/library',
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
})

describe('shouldDeferSwReload', () => {
  it('defers only while reading or practicing', () => {
    expect(shouldDeferSwReload('/book/abc')).toBe(true)
    expect(shouldDeferSwReload('/studio')).toBe(true)
    expect(shouldDeferSwReload('/library')).toBe(false)
    expect(shouldDeferSwReload('/login')).toBe(false)
  })
})
