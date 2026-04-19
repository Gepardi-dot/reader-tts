import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { AudioDock } from '@/shared/ui/AudioDock'
import styles from './AppShell.module.css'

const routeMotion = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -6 },
  transition: { duration: 0.18, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] },
}

const NAV_ITEMS = [
  { to: '/books',          label: 'Books',   icon: '📚' },
  { to: '/studio',         label: 'Studio',  icon: '🎓' },
  { to: '/words',          label: 'Words',   icon: '💡' },
  { to: '/notes',          label: 'Notes',   icon: '📝' },
] as const

function navClass({ isActive }: { isActive: boolean }) {
  return `${styles.navItem} ${isActive ? styles.navItemActive : ''}`
}

function bottomNavClass({ isActive }: { isActive: boolean }) {
  return `${styles.bottomNavItem} ${isActive ? styles.bottomNavItemActive : ''}`
}

export function AppShell() {
  const location = useLocation()

  const pageTitle =
    location.pathname === '/books'          ? 'Library'
    : location.pathname === '/studio'       ? 'Studio'
    : location.pathname === '/words'        ? 'Words'
    : location.pathname === '/notes'        ? 'Notes'
    : location.pathname === '/upload'       ? 'Upload'
    : location.pathname === '/settings/audio' ? 'Audio'
    : location.pathname.startsWith('/book/') ? 'Reading'
    : 'Storybook Reader'

  return (
    <div className={styles.shell}>
      {/* ── Desktop sidebar ── */}
      <aside className={styles.sidebar} aria-label="Main navigation">
        <div className={styles.brand}>
          <p className="eyebrow">Storybook Reader</p>
          <h1>Your library.</h1>
        </div>

        <nav className={styles.nav} aria-label="Sections">
          {NAV_ITEMS.map((item) => (
            <NavLink className={navClass} key={item.to} to={item.to}>
              <span className={styles.navIcon} aria-hidden>{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className={styles.sidebarFooter}>
          <NavLink className={navClass} to="/upload">
            <span className={styles.navIcon} aria-hidden>↑</span>
            Upload PDF
          </NavLink>
          <NavLink className={navClass} to="/settings/audio">
            <span className={styles.navIcon} aria-hidden>🔊</span>
            Audio settings
          </NavLink>
        </div>
      </aside>

      {/* ── Main column ── */}
      <div className={styles.mainColumn}>
        {/* Mobile top bar */}
        <header className={`${styles.mobileHeader} ${location.pathname.startsWith('/book/') ? styles.mobileHeaderHidden : ''}`}>
          <span className={styles.mobileTitle}>{pageTitle}</span>
          <div className={styles.mobileHeaderActions}>
            <NavLink className={styles.mobileAction} to="/upload">↑</NavLink>
            <NavLink className={styles.mobileAction} to="/settings/audio">🔊</NavLink>
          </div>
        </header>

        <main className={styles.main}>
          <AnimatePresence mode="wait">
            <motion.div key={location.pathname} {...routeMotion} className={styles.routeFrame}>
              <Outlet />
            </motion.div>
          </AnimatePresence>
        </main>
      </div>

      {/* ── Mobile bottom navigation ── */}
      <nav className={styles.bottomNav} aria-label="Mobile navigation">
        {NAV_ITEMS.map((item) => (
          <NavLink className={bottomNavClass} key={item.to} to={item.to}>
            <span className={styles.bottomNavIcon} aria-hidden>{item.icon}</span>
            <span className={styles.bottomNavLabel}>{item.label}</span>
          </NavLink>
        ))}
      </nav>

      <AudioDock />
    </div>
  )
}
