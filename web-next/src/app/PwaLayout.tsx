import { useEffect, useState } from 'react'
import { Outlet, useNavigate } from 'react-router-dom'
import { PwaInstallBanner } from '@/components/PwaInstallHint'
import {
  applyDisplayModeClass,
  markAppInstalled,
  reloadForSwUpdate,
  setDeferredInstallPrompt,
  startInstallUsageTracking,
  subscribeSwUpdate,
  type BeforeInstallPromptEvent,
} from '@/lib/pwa'
import { subscribeLaunchArrival } from '@/lib/pwaLaunch'

export function PwaLayout() {
  const navigate = useNavigate()
  const [offline, setOffline] = useState(() =>
    typeof navigator === 'undefined' ? false : !navigator.onLine,
  )
  const [updateAvailable, setUpdateAvailable] = useState(false)

  useEffect(() => {
    applyDisplayModeClass()
    const onDisplay = () => applyDisplayModeClass()
    const standalone = window.matchMedia('(display-mode: standalone)')
    standalone.addEventListener('change', onDisplay)

    const onPrompt = (event: Event) => {
      event.preventDefault()
      setDeferredInstallPrompt(event as BeforeInstallPromptEvent)
    }
    const onInstalled = () => markAppInstalled()
    window.addEventListener('beforeinstallprompt', onPrompt)
    window.addEventListener('appinstalled', onInstalled)

    return () => {
      standalone.removeEventListener('change', onDisplay)
      window.removeEventListener('beforeinstallprompt', onPrompt)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  useEffect(() => {
    const goOffline = () => setOffline(true)
    const goOnline = () => setOffline(false)
    window.addEventListener('offline', goOffline)
    window.addEventListener('online', goOnline)
    return () => {
      window.removeEventListener('offline', goOffline)
      window.removeEventListener('online', goOnline)
    }
  }, [])

  useEffect(() => subscribeSwUpdate(setUpdateAvailable), [])

  useEffect(() => startInstallUsageTracking(() => window.location.pathname), [])

  useEffect(() => {
    return subscribeLaunchArrival(() => {
      if (!window.location.pathname.startsWith('/upload')) {
        navigate('/upload')
      }
    })
  }, [navigate])

  return (
    <>
      <Outlet />
      <PwaToasts offline={offline} updateAvailable={updateAvailable} />
    </>
  )
}

function PwaToasts({ offline, updateAvailable }: { offline: boolean; updateAvailable: boolean }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[calc(4.75rem+env(safe-area-inset-bottom,0px))] z-[80] flex justify-center px-4 md:bottom-6">
      <div className="pointer-events-auto flex w-full max-w-md flex-col gap-2 md:bottom-auto">
        <PwaInstallBanner />
        {offline && (
          <div
            role="status"
            className="text-foreground rounded-xl px-3.5 py-2.5 text-[13px]"
            style={{
              backgroundColor: '#EEECE6',
              border: '1px solid rgba(120, 116, 108, 0.42)',
              boxShadow: '0 8px 24px rgba(55, 53, 47, 0.12)',
            }}
          >
            You're offline. Saved audio and this session stay available; sync waits for a
            connection.
          </div>
        )}
        {updateAvailable && (
          <div
            className="text-foreground flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-[13px]"
            style={{
              backgroundColor: '#37352f',
              color: '#f7f7f5',
              boxShadow: '0 8px 24px rgba(55, 53, 47, 0.18)',
            }}
          >
            <p className="min-w-0 flex-1">A new HiggsRead is ready.</p>
            <button
              type="button"
              onClick={() => reloadForSwUpdate()}
              className="shrink-0 rounded-md bg-[#f7f7f5] px-2.5 py-1 text-[12px] font-medium text-[#37352f]"
            >
              Refresh
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
