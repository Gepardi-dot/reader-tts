/* eslint-disable react-refresh/only-export-components */
import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from 'react-router-dom'
import { router } from './app/router'
import {
  AuthError,
  clearStoredAuthKey,
  getBooks,
  setStoredAuthKey,
} from '@/shared/api/client'
import '@/shared/theme/tokens.css'
import '@/shared/theme/base.css'

const rootElement = document.getElementById('root')

if (!rootElement) {
  throw new Error('Storybook Reader could not find its root element.')
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
    mutations: {
      retry: 0,
    },
  },
})

// ── Login screen ──────────────────────────────────────────────────────────────

function LoginScreen({ onUnlock }: { onUnlock: () => void }) {
  const [key, setKey] = useState('')
  const [error, setError] = useState('')
  const [checking, setChecking] = useState(false)

  async function handleSubmit(e: { preventDefault: () => void }) {
    e.preventDefault()
    const trimmed = key.trim()
    if (!trimmed) return
    setChecking(true)
    setError('')
    try {
      setStoredAuthKey(trimmed)
      await getBooks()
      onUnlock()
    } catch (err) {
      clearStoredAuthKey()
      setError(err instanceof AuthError
        ? 'Wrong access key. Check your APP_SECRET_KEY and try again.'
        : 'Could not reach the server. Make sure the API is running.')
    } finally {
      setChecking(false)
    }
  }

  return (
    <div style={{
      minHeight: '100dvh', display: 'grid', placeItems: 'center',
      padding: '24px', background: 'var(--surface-page, #f6f1e3)',
    }}>
      <form
        onSubmit={(e) => void handleSubmit(e)}
        style={{
          width: 'min(100%, 420px)', borderRadius: '20px',
          border: '1px solid var(--border-subtle, rgba(0,0,0,.08))',
          background: 'var(--surface-card, #fff)',
          boxShadow: '0 24px 56px rgba(0,0,0,.10)',
          padding: '36px 32px 32px',
          display: 'flex', flexDirection: 'column', gap: '20px',
        }}
      >
        <div>
          <p className="eyebrow">Storybook Reader</p>
          <h2 style={{ margin: '8px 0 4px', fontSize: 'clamp(1.6rem,5vw,2.2rem)', fontWeight: 700, lineHeight: 1.1 }}>
            Enter your access key
          </h2>
          <p style={{ margin: 0, fontSize: '0.95rem', opacity: 0.65 }}>
            Paste the value of <code style={{ fontSize: '0.85em', background: 'rgba(0,0,0,.06)', padding: '1px 5px', borderRadius: 4 }}>APP_SECRET_KEY</code> from your server.
          </p>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <input
            autoFocus
            disabled={checking}
            onChange={(e) => setKey(e.target.value)}
            placeholder="Paste your access key"
            style={{
              width: '100%', padding: '11px 14px', fontSize: '1rem',
              borderRadius: '10px', border: '1.5px solid var(--border, rgba(0,0,0,.18))',
              background: '#fff', boxSizing: 'border-box',
            }}
            type="password"
            value={key}
          />
          {error ? <p style={{ margin: 0, fontSize: '0.88rem', color: '#c0392b' }}>{error}</p> : null}
        </div>

        <button
          className="button button--primary"
          disabled={checking || !key.trim()}
          type="submit"
        >
          {checking ? 'Checking…' : 'Unlock reader'}
        </button>
      </form>
    </div>
  )
}

// ── Root ──────────────────────────────────────────────────────────────────────

function Root() {
  const [locked, setLocked] = useState(false)

  useEffect(() => {
    const handler = () => {
      clearStoredAuthKey()
      setLocked(true)
    }
    window.addEventListener('storybook-auth-error', handler)
    return () => window.removeEventListener('storybook-auth-error', handler)
  }, [])

  if (locked) {
    return <LoginScreen onUnlock={() => setLocked(false)} />
  }

  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
}

createRoot(rootElement).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
