import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { X } from 'lucide-react'
import {
  canOneClickInstall,
  dismissInstallHint,
  getInstallSurface,
  installCtaLabel,
  isStandaloneDisplay,
  promptPwaInstall,
  shouldShowInstallHint,
  subscribeInstallState,
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
      title: 'Keep HiggsRead on your Home Screen',
      body: 'Add the app icon so reading opens full-screen, like a native app.',
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

function guideFor(surface: InstallSurface): ReactNode {
  if (surface === 'ios') {
    return (
      <ol className="text-muted-foreground mt-2 space-y-1.5 text-[12.5px] leading-relaxed">
        <li>
          1. Tap{' '}
          <span className="text-foreground inline-flex translate-y-px items-center gap-1">
            <IosShareGlyph /> Share
          </span>
        </li>
        <li>
          2. Choose <span className="text-foreground">Add to Home Screen</span>
        </li>
        <li>
          3. Tap <span className="text-foreground">Add</span>
        </li>
      </ol>
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

export function PwaInstallBanner() {
  const { pathname } = useLocation()
  const [visible, setVisible] = useState(() => shouldShowInstallHint({ pathname }))
  const [surface, setSurface] = useState<InstallSurface>(() => getInstallSurface())
  const [oneClick, setOneClick] = useState(() => canOneClickInstall())
  const [busy, setBusy] = useState(false)
  const [showGuide, setShowGuide] = useState(false)

  useEffect(() => {
    const sync = () => {
      setSurface(getInstallSurface())
      setOneClick(canOneClickInstall())
      setVisible(shouldShowInstallHint({ pathname }))
    }
    sync()
    return subscribeInstallState(sync)
  }, [pathname])

  if (!visible || isStandaloneDisplay()) return null

  const copy = copyFor(surface)

  async function onInstall() {
    setBusy(true)
    try {
      const outcome = await promptPwaInstall()
      if (outcome === 'accepted') {
        setVisible(false)
        return
      }
      if (outcome === 'unavailable') setShowGuide(true)
      setVisible(shouldShowInstallHint({ pathname }))
    } finally {
      setBusy(false)
    }
  }

  function onDismiss() {
    dismissInstallHint()
    setVisible(false)
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
      <button
        type="button"
        onClick={() => void onInstall()}
        disabled={busy}
        className="mt-2.5 h-9 w-full rounded-lg bg-[#37352f] text-[13px] font-medium text-[#f7f7f5] transition-opacity hover:opacity-90 disabled:opacity-60"
      >
        {busy ? 'Opening…' : copy.action}
      </button>
    </div>
  )
}
