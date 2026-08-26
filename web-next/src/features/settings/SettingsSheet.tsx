import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Info, LogOut, Settings2, Trash2, Volume2 } from 'lucide-react'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { AuthApiError, deleteAccount, signOut } from '@/lib/auth'
import { cn } from '@/lib/utils'
import { AudioPreviewPanel } from '@/features/reader/AudioPreviewPanel'
import { AppearanceContent } from '@/features/reader/AppearanceContent'
import { SETTINGS_CHROME_COLORS } from '@/features/reader/readerTheme'
import {
  audioPrefsWithSelection,
  loadAudioPrefs,
  saveAudioPrefs,
  type AudioSelection,
} from '@/features/reader/audioPreferences'
import {
  clearLocalReaderSettings,
  loadGlobalAppearance,
  loadGlobalAudioRate,
  saveGlobalAppearance,
  saveGlobalAudioRate,
  type BookAppearance,
} from '@/features/reader/bookSettings'
import { AboutHiggsRead } from './AboutHiggsRead'
import { NotionConnect } from './NotionConnect'

type SettingsTab = 'appearance' | 'audio'

const TABS: Array<{ id: SettingsTab; label: string; Icon: typeof Volume2 }> = [
  { id: 'appearance', label: 'Appearance', Icon: Settings2 },
  { id: 'audio', label: 'Audio', Icon: Volume2 },
]

export function SettingsSheet({
  open,
  onOpenChange,
  email,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  email: string | null
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-md p-0 gap-0 data-[side=right]:w-full"
        showCloseButton
      >
        {open ? (
          <SettingsBody email={email} onClose={() => onOpenChange(false)} />
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

function SettingsBody({
  email,
  onClose,
}: {
  email: string | null
  onClose: () => void
}) {
  const navigate = useNavigate()
  const [tab, setTab] = useState<SettingsTab>('appearance')
  const [mode, setMode] = useState<'settings' | 'delete' | 'about'>('settings')
  const [appearance, setAppearance] = useState(() => loadGlobalAppearance())
  const [audioPrefs, setAudioPrefs] = useState(() => loadAudioPrefs())
  const [audioRate, setAudioRate] = useState(() => loadGlobalAudioRate())
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  function patchAppearance(patch: Partial<BookAppearance>) {
    setAppearance((current) => {
      const next = { ...current, ...patch }
      saveGlobalAppearance(next)
      return next
    })
  }

  function applyAudioSelection(selection: AudioSelection) {
    setAudioPrefs((current) => {
      const next = audioPrefsWithSelection(current, selection)
      saveAudioPrefs(next)
      return next
    })
  }

  function handleRateChange(rate: number) {
    setAudioRate(rate)
    saveGlobalAudioRate(rate)
  }

  async function handleSignOut() {
    setBusy(true)
    setError(null)
    try {
      await signOut()
      onClose()
      navigate('/login', { replace: true })
    } catch {
      setError('Could not sign out. Try again.')
      setBusy(false)
    }
  }

  async function handleDelete() {
    setBusy(true)
    setError(null)
    try {
      await deleteAccount(password)
      clearLocalReaderSettings()
      onClose()
      navigate('/login', { replace: true })
    } catch (err) {
      const message = err instanceof AuthApiError
        ? err.message
        : 'Could not delete your account. Try again.'
      setError(message)
      setBusy(false)
    }
  }

  if (mode === 'about') {
    return (
      <AboutHiggsRead
        accountEmail={email}
        onBack={() => setMode('settings')}
      />
    )
  }

  if (mode === 'delete') {
    return (
      <div className="flex flex-col h-full min-h-0 flex-1">
        <SheetHeader className="border-b border-border pr-10">
          <SheetTitle>Delete account</SheetTitle>
          <SheetDescription>
            This permanently deletes {email ?? 'your account'}, including books, notes, and vocabulary. This cannot be undone.
          </SheetDescription>
        </SheetHeader>
        <div className="flex-1 p-4 space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="delete-account-password">Password</Label>
            <Input
              id="delete-account-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter your password"
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <div className="p-4 border-t border-border space-y-2">
          <Button
            variant="destructive"
            className="w-full bg-red-600 text-white hover:bg-red-700"
            disabled={busy || password.length < 8}
            onClick={() => void handleDelete()}
          >
            {busy ? 'Deleting…' : 'Delete account'}
          </Button>
          <Button
            variant="outline"
            className="w-full"
            disabled={busy}
            onClick={() => {
              setMode('settings')
              setPassword('')
              setError(null)
            }}
          >
            Cancel
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full min-h-0 flex-1">
      <SheetHeader className="border-b border-border pr-10">
        <SheetTitle>Settings</SheetTitle>
        <SheetDescription className="truncate">
          {email ?? 'Signed in'}
        </SheetDescription>
      </SheetHeader>

      <div className="px-3.5 pt-3">
        <div className="flex rounded-lg p-0.5 bg-muted">
          {TABS.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={cn(
                'flex-1 flex items-center justify-center gap-1 px-2.5 py-1 text-[12px] font-medium rounded-md transition-all whitespace-nowrap',
                tab === id
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon size={12} /> {label}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground mt-2 px-0.5 leading-4">
          Defaults for new books. Each book keeps its own look and voice.
        </p>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto overscroll-y-contain">
        <div style={{ display: tab === 'appearance' ? 'block' : 'none' }}>
          <AppearanceContent
            appearance={appearance}
            onChange={patchAppearance}
            colorMode="chrome"
          />
        </div>
        <div style={{ display: tab === 'audio' ? 'block' : 'none' }}>
          <AudioPreviewPanel
            key={`${audioPrefs.provider}:${audioPrefs.voice ?? ''}`}
            colors={SETTINGS_CHROME_COLORS}
            provider={audioPrefs.provider}
            voice={audioPrefs.voice}
            onSelectionChange={applyAudioSelection}
            rate={audioRate}
            onRateChange={handleRateChange}
            onCommitVoice={() => true}
          />
        </div>
      </div>

      <div className="p-3 border-t border-border space-y-1 shrink-0">
        <div className="pb-2">
          <NotionConnect compact />
        </div>
        {error && <p className="text-xs text-destructive px-1 pb-1">{error}</p>}
        <button
          type="button"
          onClick={() => {
            setMode('about')
            setError(null)
          }}
          disabled={busy}
          className="flex items-center gap-2 w-full px-3 py-2 rounded-md text-sm text-foreground hover:bg-accent transition-colors disabled:opacity-50"
        >
          <Info size={15} className="shrink-0" />
          About HiggsRead
        </button>
        <button
          type="button"
          onClick={() => void handleSignOut()}
          disabled={busy}
          className="flex items-center gap-2 w-full px-3 py-2 rounded-md text-sm text-foreground hover:bg-accent transition-colors disabled:opacity-50"
        >
          <LogOut size={15} className="shrink-0" />
          Log out
        </button>
        <Separator className="my-1" />
        <button
          type="button"
          onClick={() => {
            setMode('delete')
            setError(null)
          }}
          disabled={busy}
          className="flex items-center gap-2 w-full px-3 py-2 rounded-md text-sm text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50"
        >
          <Trash2 size={15} className="shrink-0" />
          Delete account
        </button>
      </div>
    </div>
  )
}
