/**
 * Sidebar — vertical icon rail. Tiles per workspace (favicon of the site),
 * native right-click menu (rename / reset / note / delete), "+" to add ANY site
 * by link, and Home.
 */
import { useEffect, useState } from 'react'
import { useStore } from '../store'
import RailTile from './sidebar/WorkspaceItem'
import WorkspaceEditModal from './sidebar/WorkspaceEditModal'
import AddDeckModal from './AddDeckModal'
import { MOD } from '../lib/platform'
import { templateFor, workspaceFromTemplate } from '@shared/seed'
import type { Workspace, LayoutNode } from '@shared/types'

const EMPTY_LAYOUT: LayoutNode = { type: 'leaf', panelId: '' }

function Sidebar(): JSX.Element {
  const workspaces = useStore((s) => s.workspaces)
  const activeId = useStore((s) => s.activeWorkspaceId)
  const view = useStore((s) => s.view)
  const activate = useStore((s) => s.activateWorkspace)
  const goHome = useStore((s) => s.goHome)
  const removeWorkspace = useStore((s) => s.removeWorkspace)
  const setDecks = useStore((s) => s.setDecks)
  const addDeckOpen = useStore((s) => s.addDeckOpen)
  const openAddDeck = useStore((s) => s.openAddDeck)
  const closeAddDeck = useStore((s) => s.closeAddDeck)

  const [edit, setEdit] = useState<{ ws: Workspace; mode: 'rename' | 'note' } | null>(null)

  // Native menu choices come back here.
  useEffect(() => {
    const off = window.decks?.onWorkspaceMenuAction(({ workspaceId, action }) => {
      const ws = useStore.getState().workspaces.find((w) => w.id === workspaceId)
      if (!ws) return
      if (action === 'rename') setEdit({ ws, mode: 'rename' })
      else if (action === 'note') setEdit({ ws, mode: 'note' })
      else if (action === 'reset') {
        ws.panels.forEach((p) => window.decks?.panel.destroy(p.id))
        const t = templateFor(ws.id)
        if (t) {
          const fresh = workspaceFromTemplate(t)
          setDecks(ws.id, fresh.panels, fresh.layout)
        } else {
          setDecks(ws.id, [], EMPTY_LAYOUT)
        }
      } else if (action === 'delete') {
        ws.panels.forEach((p) => window.decks?.panel.destroy(p.id))
        removeWorkspace(ws.id)
      }
    })
    return () => off?.()
  }, [removeWorkspace, setDecks])

  return (
    <aside className="flex w-[72px] shrink-0 flex-col items-center gap-2 bg-bg-rail py-3">
      <nav className="flex min-h-0 flex-1 flex-col items-center gap-2.5 overflow-y-auto overflow-x-visible px-1">
        {workspaces.map((w) => (
          <RailTile
            key={w.id}
            workspace={w}
            active={view === 'workspace' && w.id === activeId}
            onClick={() => activate(w.id)}
          />
        ))}
      </nav>

      <div className="my-0.5 h-px w-7 bg-line/70" />

      <button
        onClick={openAddDeck}
        title={`Add a deck (${MOD === '⌘' ? '⌘N' : 'Ctrl+N'})`}
        className="grid h-11 w-11 place-items-center rounded-2xl bg-bg-elevated text-2xl font-light leading-none text-txt-3 transition-all duration-150 hover:rounded-xl hover:bg-accent-soft hover:text-accent"
      >
        +
      </button>

      <button
        onClick={goHome}
        title="Home"
        className={`grid h-11 w-11 place-items-center rounded-2xl transition-all duration-150 hover:rounded-xl ${
          view === 'home' ? 'bg-accent-soft text-accent' : 'bg-bg-elevated text-txt-3 hover:text-txt-1'
        }`}
      >
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 11l9-8 9 8" />
          <path d="M5 10v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V10" />
        </svg>
      </button>

      {edit && <WorkspaceEditModal workspace={edit.ws} mode={edit.mode} onClose={() => setEdit(null)} />}
      {addDeckOpen && <AddDeckModal onClose={closeAddDeck} />}
    </aside>
  )
}

export default Sidebar
