import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { SquarePen, Type, Mic, Library, Upload, LogOut } from 'lucide-react'
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { cn } from '@/lib/utils'

function StudioFlame({ size = 15, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className}>
      <path d="M7 10c-.5-3 .5-6 3-8-.5 3 .5 4.5 2 6 1.8 1.8 3 3.5 3 6a6 6 0 0 1-12 0c0-2 1-3.5 2-4.5.5 1 1.2 1.3 2 .5z" fill="#E63323"/>
      <path d="M18 10c-1.5-1-2.5-2-3-3.5 0 2 .5 3.2 1.5 4.2-2 0-3 1-3.5 3 .5 0 1-.2 1.5-.5-.8 1.3-1 2.8-.5 4.3 2.8-.5 5-2.8 5-5.8 0-.7 0-1.2-.5-1.7z" fill="#F58220"/>
      <path d="M14.2 13.5c-.3-1-1-1.8-2-2.3.5 1.3.5 2.3-.3 3.3-.8 1-1 2-.5 3.3 2-.3 3.3-1.5 3.3-3 0-.5-.2-1-.5-1.3z" fill="#FBB040"/>
    </svg>
  )
}

const NAV_ITEMS = [
  { to: '/library',    icon: Library,     label: 'Library' },
  { to: '/notes',      icon: SquarePen,   label: 'Notes' },
  { to: '/vocabulary', icon: Type,        label: 'Words' },
  { to: '/studio',     icon: StudioFlame, label: 'Studio' },
  { to: '/audio',      icon: Mic,         label: 'Audio' },
  { to: '/upload',     icon: Upload,      label: 'Upload' },
]

const MOBILE_NAV = NAV_ITEMS.slice(0, 5)

function BrandLogo() {
  return (
    <div
      className="inline-flex items-center gap-2 px-2.5 py-1.5 rounded-md border shrink-0"
      style={{ background: '#f7f7f5', borderColor: '#f4f3ef' }}
    >
      <div className="relative pb-[3px] shrink-0">
        <span
          className="text-[18px] leading-none text-foreground block"
          style={{ fontFamily: '"Playfair Display", Georgia, serif', fontWeight: 600 }}
        >
          R
        </span>
        <span
          className="absolute bottom-0 left-0 right-0 h-[2px] rounded-full"
          style={{ background: 'linear-gradient(90deg, #c8960c, #e8b824)' }}
        />
      </div>
      <span
        className="text-[13px] leading-none text-foreground whitespace-nowrap"
        style={{ fontFamily: '"Playfair Display", Georgia, serif' }}
      >
        Book <em>Reader</em>
      </span>
    </div>
  )
}

export function AppShell() {
  const location = useLocation()
  const navigate = useNavigate()
  const isReader = location.pathname.startsWith('/book/')
  const [userEmail, setUserEmail] = useState<string | null>(null)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setUserEmail(data.session?.user.email ?? null)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, session) => {
      setUserEmail(session?.user.email ?? null)
    })
    return () => subscription.unsubscribe()
  }, [])

  async function handleSignOut() {
    await supabase.auth.signOut()
    navigate('/login', { replace: true })
  }

  if (isReader) return <Outlet />

  return (
    <div className="flex h-svh overflow-hidden bg-background">
      {/* ── Desktop sidebar ─────────────────────────────── */}
      <aside className="hidden md:flex w-60 flex-col shrink-0 border-r border-border bg-[var(--sidebar)]">
        <div className="flex items-center px-4 h-14 border-b border-border shrink-0 bg-[#f7f7f5]">
          <BrandLogo />
        </div>

        <nav className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {NAV_ITEMS.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2.5 px-3 py-1.5 rounded-md text-sm transition-colors select-none',
                  isActive
                    ? 'bg-accent text-foreground font-medium'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                )
              }
            >
              <Icon size={15} className="shrink-0" />
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="p-2 border-t border-border">
          <button
            onClick={handleSignOut}
            className="flex items-center gap-2 w-full px-3 py-1.5 rounded-md text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
          >
            <LogOut size={13} className="shrink-0" />
            <span className="truncate flex-1 text-left">{userEmail ?? 'Sign out'}</span>
          </button>
        </div>
      </aside>

      {/* ── Main area ───────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <header className="md:hidden flex items-center h-12 px-4 border-b border-border bg-background/95 backdrop-blur-sm shrink-0 z-10">
          <BrandLogo />
        </header>

        <main className="flex-1 overflow-y-auto overscroll-y-contain">
          <Outlet />
        </main>

        <nav
          className="md:hidden flex items-center justify-around border-t border-border bg-background/95 backdrop-blur-sm shrink-0"
          style={{
            height: 'calc(56px + env(safe-area-inset-bottom, 0px))',
            paddingBottom: 'env(safe-area-inset-bottom, 0px)',
          }}
        >
          {MOBILE_NAV.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                cn(
                  'flex flex-col items-center justify-center gap-0.5 flex-1 h-full transition-colors',
                  isActive ? 'text-primary' : 'text-muted-foreground',
                )
              }
            >
              <Icon size={22} strokeWidth={1.75} />
              <span className="text-[10px] font-medium leading-none">{label}</span>
            </NavLink>
          ))}
        </nav>
      </div>
    </div>
  )
}
