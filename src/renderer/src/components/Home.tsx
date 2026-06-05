/**
 * Home — the new-tab surface (view === 'home'), inside the floating page card.
 *
 * On mount calls window.decks.panel.hideAll() so no WebContentsView covers it.
 * A futuristic grid + orb backdrop, the Decks wordmark, and a large ⌘K
 * "jump anywhere" search affordance (click → openPalette).
 */
import { useEffect } from 'react'
import { useStore } from '../store'
import Logo from './Logo'
import { modCombo, MOD } from '../lib/platform'

function Home(): JSX.Element {
  const openPalette = useStore((s) => s.openPalette)

  // Detach every panel view so this pure-renderer surface is fully visible.
  useEffect(() => {
    window.decks?.panel.hideAll()
  }, [])

  return (
    <div className="page-area">
      <div className="page-card">
        <div className="home">
          <div className="home-grid" />
          <div className="home-orb" />
          <div className="home-wm">
            <Logo size={42} />
            <h1 className="glow-text">Decks</h1>
          </div>
          <div className="home-sub">Every app you use, one keystroke away.</div>
          <button className="home-search glass no-drag" onClick={openPalette}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="7" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <span className="ph">Jump to a deck or run a command…</span>
            <span className="kbd">{modCombo('K')}</span>
          </button>
          <div className="home-tip">
            <span>
              <span className="kbd">{modCombo('K')}</span> search
            </span>
            <span>
              <span className="kbd">{MOD === '⌘' ? '⌘N' : 'Ctrl+N'}</span> add a deck
            </span>
            <span>
              <span className="kbd">{MOD === '⌘' ? '⌘.' : 'Ctrl+.'}</span> focus mode
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

export default Home
