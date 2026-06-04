/**
 * CommandPalette — STUB. Owned by the "Command palette (Cmd+K)" Phase 1 agent.
 *
 * Contract: a centered overlay shown when `useStore().paletteOpen`. Fuzzy search
 * over workspaces + pinned sites + saved commands (build the CommandItem[] from
 * the store's workspaces plus a small pinned list). Enter on a workspace calls
 * activateWorkspace(id); on a pinned-site opens/creates a panel. Esc/click-out
 * closes (App.tsx already wires the global ⌘K/Esc keys → toggle/close). No props.
 */
import { useStore } from '../store'

function CommandPalette(): JSX.Element | null {
  const open = useStore((s) => s.paletteOpen)
  const close = useStore((s) => s.closePalette)
  const workspaces = useStore((s) => s.workspaces)
  const activate = useStore((s) => s.activateWorkspace)
  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-32"
      onClick={close}
    >
      <div
        className="w-[min(560px,90vw)] overflow-hidden rounded-xl2 border border-line bg-bg-elevated shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          placeholder="Jump anywhere…"
          className="w-full bg-transparent px-4 py-3 text-sm text-txt-1 outline-none placeholder:text-txt-3"
        />
        <div className="max-h-72 overflow-y-auto border-t border-line">
          {workspaces.map((w) => (
            <button
              key={w.id}
              onClick={() => {
                activate(w.id)
                close()
              }}
              className="block w-full px-4 py-2 text-left text-sm text-txt-2 hover:bg-accent-soft"
            >
              {w.name} <span className="text-txt-3">· {w.subtitle}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

export default CommandPalette
