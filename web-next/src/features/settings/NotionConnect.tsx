import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, LoaderCircle } from 'lucide-react'
import { api, AuthError } from '@/shared/api/client'
import { Button } from '@/components/ui/button'

export type NotionStatus = {
  configured: boolean
  connected: boolean
  workspaceName: string | null
}

const NOTION_QUERY = ['notion-status'] as const

function consumeNotionFlag(): { message: string | null; error: string | null; shouldSync: boolean } {
  if (typeof window === 'undefined') return { message: null, error: null, shouldSync: false }
  const params = new URLSearchParams(window.location.search)
  const flag = params.get('notion')
  if (!flag) return { message: null, error: null, shouldSync: false }
  params.delete('notion')
  const next = `${window.location.pathname}${params.toString() ? `?${params}` : ''}${window.location.hash}`
  window.history.replaceState({}, '', next)
  if (flag === 'connected') {
    return {
      message: 'Notion connected. Your notes will land under each book title.',
      error: null,
      shouldSync: true,
    }
  }
  if (flag === 'need-page') {
    return {
      message: null,
      error: 'In Notion, pick any page on the permission screen so HiggsRead can write book pages to your library.',
      shouldSync: false,
    }
  }
  if (flag === 'denied') return { message: null, error: 'Notion access was cancelled.', shouldSync: false }
  if (flag === 'error') return { message: null, error: 'Could not finish connecting Notion. Try again.', shouldSync: false }
  return { message: null, error: null, shouldSync: false }
}

function detailFromError(error: unknown): string {
  if (error instanceof AuthError) return 'Sign in to connect Notion.'
  const raw = error instanceof Error ? error.message : String(error)
  try {
    const jsonStart = raw.indexOf('{')
    if (jsonStart >= 0) {
      const parsed = JSON.parse(raw.slice(jsonStart)) as { detail?: string }
      if (parsed.detail) return parsed.detail
    }
  } catch { /* use fallback */ }
  if (/503/.test(raw)) return 'Notion sync is not enabled on this server yet.'
  return 'Could not talk to Notion. Try again.'
}

export function NotionConnect({ compact = false }: { compact?: boolean }) {
  const queryClient = useQueryClient()
  const [boot] = useState(consumeNotionFlag)
  const [busy, setBusy] = useState<'connect' | 'sync' | 'disconnect' | null>(null)
  const [message, setMessage] = useState<string | null>(boot.message)
  const [error, setError] = useState<string | null>(boot.error)

  const { data: status, isLoading } = useQuery({
    queryKey: NOTION_QUERY,
    queryFn: () => api.get<NotionStatus>('/api/integrations/notion'),
    staleTime: 15_000,
    retry: false,
  })

  useEffect(() => {
    if (!boot.shouldSync) return
    void queryClient.invalidateQueries({ queryKey: NOTION_QUERY })
    void api.post('/api/integrations/notion/sync', {}).catch(() => undefined)
  }, [boot.shouldSync, queryClient])

  async function connect() {
    setBusy('connect')
    setError(null)
    try {
      const { url } = await api.get<{ url: string }>('/api/integrations/notion/start')
      window.location.assign(url)
    } catch (err) {
      setError(detailFromError(err))
      setBusy(null)
    }
  }

  async function syncExisting() {
    setBusy('sync')
    setError(null)
    try {
      const result = await api.post<{ synced: number }>('/api/integrations/notion/sync', {})
      setMessage(
        result.synced > 0
          ? `Sent ${result.synced} note${result.synced === 1 ? '' : 's'} to Notion.`
          : 'Notion is up to date.',
      )
      await queryClient.invalidateQueries({ queryKey: NOTION_QUERY })
    } catch (err) {
      setError(detailFromError(err))
    } finally {
      setBusy(null)
    }
  }

  async function disconnect() {
    setBusy('disconnect')
    setError(null)
    try {
      await api.delete('/api/integrations/notion')
      setMessage('Disconnected. Notes in Notion were left as they are.')
      await queryClient.invalidateQueries({ queryKey: NOTION_QUERY })
    } catch (err) {
      setError(detailFromError(err))
    } finally {
      setBusy(null)
    }
  }

  const connected = Boolean(status?.connected)
  const configured = status?.configured !== false

  return (
    <div className={compact ? 'rounded-xl border border-border bg-background px-3 py-2.5' : 'px-1 py-1'}>
      <div className="flex items-start gap-3">
        <div
          className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[13px] font-semibold text-white"
          style={{ background: '#242424' }}
          aria-hidden
        >
          N
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">
            {connected ? 'Notes sync to Notion' : 'Send notes to Notion'}
          </p>
          <p className="text-[12px] text-muted-foreground leading-4 mt-0.5">
            {connected
              ? `Each book is a page in your Notion library${status?.workspaceName ? ` (${status.workspaceName})` : ''}. Open it to see notes.`
              : 'One tap. Notion asks you to pick a page, then each book shows up in your Private library by title.'}
          </p>
          {isLoading ? (
            <p className="text-[12px] text-muted-foreground mt-2">Checking…</p>
          ) : !configured ? (
            <p className="text-[12px] text-muted-foreground mt-2">
              Notion sync is not enabled on this server yet.
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-2 mt-2.5">
              {connected ? (
                <>
                  <span className="inline-flex items-center gap-1 text-[12px] text-emerald-700">
                    <Check size={13} strokeWidth={2.25} /> Connected
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => void syncExisting()}
                  >
                    {busy === 'sync' ? 'Syncing…' : 'Sync existing notes'}
                  </Button>
                  <button
                    type="button"
                    className="text-[12px] text-muted-foreground hover:text-foreground disabled:opacity-50"
                    disabled={busy !== null}
                    onClick={() => void disconnect()}
                  >
                    Disconnect
                  </button>
                </>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => void connect()}
                >
                  {busy === 'connect'
                    ? <span className="inline-flex items-center gap-1.5"><LoaderCircle size={14} className="animate-spin" /> Opening Notion…</span>
                    : 'Connect Notion'}
                </Button>
              )}
            </div>
          )}
          {message && <p className="text-[12px] text-foreground mt-2">{message}</p>}
          {error && <p className="text-[12px] text-destructive mt-2">{error}</p>}
        </div>
      </div>
    </div>
  )
}
