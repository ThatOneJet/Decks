/**
 * Home — the new-tab surface (view === 'home'), inside the floating page card,
 * dressed in the "Console" launcher look.
 *
 * On mount calls window.decks.panel.hideAll() so no WebContentsView covers it.
 * A futuristic grid + orb backdrop, the Decks wordmark, the big ⌘K "jump
 * anywhere" search affordance (click → openPalette), and quick-launch chips for
 * the first few workspaces.
 */
import { useEffect } from 'react'
import { useStore } from '../store'
import Logo from './Logo'
import { faviconFor } from '../lib/favicon'
import { modCombo, MOD } from '../lib/platform'

function Home(): JSX.Element {
  const openPalette = useStore((s) => s.openPalette)
  const workspaces = useStore((s) => s.workspaces)
  const activateWorkspace = useStore((s) => s.activateWorkspace)

  // Detach every panel view so this pure-renderer surface is fully visible.
  useEffect(() => {
    window.decks?.panel.hideAll()
  }, [])

  const quick = workspaces.slice(0, 6)

  return (
    <div className="page-area workspace">
      <div className="page-card">
        <div className="home">
          <div className="home-grid hgrid" />
          <div className="home-orb horb" />
          <div className="home-wm hwm">
            <Logo size={42} />
            <h1 className="glow-text">Decks</h1>
          </div>
          <div className="home-sub hsub">Every app you use, one labeled keystroke away.</div>
          <button className="home-search hjump glass no-drag" onClick={openPalette}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="7" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <span className="ph">Search decks or run a command…</span>
            <span className="kbd">{modCombo('K')}</span>
          </button>

          {quick.length > 0 && (
            <div className="home-quick hquick no-drag">
              {quick.map((w) => {
                const primary = w.panels[0]
                const isNative = primary?.kind === 'native'
                const icon = primary && !isNative ? primary.favicon || faviconFor(primary.url) : ''
                return (
                  <button
                    key={w.id}
                    className="quick-add"
                    onClick={() => activateWorkspace(w.id)}
                    style={{ padding: '8px 13px 8px 8px' }}
                  >
                    <span className="qi" style={{ width: 22, height: 22 }}>
                      {icon ? <img src={icon} alt="" draggable={false} /> : <span>{w.glyph ?? '◻'}</span>}
                    </span>
                    {w.name}
                    {primary && (
                      <span className={`tkind ${isNative ? 'native' : 'web'}`} style={{ marginLeft: 4 }}>
                        {isNative ? 'native' : 'web'}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          )}

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
            <span>
              <span className="kbd">?</span> help & tour
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

export default Home
