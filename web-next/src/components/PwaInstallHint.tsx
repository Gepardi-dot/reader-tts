import {
  createElement,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { useLocation } from 'react-router-dom'
import { X } from 'lucide-react'
import {
  canOneClickInstall,
  canShareIosHomeScreen,
  detectInstalledRelatedApp,
  dismissInstallHint,
  getDeferredInstallPrompt,
  getInstallSurface,
  installCtaLabel,
  iosSharePlacement,
  isStandaloneDisplay,
  markAppInstalled,
  promptPwaInstall,
  shareIosAddToHomeScreen,
  shouldShowInstallHint,
  subscribeInstallState,
  supportsInstallElement,
  type InstallSurface,
} from '@/lib/pwa'

const PLATE: CSSProperties = {
  backgroundColor: '#EEECE6',
  border: '1px solid rgba(120, 116, 108, 0.42)',
  boxShadow:
    '0 8px 24px rgba(55, 53, 47, 0.12), inset 0 1px 0 rgba(255, 255, 255, 0.72), inset 0 -1px 0 rgba(55, 53, 47, 0.06)',
}

function IosShareGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} width="14" height="18" viewBox="0 0 14 18" fill="none" aria-hidden>
      <path d="M7 1.25v9.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path
        d="M3.4 4.4 7 1.25l3.6 3.15"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M2.1 7.6H1.15v9.1h11.7V7.6H11.9"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function copyFor(surface: InstallSurface): {
  title: string
  body: ReactNode
  action: string
} {
  if (surface === 'ios') {
    return {
      title: 'Read without the browser bars',
      body: 'Add HiggsRead to your Home Screen. It opens full-screen, like a book app.',
      action: installCtaLabel(surface),
    }
  }
  if (surface === 'android-menu') {
    return {
      title: 'Install HiggsRead',
      body: 'Install for a Home Screen icon and a full-screen reader.',
      action: installCtaLabel(surface),
    }
  }
  if (surface === 'mac-dock') {
    return {
      title: 'Keep HiggsRead in your Dock',
      body: 'Add it next to your other apps for one-click reading.',
      action: installCtaLabel(surface),
    }
  }
  if (surface === 'desktop-menu') {
    return {
      title: 'Install HiggsRead',
      body: 'Install for a desktop app window and a faster launch.',
      action: installCtaLabel(surface),
    }
  }
  return {
    title: 'Keep HiggsRead at hand',
    body: 'Install for a full-screen reader and an icon on this device.',
    action: installCtaLabel(surface),
  }
}

function IosAddToHomeRow() {
  return (
    <div
      className="mt-3 flex items-center gap-3 rounded-[12px] px-3 py-2.5"
      style={{
        backgroundColor: 'rgba(255,255,255,0.72)',
        border: '1px solid rgba(55, 53, 47, 0.10)',
      }}
    >
      <span
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] text-[18px] font-semibold leading-none"
        style={{ backgroundColor: '#2383e2', color: '#fff' }}
        aria-hidden
      >
        +
      </span>
      <span className="text-foreground min-w-0 flex-1 text-[14px] font-medium">
        Add to Home Screen
      </span>
    </div>
  )
}

function guideFor(surface: InstallSurface): ReactNode {
  if (surface === 'ios') {
    const shareAtTop = iosSharePlacement() === 'top'
    return (
      <div className="mt-3">
        <ol className="text-muted-foreground space-y-2 text-[13px] leading-relaxed">
          <li>
            1. Tap{' '}
            <span className="text-foreground inline-flex translate-y-px items-center gap-1 font-medium">
              <IosShareGlyph /> Share
            </span>
            {shareAtTop ? ' at the top right of the address bar.' : ' in the bar at the bottom of Safari.'}
          </li>
          <li>2. Scroll to this row and tap it:</li>
        </ol>
        <IosAddToHomeRow />
        <p className="text-muted-foreground mt-2.5 text-[13px] leading-relaxed">
          3. Tap <span className="text-foreground font-medium">Add</span>.
        </p>
      </div>
    )
  }
  if (surface === 'android-menu') {
    return (
      <ol className="text-muted-foreground mt-2 space-y-1.5 text-[12.5px] leading-relaxed">
        <li>1. Tap the browser menu (⋮)</li>
        <li>
          2. Tap <span className="text-foreground">Install app</span> or{' '}
          <span className="text-foreground">Add to Home screen</span>
        </li>
      </ol>
    )
  }
  if (surface === 'mac-dock') {
    return (
      <ol className="text-muted-foreground mt-2 space-y-1.5 text-[12.5px] leading-relaxed">
        <li>
          1. Choose <span className="text-foreground">File → Add to Dock</span>
        </li>
        <li>2. Or Share → Add to Dock</li>
      </ol>
    )
  }
  return (
    <ol className="text-muted-foreground mt-2 space-y-1.5 text-[12.5px] leading-relaxed">
      <li>1. Click the install icon in the address bar</li>
      <li>
        2. Or open the browser menu → <span className="text-foreground">Install HiggsRead</span>
      </li>
    </ol>
  )
}

function ChromiumInstallElement({
  onAccepted,
  onDismissed,
}: {
  onAccepted: () => void
  onDismissed: () => void
}) {
  const ref = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const accepted = () => onAccepted()
    const dismissed = () => onDismissed()
    el.addEventListener('promptaction', accepted)
    el.addEventListener('promptdismiss', dismissed)
    return () => {
      el.removeEventListener('promptaction', accepted)
      el.removeEventListener('promptdismiss', dismissed)
    }
  }, [onAccepted, onDismissed])
  return createElement('install', {
    ref,
    className: 'mt-2.5 block h-9 w-full',
    style: { width: '100%' },
  })
}

function IosHomeScreenCoach({
  title,
  body,
  action,
  onDismiss,
}: {
  title: string
  body: ReactNode
  action: string
  onDismiss: () => void
}) {
  const [shareFailed, setShareFailed] = useState(false)
  const shareAtTop = iosSharePlacement() === 'top'
  const canShare = canShareIosHomeScreen()

  async function onShare() {
    const result = await shareIosAddToHomeScreen()
    if (result === 'unavailable') setShareFailed(true)
  }

  const card = (
    <div
      role="dialog"
      aria-label={title}
      className="w-full max-w-md rounded-[18px] px-4 py-3.5"
      style={PLATE}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-foreground text-[16px] font-medium tracking-tight">{title}</p>
          <p className="text-muted-foreground mt-1 text-[13.5px] leading-relaxed">{body}</p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="text-muted-foreground hover:text-foreground rounded-md p-1 hover:bg-black/5"
          aria-label="Dismiss Home Screen guide"
        >
          <X size={16} />
        </button>
      </div>
      {guideFor('ios')}
      {canShare && !shareFailed ? (
        <button
          type="button"
          onClick={() => void onShare()}
          className="mt-3.5 flex h-11 w-full items-center justify-center gap-2 rounded-[12px] bg-[#37352f] text-[14px] font-medium text-[#f7f7f5] transition-opacity hover:opacity-90"
        >
          <IosShareGlyph className="opacity-90" />
          {action}
        </button>
      ) : (
        <p className="text-muted-foreground mt-3 text-[12.5px] leading-relaxed">
          {shareAtTop
            ? 'Use Share at the top right, then Add to Home Screen.'
            : 'Use Share in the Safari bar at the bottom, then Add to Home Screen.'}
        </p>
      )}
      <button
        type="button"
        onClick={onDismiss}
        className="text-muted-foreground mt-2 h-9 w-full text-[13px] hover:text-foreground"
      >
        Not now
      </button>
    </div>
  )

  if (typeof document === 'undefined') return card
  return createPortal(
    <div
      className="pointer-events-none fixed inset-0 z-[90] flex items-center justify-center px-3"
    >
      <div className="pointer-events-auto w-full max-w-md">{card}</div>
    </div>,
    document.body,
  )
}

export function PwaInstallBanner() {
  const { pathname } = useLocation()
  const [visible, setVisible] = useState(() => shouldShowInstallHint({ pathname }))
  const [surface, setSurface] = useState<InstallSurface>(() => getInstallSurface())
  const [oneClick, setOneClick] = useState(() => canOneClickInstall())
  const [showGuide, setShowGuide] = useState(false)
  const [nativeInstall, setNativeInstall] = useState(
    () => supportsInstallElement() && !getDeferredInstallPrompt(),
  )

  useEffect(() => {
    const sync = () => {
      setSurface(getInstallSurface())
      setOneClick(canOneClickInstall())
      setNativeInstall(supportsInstallElement() && !getDeferredInstallPrompt())
      setVisible(shouldShowInstallHint({ pathname }))
    }
    sync()
    const unsubscribe = subscribeInstallState(sync)
    void detectInstalledRelatedApp().then((installed) => {
      if (!installed) return
      markAppInstalled()
      setVisible(false)
    })
    return unsubscribe
  }, [pathname])

  if (!visible || isStandaloneDisplay()) return null

  const copy = copyFor(surface)

  async function onInstall() {
    // prompt() / navigator.install() must run in this click turn. Don't await
    // anything else first or Chromium drops the user gesture on Win/macOS.
    const outcome = await promptPwaInstall()
    if (outcome === 'accepted') {
      setVisible(false)
      return
    }
    if (outcome === 'unavailable') setShowGuide(true)
    setVisible(shouldShowInstallHint({ pathname }))
  }

  function onDismiss() {
    dismissInstallHint()
    setVisible(false)
  }

  if (surface === 'ios') {
    return (
      <IosHomeScreenCoach
        title={copy.title}
        body={copy.body}
        action={copy.action}
        onDismiss={onDismiss}
      />
    )
  }

  return (
    <div role="dialog" aria-label={copy.title} className="rounded-xl px-3.5 py-3" style={PLATE}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-foreground text-[13.5px] font-medium tracking-tight">{copy.title}</p>
          <p className="text-muted-foreground mt-1 text-[12.5px] leading-relaxed">{copy.body}</p>
          {(!oneClick || showGuide) && guideFor(surface)}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="text-muted-foreground hover:text-foreground rounded-md p-1 hover:bg-black/5"
          aria-label="Dismiss install banner"
        >
          <X size={15} />
        </button>
      </div>
      {nativeInstall ? (
        <ChromiumInstallElement
          onAccepted={() => {
            markAppInstalled()
            setVisible(false)
          }}
          onDismissed={() => setShowGuide(true)}
        />
      ) : (
        <button
          type="button"
          onClick={() => void onInstall()}
          className="mt-2.5 h-9 w-full rounded-lg bg-[#37352f] text-[13px] font-medium text-[#f7f7f5] transition-opacity hover:opacity-90"
        >
          {copy.action}
        </button>
      )}
    </div>
  )
}
