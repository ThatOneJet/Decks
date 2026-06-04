/**
 * Home — STUB. Owned by the "Home + split view + motion" Phase 1 agent.
 * Contract: the new-tab/home surface — ONE React Bits animated background
 * (Tailwind variant, installed via its CLI) behind a centered Cmd+K bar.
 * Calls window.decks.panel.hideAll() on mount so no web view covers it.
 * No props.
 */
import { useStore } from '../store'

function Home(): JSX.Element {
  const openPalette = useStore((s) => s.openPalette)
  return (
    <div className="flex h-full w-full items-center justify-center bg-bg">
      <button
        onClick={openPalette}
        className="rounded-xl2 border border-line bg-bg-panel px-6 py-3 text-txt-2 hover:border-accent-ring"
      >
        Press ⌘K to jump anywhere
      </button>
    </div>
  )
}

export default Home
