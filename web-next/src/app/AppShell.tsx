import { NavLink, Outlet, Link, useLocation, useNavigate } from 'react-router-dom'
import { SquarePen, Type, TrendingUp, LogOut, Sparkles, Library } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getStoredUser, signOut, subscribeAuth } from '@/lib/auth'
import { api } from '@/shared/api/client'
import { cn } from '@/lib/utils'

interface Book {
  id: string
  title: string
  highlightCount: number
  readingProgress: { pageNumber: number; totalPages: number } | null
}

interface DeckSummary {
  id: string
  title: string
  dueNow: number
  noteCount?: number
  cardCount?: number
}

const COVER_COLORS = ['#fef6ee', '#eef4fb', '#f0efe9', '#f8eef0']

const LEARN_NAV = [
  { to: '/library',    Icon: Library,    label: 'Library' },
  { to: '/notes',      Icon: SquarePen,  label: 'Notes' },
  { to: '/vocabulary', Icon: Type,       label: 'Words' },
  { to: '/progress',   Icon: TrendingUp, label: 'Progress' },
] as const

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
  const [userEmail, setUserEmail] = useState<string | null>(() => getStoredUser()?.email ?? null)

  useEffect(() => {
    return subscribeAuth((user) => setUserEmail(user?.email ?? null))
  }, [])

  const { data: books = [] } = useQuery({
    queryKey: ['books'],
    queryFn: async () => {
      const res = await api.get<{ items: Book[] } | Book[]>('/api/books')
      return Array.isArray(res) ? res : (res as { items: Book[] }).items ?? []
    },
    staleTime: 60_000,
  })

  const { data: decks = [] } = useQuery({
    queryKey: ['decks'],
    queryFn: async () => {
      try {
        const res = await api.get<{ items: DeckSummary[] }>('/api/vocabulary/decks')
        return res.items ?? []
      } catch { return [] }
    },
    staleTime: 60_000,
  })

  const dueCount = decks.reduce((sum, d) => sum + (d.dueNow ?? 0), 0)
  // Total saved vocabulary notes (words), not "due" — matches the Words page.
  const wordCount = decks.reduce((sum, d) => sum + (d.noteCount ?? d.cardCount ?? 0), 0)
  // Total highlights/notes across books — matches the Notes page.
  const notesCount = books.reduce((sum, b) => sum + (b.highlightCount ?? 0), 0)

  function navBadge(label: string): number | null {
    if (label === 'Words' && wordCount > 0) return wordCount
    if (label === 'Notes' && notesCount > 0) return notesCount
    return null
  }

  async function handleSignOut() {
    await signOut()
    navigate('/login', { replace: true })
  }

  if (isReader) return <Outlet />

  return (
    <div className="flex h-svh overflow-hidden bg-background">

      {/* ── Desktop sidebar ─────────────────────────────── */}
      <aside className="hidden md:flex w-60 flex-col shrink-0 border-r border-border bg-[var(--sidebar)]">

        {/* Brand */}
        <div className="flex items-center px-4 h-14 border-b border-border shrink-0 bg-[#f7f7f5]">
          <BrandLogo />
        </div>

        <nav className="flex-1 overflow-y-auto p-2">

          {/* LEARN section */}
          <div className="text-[10.5px] font-semibold tracking-[0.1em] uppercase text-muted-foreground px-3 pt-3 pb-1.5">
            LEARN
          </div>
          {LEARN_NAV.map(({ to, Icon, label }) => (
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
              <span className="flex-1">{label}</span>
              {navBadge(label) != null && (
                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-primary text-primary-foreground leading-none tabular-nums">
                  {navBadge(label)}
                </span>
              )}
            </NavLink>
          ))}

          {/* LIBRARY section — individual books */}
          {books.length > 0 && (
          <div className="pt-3 pb-1">
            <div className="text-[10.5px] font-semibold tracking-[0.1em] uppercase text-muted-foreground px-3 pb-1.5">
              LIBRARY
            </div>
            {books.map((book, i) => (
              <Link
                key={book.id}
                to={`/book/${book.id}`}
                className="flex items-center gap-2 px-3 py-1.5 rounded-md transition-colors hover:bg-accent group"
              >
                <div
                  className="shrink-0 rounded-[3px] border border-black/[0.07]"
                  style={{
                    width: 18,
                    height: 24,
                    background: COVER_COLORS[i % COVER_COLORS.length],
                  }}
                />
                <span className="text-[12px] text-muted-foreground group-hover:text-foreground truncate leading-snug transition-colors">
                  {book.title}
                </span>
              </Link>
            ))}
          </div>
          )}
        </nav>

        {/* Practice button + sign out */}
        <div className="p-2 border-t border-border space-y-1 shrink-0">
          <Link
            to="/studio"
            className="flex items-center justify-center gap-2 w-full py-2.5 rounded-lg bg-primary text-primary-foreground text-[13px] font-semibold transition-opacity hover:opacity-90"
          >
            <Sparkles size={13} />
            {dueCount > 0 ? `Practice · ${dueCount} due` : 'Practice'}
          </Link>
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

        <main className="flex-1 min-h-0 overflow-y-auto overscroll-y-contain">
          <Outlet />
        </main>

        {/* ── Mobile bottom nav ───────────────────────── */}
        <nav
          className="md:hidden flex items-center border-t border-border bg-background/95 backdrop-blur-sm shrink-0"
          style={{
            height: 'calc(56px + env(safe-area-inset-bottom, 0px))',
            paddingBottom: 'env(safe-area-inset-bottom, 0px)',
          }}
        >
          {LEARN_NAV.map(({ to, Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                cn(
                  'flex flex-col items-center justify-center gap-0.5 flex-1 h-full transition-colors relative',
                  isActive ? 'text-primary' : 'text-muted-foreground',
                )
              }
            >
              {({ isActive }) => (
                <>
                  <div className="relative">
                    <Icon size={22} strokeWidth={1.75} />
                    {navBadge(label) != null && (
                      <span className="absolute -top-1 -right-1.5 min-w-3.5 h-3.5 px-0.5 rounded-full bg-primary text-primary-foreground text-[8px] font-bold flex items-center justify-center leading-none tabular-nums">
                        {(navBadge(label) ?? 0) > 9 ? '9+' : navBadge(label)}
                      </span>
                    )}
                  </div>
                  <span className={cn('text-[10px] font-medium leading-none', isActive && 'font-semibold')}>
                    {label}
                  </span>
                </>
              )}
            </NavLink>
          ))}

          {/* Practice tab */}
          <NavLink
            to="/studio"
            className={({ isActive }) =>
              cn(
                'flex flex-col items-center justify-center gap-0.5 flex-1 h-full transition-colors relative',
                isActive ? 'text-primary' : dueCount > 0 ? 'text-primary' : 'text-muted-foreground',
              )
            }
          >
            {({ isActive }) => (
              <>
                <div className="relative">
                  <Sparkles size={22} strokeWidth={1.75} />
                  {dueCount > 0 && (
                    <span className="absolute -top-1 -right-1.5 w-3.5 h-3.5 rounded-full bg-primary text-primary-foreground text-[8px] font-bold flex items-center justify-center leading-none">
                      {dueCount > 9 ? '9+' : dueCount}
                    </span>
                  )}
                </div>
                <span className={cn('text-[10px] font-medium leading-none', isActive && 'font-semibold')}>
                  Practice
                </span>
              </>
            )}
          </NavLink>
        </nav>
      </div>
    </div>
  )
}
