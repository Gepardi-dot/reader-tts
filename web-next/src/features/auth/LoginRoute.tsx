import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  AuthApiError,
  clearAuth,
  getLastUsedEmail,
  getStoredUser,
  normalizeEmail,
  signIn,
  signUp,
} from '@/lib/auth'
import { recoverStuckClient } from '@/lib/clientRecovery'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import higgsReadLogo from '@/assets/higgsread-logo.png'

type Mode = 'signin' | 'signup'

/**
 * Prefill email from a previous session, then clear dead tokens so login
 * always starts clean. Runs during state init (not useEffect) so eslint
 * react-hooks/set-state-in-effect stays happy and CI lint passes.
 */
function initialLoginEmail(): string {
  if (typeof window === 'undefined') return ''
  try {
    const previous = getStoredUser()?.email || getLastUsedEmail()
    clearAuth({ keepLastEmail: true })
    if (window.location.search.includes('_recovered=')) {
      const url = new URL(window.location.href)
      url.searchParams.delete('_recovered')
      window.history.replaceState({}, '', url.pathname + url.search)
    }
    return previous
  } catch {
    return ''
  }
}

export function LoginRoute() {
  const navigate = useNavigate()
  const [mode, setMode] = useState<Mode>('signin')
  const [email, setEmail] = useState(initialLoginEmail)
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [emailTaken, setEmailTaken] = useState(false)
  const [loading, setLoading] = useState(false)
  const [recovering, setRecovering] = useState(false)
  const [showRecover, setShowRecover] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setEmailTaken(false)
    setShowRecover(false)
    setLoading(true)
    const cleanEmail = normalizeEmail(email)
    setEmail(cleanEmail)
    try {
      if (mode === 'signin') {
        const user = await signIn(cleanEmail, password)
        const { needsVoiceOnboarding } = await import('@/features/reader/voiceOnboarding')
        navigate(
          needsVoiceOnboarding(user.id) ? '/onboarding/voice' : '/library',
          { replace: true },
        )
      } else {
        await signUp(cleanEmail, password)
        navigate('/onboarding/voice', { replace: true })
      }
    } catch (err: unknown) {
      if (err instanceof AuthApiError && err.code === 'email_taken') {
        setEmailTaken(true)
        setError(err.message)
      } else if (err instanceof AuthApiError && err.code === 'invalid_credentials') {
        // Wrong password — do not push the cache-recovery UI
        setError(err.message)
      } else if (err instanceof AuthApiError && err.code === 'api_unreachable') {
        setShowRecover(true)
        setError(err.message)
      } else {
        // Unexpected failures may still be a stuck shell / network issue
        setShowRecover(true)
        setError(err instanceof Error ? err.message : 'Something went wrong.')
      }
    } finally {
      setLoading(false)
    }
  }

  async function handleRecover() {
    setRecovering(true)
    setError('Clearing old cached app data and reloading…')
    try {
      await recoverStuckClient({ reload: true })
    } catch {
      setRecovering(false)
      setError('Could not clear cache automatically. Hard-refresh (Ctrl+Shift+R) or use a private window.')
    }
  }

  function switchMode(next: Mode) {
    setMode(next)
    setError(null)
    setEmailTaken(false)
    setShowRecover(false)
  }

  return (
    <div className="flex min-h-svh items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-3">
          <img
            src={higgsReadLogo}
            alt="HiggsRead"
            className="mx-auto h-10 w-auto max-w-[220px] object-contain"
            draggable={false}
          />
          <p className="text-sm text-muted-foreground">
            {mode === 'signin' ? 'Sign in to your library' : 'Create an account'}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => { setEmail(e.target.value); setEmailTaken(false); setError(null) }}
              placeholder="you@example.com"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
            />
          </div>

          {error && (
            <div className="space-y-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
              <p className="text-sm text-destructive">{error}</p>
              {emailTaken && mode === 'signup' && (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={() => switchMode('signin')}
                >
                  Go to Sign in
                </Button>
              )}
              {showRecover && !emailTaken && (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  disabled={recovering}
                  onClick={() => void handleRecover()}
                >
                  {recovering ? 'Fixing…' : 'Fix stuck browser (clear cache & reload)'}
                </Button>
              )}
            </div>
          )}

          <Button type="submit" className="w-full" disabled={loading || recovering}>
            {loading ? 'Please wait…' : mode === 'signin' ? 'Sign in' : 'Create account'}
          </Button>
        </form>

        <p className="text-center text-sm text-muted-foreground">
          {mode === 'signin' ? (
            <>No account?{' '}
              <button type="button" onClick={() => switchMode('signup')}
                className="underline hover:text-foreground">
                Sign up
              </button>
            </>
          ) : (
            <>Already have an account?{' '}
              <button type="button" onClick={() => switchMode('signin')}
                className="underline hover:text-foreground">
                Sign in
              </button>
              {' '}— your books stay with that login.
            </>
          )}
        </p>

        <p className="text-center text-xs text-muted-foreground">
          Signed in here before and it stopped working?{' '}
          <button
            type="button"
            className="underline hover:text-foreground"
            disabled={recovering}
            onClick={() => void handleRecover()}
          >
            Clear old cache & reload
          </button>
        </p>
      </div>
    </div>
  )
}
