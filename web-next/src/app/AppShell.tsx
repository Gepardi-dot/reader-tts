import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { BookOpen, FileText, Layers, Mic2, Library, Upload } from 'lucide-react'
import { cn } from '@/lib/utils'

const NAV_ITEMS = [
  { to: '/library',    icon: Library,  label: 'Library' },
  { to: '/notes',      icon: FileText, label: 'Notes' },
  { to: '/vocabulary', icon: Layers,   label: 'Words' },
  { to: '/studio',     icon: BookOpen, label: 'Studio' },
  { to: '/audio',      icon: Mic2,     label: 'Audio' },
  { to: '/upload',     icon: Upload,   label: 'Upload' },
]

// Bottom nav shows first 5; Upload lives in sidebar only on desktop
const MOBILE_NAV = NAV_ITEMS.slice(0, 5)

export function AppShell() {
  const location = useLocation()
  const isReader = location.pathname.startsWith('/book/')

  // Reader: full-screen, no shell chrome
  if (isReader) return <Outlet />

  return (
    <div className="flex h-svh overflow-hidden bg-background">
      {/* ── Desktop sidebar (Notion style) ─────────────── */}
      <aside className="hidden md:flex w-60 flex-col shrink-0 border-r border-border bg-[var(--sidebar)]">
        {/* Workspace header */}
        <div className="flex items-center gap-2.5 px-4 h-14 border-b border-border shrink-0">
          <span className="text-lg leading-none">📚</span>
          <span className="font-semibold text-sm text-foreground truncate">Storybook Reader</span>
        </div>

        {/* Nav links */}
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
      </aside>

      {/* ── Main area ───────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Mobile top bar */}
        <header className="md:hidden flex items-center h-12 px-4 border-b border-border bg-background/95 backdrop-blur-sm shrink-0 z-10">
          <span className="font-semibold text-sm text-foreground">Storybook Reader</span>
        </header>

        {/* Scrollable page content */}
        <main className="flex-1 overflow-y-auto overscroll-y-contain">
          <Outlet />
        </main>

        {/* ── Mobile bottom nav ──────────────────────── */}
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
