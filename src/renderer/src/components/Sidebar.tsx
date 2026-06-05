/**
 * Sidebar — the vertical icon rail (Opera-GX / Discord style).
 *
 * A narrow strip of rounded-square tiles, one per workspace, each showing the
 * favicon/logo of the site it leads to. Active tile morphs to a squircle with an
 * accent pill; unread workspaces show a count badge. Bottom: "+" (add a deck via
 * the palette) and a Home button. No props (reads the store).
 */
import { useStore } from '../store'
import RailTile from './sidebar/WorkspaceItem'

function Sidebar(): JSX.Element {
  const workspaces = useStore((s) => s.workspaces)
  const activeId = useStore((s) => s.activeWorkspaceId)
  const view = useStore((s) => s.view)
  const activate = useStore((s) => s.activateWorkspace)
  const goHome = useStore((s) => s.goHome)
  const openPalette = useStore((s) => s.openPalette)

  return (
    <aside className="flex w-[72px] shrink-0 flex-col items-center gap-2 border-r border-line bg-bg-rail py-3">
      {/* Workspaces */}
      <nav className="flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto">
        {workspaces.map((w) => (
          <RailTile
            key={w.id}
            workspace={w}
            active={view === 'workspace' && w.id === activeId}
            onClick={() => activate(w.id)}
          />
        ))}
      </nav>

      {/* Divider */}
      <div className="my-1 h-px w-8 bg-line" />

      {/* Add a deck (opens the ⌘K palette to pick a site) */}
      <button
        onClick={openPalette}
        title="Add a deck"
        className="grid h-11 w-11 place-items-center rounded-2xl border border-line bg-bg-panel text-xl text-txt-3 transition-all hover:rounded-xl hover:border-accent-ring hover:text-accent"
      >
        +
      </button>

      {/* Home */}
      <button
        onClick={goHome}
        title="Home"
        className={`grid h-11 w-11 place-items-center rounded-2xl border transition-all hover:rounded-xl ${
          view === 'home'
            ? 'border-accent-ring bg-accent-soft text-accent'
            : 'border-line bg-bg-panel text-txt-3 hover:text-txt-1'
        }`}
      >
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 11l9-8 9 8" />
          <path d="M5 10v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V10" />
        </svg>
      </button>
    </aside>
  )
}

export default Sidebar
