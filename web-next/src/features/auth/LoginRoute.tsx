import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { signIn, signUp } from '@/lib/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

type Mode = 'signin' | 'signup'

export function LoginRoute() {
  const navigate = useNavigate()
  const [mode, setMode] = useState<Mode>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      if (mode === 'signin') {
        await signIn(email, password)
        navigate('/library', { replace: true })
      } else {
        await signUp(email, password, inviteCode)
        navigate('/library', { replace: true })
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-svh items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <span className="text-3xl">📚</span>
          <h1 className="mt-2 text-xl font-semibold text-foreground">Storybook Reader</h1>
          <p className="mt-1 text-sm text-muted-foreground">
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
              onChange={(e) => setEmail(e.target.value)}
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

          {mode === 'signup' && (
            <div className="space-y-1.5">
              <Label htmlFor="invite">Invite code</Label>
              <Input
                id="invite"
                type="text"
                autoComplete="off"
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value)}
                placeholder="reader-friends"
              />
            </div>
          )}

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? 'Please wait…' : mode === 'signin' ? 'Sign in' : 'Create account'}
          </Button>
        </form>

        <p className="text-center text-sm text-muted-foreground">
          {mode === 'signin' ? (
            <>No account?{' '}
              <button type="button" onClick={() => { setMode('signup'); setError(null) }}
                className="underline hover:text-foreground">
                Sign up
              </button>
            </>
          ) : (
            <>Already have an account?{' '}
              <button type="button" onClick={() => { setMode('signin'); setError(null) }}
                className="underline hover:text-foreground">
                Sign in
              </button>
            </>
          )}
        </p>
      </div>
    </div>
  )
}
