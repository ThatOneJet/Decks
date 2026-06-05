/**
 * Titlebar — Discord-style frameless chrome.
 *
 * Left: back/forward arrows that navigate the active workspace's primary deck.
 * Center: the active workspace's icon + name (or "Home"). Right: window controls
 * (minimize / maximize / close). The bar is the OS drag region; interactive bits
 * opt out via `.no-drag`.
 */
import type { ReactNode } from 'react'
import { useStore } from '../store'
import { faviconFor } from '../lib/favicon'

function NavButton({
  onClick,
  disabled,
  dim,
  label,
  children
}: {
  onClick: () => void
  disabled?: boolean
  /** No history in that direction — clickable but visually muted. */
  dim?: boolean
  label: string
  children: ReactNode
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={`no-drag grid h-6 w-6 place-items-center rounded-md transition-colors enabled:hover:bg-bg-elevated enabled:hover:text-txt-1 disabled:opacity-20 ${
        dim ? 'text-txt-4' : 'text-txt-2'
      }`}
    >
      {children}
    </button>
  )
}

function Titlebar(): JSX.Element {
  const view = useStore((s) => s.view)
  const ws = useStore((s) => s.activeWorkspace())
  const primary = ws?.panels[0]
  const onWorkspace = view === 'workspace' && !!primary

  const title = view === 'home' || !ws ? 'Home' : ws.name
  const icon = primary ? primary.favicon || faviconFor(primary.url) : ''

  const back = (): void => {
    if (primary) window.decks?.panel.goBack(primary.id)
  }
  const fwd = (): void => {
    if (primary) window.decks?.panel.goForward(primary.id)
  }

  return (
    <header className="drag flex h-8 shrink-0 items-center justify-between bg-bg-rail px-2">
      {/* Left: nav arrows */}
      <div className="flex items-center gap-1">
        <NavButton onClick={back} disabled={!onWorkspace} dim={!primary?.canGoBack} label="Back">
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </NavButton>
        <NavButton onClick={fwd} disabled={!onWorkspace} dim={!primary?.canGoForward} label="Forward">
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 18l6-6-6-6" />
          </svg>
        </NavButton>
      </div>

      {/* Center: title */}
      <div className="pointer-events-none absolute left-1/2 flex -translate-x-1/2 items-center gap-2">
        {icon ? (
          <img src={icon} alt="" className="h-4 w-4 rounded-sm object-contain" draggable={false} />
        ) : (
          <span className="text-sm">{ws?.glyph ?? '🗂'}</span>
        )}
        <span className="text-sm font-medium text-txt-1">{title}</span>
      </div>

      {/* Right: window controls */}
      <div className="no-drag flex items-center gap-0.5">
        <button
          onClick={() => window.decks?.window.minimize()}
          aria-label="Minimize"
          className="grid h-6 w-8 place-items-center rounded-md text-txt-3 hover:bg-bg-elevated hover:text-txt-1"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" stroke="currentColor" strokeWidth="2"><path d="M5 12h14" /></svg>
        </button>
        <button
          onClick={() => window.decks?.window.maximize()}
          aria-label="Maximize"
          className="grid h-6 w-8 place-items-center rounded-md text-txt-3 hover:bg-bg-elevated hover:text-txt-1"
        >
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2"><rect x="4" y="4" width="16" height="16" rx="2" /></svg>
        </button>
        <button
          onClick={() => window.decks?.window.close()}
          aria-label="Close"
          className="grid h-6 w-8 place-items-center rounded-md text-txt-3 hover:bg-err hover:text-white"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </div>
    </header>
  )
}

export default Titlebar
