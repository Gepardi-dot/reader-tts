/* eslint-disable react-refresh/only-export-components */
import { Component, StrictMode, type ErrorInfo, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'

const rootElement = document.getElementById('root')

if (!rootElement) {
  throw new Error('Storybook Reader could not find its root element.')
}

const root = createRoot(rootElement)
const STARTUP_RECOVERY_FLAG = 'storybook-startup-recovery-v1'

async function clearRecoverableBrowserState() {
  const cleanupTasks: Promise<unknown>[] = []

  if ('serviceWorker' in navigator) {
    cleanupTasks.push(
      navigator.serviceWorker
        .getRegistrations()
        .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister()))),
    )
  }

  if ('caches' in window) {
    cleanupTasks.push(caches.keys().then((keys) => Promise.all(keys.map((key) => caches.delete(key)))))
  }

  try {
    window.localStorage.clear()
  } catch {
    // Ignore storage cleanup failures and continue with the reload path.
  }

  try {
    window.sessionStorage.clear()
  } catch {
    // Ignore storage cleanup failures and continue with the reload path.
  }

  await Promise.allSettled(cleanupTasks)
}

function formatBootstrapError(error: unknown) {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim()
  }
  return 'The app failed to start in this browser session.'
}

type StartupFallbackProps = {
  error: unknown
}

function StartupFallback({ error }: StartupFallbackProps) {
  const detail = formatBootstrapError(error)

  const handleReload = () => {
    window.location.reload()
  }

  const handleReset = async () => {
    try {
      window.sessionStorage.setItem(STARTUP_RECOVERY_FLAG, '1')
    } catch {
      // Ignore sessionStorage failures and continue with the reset.
    }

    await clearRecoverableBrowserState()
    window.location.reload()
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        padding: '24px',
        background:
          'radial-gradient(circle at top, rgba(225, 214, 178, 0.26), transparent 48%), #f6f1e3',
        color: '#152129',
      }}
    >
      <div
        style={{
          width: 'min(100%, 560px)',
          borderRadius: '28px',
          border: '1px solid rgba(24, 32, 36, 0.08)',
          background: 'rgba(255, 251, 242, 0.94)',
          boxShadow: '0 28px 60px rgba(34, 45, 49, 0.12)',
          padding: '32px',
        }}
      >
        <p
          style={{
            margin: 0,
            fontSize: '0.76rem',
            letterSpacing: '0.32em',
            textTransform: 'uppercase',
            color: 'rgba(21, 33, 41, 0.64)',
          }}
        >
          Startup recovery
        </p>
        <h1
          style={{
            margin: '14px 0 10px',
            fontSize: 'clamp(2rem, 6vw, 3rem)',
            lineHeight: 1,
            fontWeight: 600,
          }}
        >
          Storybook Reader hit a stale browser state.
        </h1>
        <p
          style={{
            margin: 0,
            fontSize: '1rem',
            lineHeight: 1.6,
            color: 'rgba(21, 33, 41, 0.72)',
          }}
        >
          The deployment is live, but this tab could not finish booting. Reload once, or reset cached app data
          for this origin and try again.
        </p>
        <pre
          style={{
            margin: '18px 0 0',
            padding: '14px 16px',
            borderRadius: '18px',
            background: 'rgba(21, 33, 41, 0.05)',
            color: 'rgba(21, 33, 41, 0.74)',
            fontSize: '0.85rem',
            lineHeight: 1.55,
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
          }}
        >
          {detail}
        </pre>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '12px',
            marginTop: '20px',
          }}
        >
          <button
            onClick={handleReload}
            style={{
              border: '1px solid rgba(21, 33, 41, 0.12)',
              background: '#ffffff',
              color: '#152129',
              borderRadius: '999px',
              padding: '12px 18px',
              fontSize: '0.98rem',
              fontWeight: 600,
              cursor: 'pointer',
            }}
            type="button"
          >
            Reload
          </button>
          <button
            onClick={() => void handleReset()}
            style={{
              border: 'none',
              background: 'linear-gradient(135deg, #b18233, #23414b)',
              color: '#fffef7',
              borderRadius: '999px',
              padding: '12px 18px',
              fontSize: '0.98rem',
              fontWeight: 600,
              cursor: 'pointer',
            }}
            type="button"
          >
            Reset cache and reload
          </button>
        </div>
      </div>
    </div>
  )
}

type StartupBoundaryProps = {
  children: ReactNode
}

type StartupBoundaryState = {
  error: unknown
}

class StartupBoundary extends Component<StartupBoundaryProps, StartupBoundaryState> {
  override state: StartupBoundaryState = {
    error: null,
  }

  static getDerivedStateFromError(error: unknown): StartupBoundaryState {
    return { error }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('Storybook Reader failed to render.', error, info)
  }

  override render() {
    if (this.state.error) {
      return <StartupFallback error={this.state.error} />
    }

    return this.props.children
  }
}

async function bootstrap() {
  try {
    const { default: App } = await import('./App.tsx')

    root.render(
      <StrictMode>
        <StartupBoundary>
          <App />
        </StartupBoundary>
      </StrictMode>,
    )
  } catch (error) {
    root.render(<StartupFallback error={error} />)
  }
}

void bootstrap()
