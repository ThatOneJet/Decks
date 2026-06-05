/**
 * Sidebar — vertical icon rail. Tiles per workspace (favicon of the site),
 * native right-click menu (rename / reset / note / delete), "+" to add ANY site
 * by link, and Home.
 */
import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import type { MetricsResult } from '@shared/ipc'
import RailTile, { DECKS_WS_DND } from './sidebar/WorkspaceItem'
import RailFolder from './sidebar/RailFolder'
import WorkspaceEditModal from './sidebar/WorkspaceEditModal'
import AddDeckModal from './AddDeckModal'
import { MOD } from '../lib/platform'
import { templateFor, workspaceFromTemplate } from '@shared/seed'
import type { Workspace, LayoutNode } from '@shared/types'

/**
 * Build the rail's render order: ungrouped workspaces stay in place; each group
 * collapses into a single "folder" entry rendered at the position of its FIRST
 * member, carrying that group's members in workspace order.
 */
type RailEntry =
  | { kind: 'tile'; ws: Workspace }
  | { kind: 'folder'; name: string; members: Workspace[] }

function buildRail(workspaces: Workspace[]): RailEntry[] {
  const entries: RailEntry[] = []
  const seenGroups = new Set<string>()
  for (const w of workspaces) {
    if (w.group) {
      if (seenGroups.has(w.group)) continue
      seenGroups.add(w.group)
      entries.push({
        kind: 'folder',
        name: w.group,
        members: workspaces.filter((x) => x.group === w.group)
      })
    } else {
      entries.push({ kind: 'tile', ws: w })
    }
  }
  return entries
}

const EMPTY_LAYOUT: LayoutNode = { type: 'leaf', panelId: '' }

/**
 * Quiet RAM/process readout pinned at the very bottom of the rail. Polls the
 * main process every ~3s: total working-set RAM (MB) and how many panel
 * renderers are live vs discarded. Compact, two tiny stacked lines — not a
 * dashboard. Matches the rail's dark tokens.
 */
function RamMeter(): JSX.Element | null {
  const [m, setM] = useState<MetricsResult | null>(null)

  useEffect(() => {
    let alive = true
    const poll = async (): Promise<void> => {
      const next = await window.decks?.metrics.get().catch(() => null)
      if (alive && next) setM(next)
    }
    void poll()
    const id = setInterval(poll, 3000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [])

  if (!m) return null
  return (
    <div
      title={`${m.ramMB} MB · ${m.liveRenderers} live / ${m.discarded} discarded`}
      className="flex w-11 flex-col items-center rounded-lg bg-bg-elevated px-1 py-1 text-center leading-tight"
    >
      <span className="text-[10px] font-medium tabular-nums text-txt-3">{m.ramMB} MB</span>
      <span className="text-[9px] tabular-nums text-txt-4">
        {m.liveRenderers} live · {m.discarded} disc
      </span>
    </div>
  )
}

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
  const setGroup = useStore((s) => s.setGroup)
  const renameGroup = useStore((s) => s.renameGroup)
  const nextGroupName = useStore((s) => s.nextGroupName)

  const [edit, setEdit] = useState<{ ws: Workspace; mode: 'rename' | 'note' } | null>(null)
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({})
  const [clearOver, setClearOver] = useState(false)

  const rail = useMemo(() => buildRail(workspaces), [workspaces])

  const toggleGroup = (name: string): void =>
    setOpenGroups((s) => ({ ...s, [name]: !s[name] }))

  /** Drop `draggedId` onto the tile/group of `targetId`: create or join a group. */
  const dropOntoTile = (draggedId: string, targetId: string): void => {
    if (draggedId === targetId) return
    const ws = workspaces
    const target = ws.find((w) => w.id === targetId)
    if (!target) return
    const groupName = target.group ?? nextGroupName()
    if (!target.group) setGroup(target.id, groupName)
    setGroup(draggedId, groupName)
  }

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
        {rail.map((entry) =>
          entry.kind === 'tile' ? (
            <RailTile
              key={entry.ws.id}
              workspace={entry.ws}
              active={view === 'workspace' && entry.ws.id === activeId}
              onClick={() => activate(entry.ws.id)}
              onDropWorkspace={(draggedId) => dropOntoTile(draggedId, entry.ws.id)}
            />
          ) : (
            <div key={`group:${entry.name}`} className="flex w-full flex-col items-center gap-2.5">
              <RailFolder
                name={entry.name}
                members={entry.members}
                open={!!openGroups[entry.name]}
                onToggle={() => toggleGroup(entry.name)}
                onDropWorkspace={(draggedId) => setGroup(draggedId, entry.name)}
                onRename={(newName) => {
                  renameGroup(entry.name, newName)
                  setOpenGroups((s) => {
                    const next = { ...s }
                    if (entry.name in next) {
                      next[newName] = next[entry.name]
                      delete next[entry.name]
                    }
                    return next
                  })
                }}
              />
              {openGroups[entry.name] &&
                entry.members.map((w) => (
                  <div key={w.id} className="w-full scale-90">
                    <RailTile
                      workspace={w}
                      active={view === 'workspace' && w.id === activeId}
                      onClick={() => activate(w.id)}
                      onDropWorkspace={(draggedId) => dropOntoTile(draggedId, w.id)}
                    />
                  </div>
                ))}
            </div>
          )
        )}

        {/* Drop here to remove a tile from its folder. */}
        <div
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes(DECKS_WS_DND)) return
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            setClearOver(true)
          }}
          onDragLeave={() => setClearOver(false)}
          onDrop={(e) => {
            setClearOver(false)
            const id = e.dataTransfer.getData(DECKS_WS_DND)
            if (!id) return
            e.preventDefault()
            setGroup(id, undefined)
          }}
          title="Drop here to remove from folder"
          className={`mt-1 grid h-7 w-11 place-items-center rounded-xl border border-dashed text-[9px] uppercase tracking-wide transition-colors ${
            clearOver
              ? 'border-accent bg-accent-soft text-accent'
              : 'border-line/60 text-txt-4'
          }`}
        >
          drop
        </div>
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

      <div className="my-0.5 h-px w-7 bg-line/70" />
      <RamMeter />

      {edit && <WorkspaceEditModal workspace={edit.ws} mode={edit.mode} onClose={() => setEdit(null)} />}
      {addDeckOpen && <AddDeckModal onClose={closeAddDeck} />}
    </aside>
  )
}

export default Sidebar
