/**
 * Topbar — the redesign chrome bar above the floating page card.
 *
 * Left: back/forward for the active deck. Center: an "omni" context pill showing
 * the active deck's icon, name·url, and a Native/Web kind chip. Right: an always-
 * visible ⌘K search affordance and the window controls. The bar is the OS drag
 * region; interactive bits opt out via `.no-drag`.
 *
 * Functionality preserved from the old titlebar (nav, window controls); the look
 * and the omni/⌘K/kind-chip discoverability come from the redesign.
 */
import { useStore } from '../store'
import { faviconFor, hostOf } from '../lib/favicon'
import { modCombo } from '../lib/platform'

function Topbar(): JSX.Element {
  const view = useStore((s) => s.view)
  const ws = useStore((s) => s.activeWorkspace())
  const openPalette = useStore((s) => s.openPalette)
  const primary = ws?.panels[0]
  const onWorkspace = view === 'workspace' && !!primary
  const isNative = primary?.kind === 'native'

  const icon = primary && !isNative ? primary.favicon || faviconFor(primary.url) : ''
  const urlText = isNative ? (primary?.provider ?? 'native') : hostOf(primary?.url ?? '')

  const back = (): void => {
    if (primary) window.decks?.panel.goBack(primary.id)
  }
  const fwd = (): void => {
    if (primary) window.decks?.panel.goForward(primary.id)
  }

  return (
    <header className="topbar drag">
      {/* Left: nav arrows */}
      <div className="row no-drag" style={{ gap: 2 }}>
        <button
          onClick={back}
          disabled={!onWorkspace}
          aria-label="Back"
          className={`nav-btn ${!primary?.canGoBack ? 'dim' : ''}`}
        >
          <svg viewBox="0 0 24 24" width={17} height={17} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <button
          onClick={fwd}
          disabled={!onWorkspace}
          aria-label="Forward"
          className={`nav-btn ${!primary?.canGoForward ? 'dim' : ''}`}
        >
          <svg viewBox="0 0 24 24" width={17} height={17} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 18l6-6-6-6" />
          </svg>
        </button>
      </div>

      {/* Omni / context pill */}
      <div className="omni">
        <span className="fav">
          {icon ? (
            <img src={icon} alt="" draggable={false} />
          ) : (
            <span className="grid h-full w-full place-items-center text-xs">{ws?.glyph ?? '▦'}</span>
          )}
        </span>
        <span className="url">
          {view === 'home' ? (
            <b>Home</b>
          ) : view === 'settings' ? (
            <b>Settings</b>
          ) : (
            <>
              <b>{ws?.name}</b>
              {urlText ? <> · {urlText}</> : null}
            </>
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
          >
            <span className="dot" />
            {isNative ? 'Native' : 'Web'}
          </span>
        )}
      </div>

      {/* ⌘K affordance — always visible so the palette is never hidden */}
      <button className="cmdk no-drag" onClick={openPalette} title="Search · run command">
        <svg viewBox="0 0 24 24" width={15} height={15} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="7" />
          <path d="m21 21-4.3-4.3" />
        </svg>
        <span>Search</span>
        <span className="kbd">{modCombo('K')}</span>
      </button>

      {/* Window controls */}
      <div className="win-ctrl no-drag">
        <button onClick={() => window.decks?.window.minimize()} aria-label="Minimize" className="win-btn">
          <svg viewBox="0 0 24 24" width={15} height={15} stroke="currentColor" strokeWidth="2"><path d="M5 12h14" /></svg>
        </button>
        <button onClick={() => window.decks?.window.maximize()} aria-label="Maximize" className="win-btn">
          <svg viewBox="0 0 24 24" width={13} height={13} fill="none" stroke="currentColor" strokeWidth="2"><rect x="5" y="5" width="14" height="14" rx="2" /></svg>
        </button>
        <button onClick={() => window.decks?.window.close()} aria-label="Close" className="win-btn close">
          <svg viewBox="0 0 24 24" width={15} height={15} stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </div>
    </header>
  )
}

export default Topbar
