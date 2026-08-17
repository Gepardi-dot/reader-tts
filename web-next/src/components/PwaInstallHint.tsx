import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { X } from 'lucide-react'
import {
  dismissInstallHint,
  getInstallSurface,
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
  action: string | null
} {
  if (surface === 'ios') {
    return {
      title: 'Keep HiggsRead on your Home Screen',
      body: (
        <>
          Tap{' '}
          <span className="text-foreground inline-flex translate-y-px items-center">
            <IosShareGlyph />
          </span>{' '}
          Share, then <span className="text-foreground">Add to Home Screen</span>.
        </>
      ),
      action: null,
    }
  }
  if (surface === 'android-menu') {
    return {
      title: 'Install HiggsRead',
      body: (
        <>
          Open the browser menu and tap <span className="text-foreground">Install app</span> or{' '}
          <span className="text-foreground">Add to Home screen</span>.
        </>
      ),
      action: null,
    }
  }
  if (surface === 'mac-dock') {
    return {
      title: 'Keep HiggsRead in your Dock',
      body: (
        <>
          Choose <span className="text-foreground">File → Add to Dock</span>, or Share → Add to
          Dock.
        </>
      ),
      action: null,
    }
  }
  if (surface === 'desktop-menu') {
    return {
      title: 'Install HiggsRead',
      body: (
        <>
          Use the install icon in the address bar, or your browser menu →{' '}
          <span className="text-foreground">Install HiggsRead</span>.
        </>
      ),
      action: null,
    }
  }
  return {
    title: 'Keep HiggsRead at hand',
    body: 'Install for a full-screen reader and a Home Screen icon on this device.',
    action: 'Install HiggsRead',
  }
}

export function PwaInstallBanner() {
  const { pathname } = useLocation()
  const [visible, setVisible] = useState(() => shouldShowInstallHint({ pathname }))
  const [surface, setSurface] = useState<InstallSurface>(() => getInstallSurface())

  useEffect(() => {
    const sync = () => {
      setSurface(getInstallSurface())
      setVisible(shouldShowInstallHint({ pathname }))
    }
    sync()
    return subscribeInstallState(sync)
  }, [pathname])

  if (!visible || isStandaloneDisplay()) return null

  const copy = copyFor(surface)

  async function onInstall() {
    const outcome = await promptPwaInstall()
    if (outcome !== 'accepted') setVisible(shouldShowInstallHint({ pathname }))
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
      {copy.action && (
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
