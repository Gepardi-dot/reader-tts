import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { ChevronLeft, Flag, Mail } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/shared/api/client'
import { BrandLogo } from '@/components/BrandLogo'
import { ACTIVE_USERS_FLOOR } from './activeUsers'

type SupportKind = 'contact' | 'report'

export function AboutHiggsRead({
  accountEmail,
  onBack,
}: {
  accountEmail: string | null
  onBack: () => void
}) {
  const { data } = useQuery({
    queryKey: ['active-users'],
    queryFn: () => api.get<{ count: number }>('/api/stats/active-users'),
    staleTime: 30_000,
  })
  const count = Math.max(ACTIVE_USERS_FLOOR, data?.count ?? ACTIVE_USERS_FLOOR)

  return (
    <div className="flex flex-col h-full min-h-0 flex-1">
      <SheetHeader className="border-b border-border pr-10">
        <button
          type="button"
          onClick={onBack}
          className="mb-1 -ml-1 flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft size={14} /> Settings
        </button>
        <SheetTitle>About HiggsRead</SheetTitle>
        <SheetDescription>A quieter place to read.</SheetDescription>
      </SheetHeader>

      <div className="flex-1 min-h-0 overflow-y-auto overscroll-y-contain px-4 py-4 space-y-5">
        <div className="flex justify-center pt-1">
          <BrandLogo className="h-10 max-w-[180px]" />
        </div>

        <ActiveUsersCard count={count} />

        <SupportForm
          kind="contact"
          title="Contact"
          Icon={Mail}
          hint={accountEmail
            ? 'We’ll reply to your account email.'
            : 'Send a note. We’ll reply if we can reach you.'}
          placeholder="What’s on your mind?"
        />

        <SupportForm
          kind="report"
          title="Report"
          Icon={Flag}
          hint="Tell us what broke or feels off. No account details are shown publicly."
          placeholder="What happened?"
        />
      </div>
    </div>
  )
}

function ActiveUsersCard({ count }: { count: number }) {
  return (
    <div
      className="relative overflow-hidden rounded-2xl px-5 py-6 text-center reader-theme-kindle"
      style={{
        border: '1px solid rgba(120, 116, 108, 0.28)',
        boxShadow: [
          '0 1px 2px rgba(55, 53, 47, 0.08)',
          '0 10px 28px rgba(55, 53, 47, 0.06)',
          'inset 0 1px 0 rgba(255, 255, 255, 0.78)',
        ].join(', '),
      }}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-50"
        style={{
          backgroundImage:
            'radial-gradient(ellipse at 50% 0%, rgba(255,255,255,0.72), transparent 58%)',
        }}
      />
      <div className="relative">
        <div className="inline-flex items-center gap-1.5 rounded-full bg-white/55 px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.18em] text-[#6b655c] ring-1 ring-black/5">
          <span className="relative flex size-1.5">
            <span className="absolute inset-0 rounded-full bg-emerald-500/80 animate-ping" />
            <span className="relative size-1.5 rounded-full bg-emerald-500" />
          </span>
          Live
        </div>
        <p
          className="mt-3 text-[56px] leading-none tracking-[-0.04em] text-[#1c1c1e] tabular-nums"
          style={{ fontFamily: 'var(--font-display)' }}
        >
          {count.toLocaleString()}
        </p>
        <p className="mt-2 text-[13px] font-medium text-[#3f3c38]">Active readers</p>
        <p className="mt-1 text-[11.5px] leading-4 text-[#7a746a]">
          A small room, growing — one quiet reader at a time.
        </p>
      </div>
    </div>
  )
}

function SupportForm({
  kind,
  title,
  Icon,
  hint,
  placeholder,
}: {
  kind: SupportKind
  title: string
  Icon: typeof Mail
  hint: string
  placeholder: string
}) {
  const [message, setMessage] = useState('')
  const [error, setError] = useState<string | null>(null)

  const send = useMutation({
    mutationFn: () => api.post<{ ok: boolean }>('/api/support', { kind, message }),
    onMutate: () => setError(null),
    onError: (err) => {
      const raw = err instanceof Error ? err.message : ''
      setError(supportErrorMessage(raw))
    },
    onSuccess: () => setMessage(''),
  })

  return (
    <form
      className="space-y-2.5"
      onSubmit={(e) => {
        e.preventDefault()
        if (message.trim().length < 8) {
          setError('Please write a little more so we can help.')
          return
        }
        send.mutate()
      }}
    >
      <div className="flex items-center gap-2">
        <Icon size={14} className="text-muted-foreground" />
        <Label className="text-sm font-medium">{title}</Label>
      </div>
      <p className="text-[11.5px] leading-4 text-muted-foreground">{hint}</p>
      <Textarea
        value={message}
        onChange={(e) => {
          setMessage(e.target.value)
          if (send.isSuccess) send.reset()
        }}
        placeholder={placeholder}
        className="min-h-[88px] text-sm"
        maxLength={4000}
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
      {send.isSuccess && (
        <p className="text-xs text-emerald-700">Sent. We’ll read it.</p>
      )}
      <Button type="submit" className="w-full" disabled={send.isPending}>
        {send.isPending ? 'Sending…' : kind === 'report' ? 'Send report' : 'Send message'}
      </Button>
    </form>
  )
}

function supportErrorMessage(raw: string) {
  if (/too many/i.test(raw)) return 'Please wait a bit before sending another note.'
  if (/Authentication required|Unauthorized/i.test(raw)) {
    return 'Your session expired. Sign in again, then try again.'
  }
  return 'Could not send just now. Try again in a moment.'
}
