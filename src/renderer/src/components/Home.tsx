/**
 * Home — the new-tab/home surface (shown when view==='home').
 *
 * On mount calls window.decks.panel.hideAll() so no WebContentsView covers it.
 * Centers a large ⌘K "jump anywhere" search affordance (click → openPalette())
 * with the Decks wordmark + subtitle, over ONE animated background
 * (AnimatedBackground — the only looping animation in the app).
 *
 * No props (reads/acts via the store + window.decks).
 */
import { useEffect } from 'react'
import { useStore } from '../store'
import AnimatedBackground from './home/AnimatedBackground'
import Logo from './Logo'
import { MOD, modCombo } from '../lib/platform'

function Home(): JSX.Element {
  const openPalette = useStore((s) => s.openPalette)

  // Detach every panel view so this pure-renderer surface is fully visible.
  useEffect(() => {
    window.decks?.panel.hideAll()
  }, [])

  return (
    <div className="relative flex h-full w-full flex-col items-center justify-center overflow-hidden bg-bg px-6">
      <AnimatedBackground />

      {/* Wordmark + subtitle */}
      <div className="mb-8 flex flex-col items-center text-center">
        <div className="flex items-center gap-2.5">
          <Logo size={38} />
          <h1 className="text-3xl font-semibold tracking-tight text-txt-1">Decks</h1>
        </div>
        <p className="mt-3 text-sm text-txt-3">
          Your workspaces, one keystroke away.
        </p>
      </div>

      {/* ⌘K jump-anywhere affordance */}
      <button
        onClick={openPalette}
        className="no-drag group flex w-full max-w-md items-center gap-3 rounded-xl2 border border-line bg-bg-panel/80 px-5 py-4 text-left backdrop-blur transition-colors hover:border-accent-ring hover:bg-bg-elevated/80"
      >
        <svg
          className="h-5 w-5 shrink-0 text-txt-3 transition-colors group-hover:text-txt-2"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <circle cx="11" cy="11" r="7" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <span className="flex-1 text-base text-txt-2 group-hover:text-txt-1">
          Jump anywhere…
        </span>
        <kbd className="flex items-center gap-1 rounded-md border border-line bg-bg-elevated px-2 py-1 font-mono text-xs text-txt-3">
          {modCombo('K')}
        </kbd>
      </button>

      <p className="mt-6 text-xs text-txt-4">
        Press <span className="font-mono text-txt-3">{modCombo('K')}</span> to search ·{' '}
        <span className="font-mono text-txt-3">{MOD === '⌘' ? '⌘N' : 'Ctrl+N'}</span> to add a deck
      </p>
    </div>
  )
}

export default Home
