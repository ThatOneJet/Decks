/**
 * Sidebar — the ~220px dark left rail listing every workspace.
 *
 * Reads `useStore` for { workspaces, activeWorkspaceId, view } and calls
 * activateWorkspace(id) on row click. A row is rendered "active" only when it
 * is the selected workspace AND the right region is showing the workspace view
 * (view === 'workspace'); when view === 'home' nothing is highlighted.
 *
 * Renders each row via <WorkspaceItem> (glyph chip + name + subtitle + live
 * dot) and an "+ add panel" affordance pinned to the bottom.
 *
 * No props.
 */
import { useStore } from '../store'
import WorkspaceItem from './sidebar/WorkspaceItem'

function Sidebar(): JSX.Element {
  const workspaces = useStore((s) => s.workspaces)
  const activeId = useStore((s) => s.activeWorkspaceId)
  const view = useStore((s) => s.view)
  const activate = useStore((s) => s.activateWorkspace)

  // TODO(Phase 2): wire this to panel creation (e.g. add a panel to the active
  // workspace via window.decks + store.addPanel). No-op for now.
  const handleAddPanel = (): void => {
    /* intentionally empty — Phase 2 connects panel creation */
  }

  return (
    <aside className="flex w-[220px] shrink-0 flex-col border-r border-line bg-bg-rail">
      <div className="px-4 pb-2 pt-4 text-[11px] font-medium uppercase tracking-[0.14em] text-txt-3">
        workspaces
      </div>

      {/* Workspace list. */}
      <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2 py-1">
        {workspaces.length === 0 ? (
          <div className="px-2.5 py-2 text-xs text-txt-4">No workspaces yet</div>
        ) : (
          workspaces.map((w) => (
            <WorkspaceItem
              key={w.id}
              workspace={w}
              active={view === 'workspace' && w.id === activeId}
              onActivate={activate}
            />
          ))
        )}
      </nav>

      {/* + add panel — bottom affordance. */}
      <div className="p-2">
        <button
          type="button"
          onClick={handleAddPanel}
          className="flex w-full items-center justify-center gap-1.5 rounded-xl2 border border-dashed border-line px-3 py-2 text-sm text-txt-3 transition-colors hover:border-accent-ring hover:bg-bg-elevated hover:text-txt-1"
        >
          <span className="text-base leading-none">+</span>
          <span>add panel</span>
        </button>
      </div>
    </aside>
  )
}

export default Sidebar
