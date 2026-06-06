/**
 * Header — the full-width Console chrome bar across the top of the shell.
 *
 * Left: the brand mark + "Decks" name. Center: the always-visible command bar
 * (`.cmdbar`) that opens the palette and shows the active deck context. Right:
 * a Focus toggle, the Memory pill (opens the memory manager), Help, and the OS
 * window controls. The whole bar is the OS drag region; interactive bits opt
 * out via `.no-drag` (and `-webkit-app-region` via the Console CSS classes).
 *
 * All real wiring is preserved: openPalette, openMemory, openHelp,
 * window.decks.window.*, deck back/forward nav, and the Native/Web kind chip.
 */
import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { hostOf } from '../lib/favicon'
import { modCombo } from '../lib/platform'
import Logo from './Logo'

/**
 * The current page as host + path (e.g. `instagram.com/reels`), not just the
 * hostname — so the command bar reflects exactly where the deck is. Strips the
 * protocol, a leading `www.`, and a trailing slash; keeps the path + query.
 */
function prettyUrl(url: string): string {
  try {
    const u = new URL(url)
    const host = u.hostname.replace(/^www\./, '')
    const path = (u.pathname + u.search).replace(/\/$/, '')
    return host + path
  } catch {
    return hostOf(url)
  }
}

/** Tiny animated equaliser for the memory pill — purely decorative. */
function MemSpark(): JSX.Element {
  const [bars, setBars] = useState([7, 11, 6, 13, 9])
  useEffect(() => {
    const id = setInterval(
      () => setBars((b) => b.map(() => 5 + Math.round(Math.random() * 11))),
      1600
    )
    return () => clearInterval(id)
  }, [])
  return (
    <span className="spark">
      {bars.map((h, i) => (
        <i key={i} style={{ height: h }} />
      ))}
    </span>
  )
}

function Header(): JSX.Element {
  const view = useStore((s) => s.view)
  const ws = useStore((s) => s.activeWorkspace())
  const openPalette = useStore((s) => s.openPalette)
  const openHelp = useStore((s) => s.openHelp)
  const openMemory = useStore((s) => s.openMemory)
  const focusMode = useStore((s) => s.focusMode)
  const toggleFocusMode = useStore((s) => s.toggleFocusMode)
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useStore((s) => s.toggleSidebar)
  const openFeedback = useStore((s) => s.openFeedback)

  // Live memory readout for the pill — real working-set RAM + live/idle counts.
  const [mem, setMem] = useState<{ ramMB: number; live: number; discarded: number } | null>(null)
  useEffect(() => {
    let alive = true
    const poll = async (): Promise<void> => {
      const m = await window.decks?.metrics.get().catch(() => null)
      if (alive && m) setMem({ ramMB: m.ramMB, live: m.liveRenderers, discarded: m.discarded })
    }
    void poll()
    const id = setInterval(poll, 2500)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [])

  const primary = ws?.panels[0]
  const onWorkspace = view === 'workspace' && !!primary
  const isNative = primary?.kind === 'native'

  const urlText = isNative ? (primary?.provider ?? 'native') : prettyUrl(primary?.url ?? '')

  const back = (): void => {
    if (primary) window.decks?.panel.goBack(primary.id)
  }
  const fwd = (): void => {
    if (primary) window.decks?.panel.goForward(primary.id)
  }

  return (
    <header className="header drag">
      {/* Brand */}
      <div className="brand no-drag">
        <Logo size={28} />
        <span className="bname">Decks</span>
      </div>

      {/* Left: collapse the sidebar + nav arrows for the active deck */}
      <div className="row no-drag" style={{ display: 'flex', gap: 2 }}>
        <button
          onClick={toggleSidebar}
          aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="winbtn"
          title={sidebarCollapsed ? 'Expand sidebar (Ctrl/⌘+B)' : 'Collapse sidebar (Ctrl/⌘+B)'}
        >
          <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M9 4v16" />
            {sidebarCollapsed ? <path d="M14 10l2 2-2 2" /> : <path d="M16 10l-2 2 2 2" />}
          </svg>
        </button>
        <button
          onClick={back}
          disabled={!onWorkspace}
          aria-label="Back"
          className={`winbtn ${!primary?.canGoBack ? 'dim' : ''}`}
          title="Back"
        >
          <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <button
          onClick={fwd}
          disabled={!onWorkspace}
          aria-label="Forward"
          className={`winbtn ${!primary?.canGoForward ? 'dim' : ''}`}
          title="Forward"
        >
          <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 18l6-6-6-6" />
          </svg>
        </button>
      </div>

      {/* Feedback — send a suggestion or bug report straight to the dev. */}
      <button
        onClick={openFeedback}
        aria-label="Send feedback"
        className="winbtn no-drag"
        title="Send feedback — suggestion or bug report"
      >
        <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 18h6" />
          <path d="M10 22h4" />
          <path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.2 1 2h6c0-.8.4-1.5 1-2A7 7 0 0 0 12 2Z" />
        </svg>
      </button>

      {/* Command bar — the centerpiece; opens the palette. */}
      <div className="cmdbar no-drag" onClick={openPalette} title="Search · run command">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="7" />
          <path d="m21 21-4.3-4.3" />
        </svg>
        <span className="ph">
          {view === 'workspace' && primary ? (
            <>
              <b>{ws?.name}</b>
              {urlText ? ` · ${urlText}` : ''} — search decks or run a command
            </>
          ) : view === 'settings' ? (
            <>
              <b>Settings</b> — search decks or run a command
            </>
          ) : view === 'home' ? (
            <>
              <b>Home</b> — search decks or run a command
            </>
          ) : (
            'Search decks or run a command…'
          )}
        </span>
        {onWorkspace && (
          <span
            className={`kind-chip ${isNative ? 'native' : 'web'}`}
            title={
              isNative
                ? 'Native deck — Decks renders its own UI on the app’s API. No browser engine = far less RAM.'
                : 'Web deck — a sandboxed embedded page with persistent login.'
            }
            style={{ flex: 'none' }}
          >
            <span className="dot" />
            {isNative ? 'Native' : 'Web'}
          </span>
        )}
        <span className="kbd-grp">
          <span className="kbd">{modCombo('K')}</span>
        </span>
      </div>

      {/* Right: focus toggle, memory pill, help, window controls */}
      <div className="head-right no-drag">
        <button
          className={`hbtn ${focusMode ? 'on' : ''}`}
          onClick={toggleFocusMode}
          title={`Focus mode (${modCombo('.')})`}
        >
          <svg viewBox="0 0 24 24" width={15} height={15} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" />
          </svg>
          <span>Focus</span>
        </button>

        <button
          className="mempill"
          onClick={openMemory}
          title={mem ? `${mem.ramMB} MB · ${mem.live} live · ${mem.discarded} idle` : 'Memory manager'}
        >
          <MemSpark />
          <span className="mtxt">
            {mem ? `${mem.ramMB} MB` : 'Memory'}
            {mem && (
              <s>
                {mem.live} live · {mem.discarded} idle
              </s>
            )}
          </span>
        </button>

        <button className="hbtn icon" onClick={openHelp} title="Help & shortcuts (?)" aria-label="Help">
          <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9" />
            <path d="M9.5 9a2.5 2.5 0 1 1 3 2.4c-.6.2-1 .8-1 1.6M12 17h.01" />
          </svg>
        </button>

        <div className="winbtns">
          <button className="winbtn" onClick={() => window.decks?.window.minimize()} aria-label="Minimize" title="Minimize">
            <svg viewBox="0 0 24 24" width={14} height={14} stroke="currentColor" strokeWidth="2"><path d="M5 12h14" /></svg>
          </button>
          <button className="winbtn" onClick={() => window.decks?.window.maximize()} aria-label="Maximize" title="Maximize">
            <svg viewBox="0 0 24 24" width={12} height={12} fill="none" stroke="currentColor" strokeWidth="2"><rect x="5" y="5" width="14" height="14" rx="2" /></svg>
          </button>
          <button className="winbtn x" onClick={() => window.decks?.window.close()} aria-label="Close" title="Close">
            <svg viewBox="0 0 24 24" width={14} height={14} stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
      </div>
    </header>
  )
}

export default Header
