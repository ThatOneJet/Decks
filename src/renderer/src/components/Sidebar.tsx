/**
 * Sidebar — STUB. Owned by the "Sidebar + workspace rail" Phase 1 agent, which
 * overwrites this file. Contract: reads `useStore` (workspaces, activeWorkspaceId,
 * view), calls activateWorkspace(id)/goHome(); renders the left rail from the
 * target image (live-state dot, panel count/unread/paused subtitle, active accent,
 * "add panel" affordance). No props.
 */
import { useStore } from '../store'

function Sidebar(): JSX.Element {
  const workspaces = useStore((s) => s.workspaces)
  const activeId = useStore((s) => s.activeWorkspaceId)
  const activate = useStore((s) => s.activateWorkspace)
  return (
    <aside className="flex w-56 shrink-0 flex-col gap-1 border-r border-line bg-bg-rail p-3">
      <div className="px-1 pb-2 text-[11px] uppercase tracking-wider text-txt-3">workspaces</div>
      {workspaces.map((w) => (
        <button
          key={w.id}
          onClick={() => activate(w.id)}
          className={`rounded-xl2 px-3 py-2 text-left text-sm ${
            activeId === w.id ? 'bg-accent-soft text-txt-1' : 'text-txt-2 hover:bg-bg-elevated'
          }`}
        >
          <div className="font-medium">{w.name}</div>
          <div className="text-xs text-txt-3">{w.subtitle}</div>
        </button>
      ))}
    </aside>
  )
}

export default Sidebar
