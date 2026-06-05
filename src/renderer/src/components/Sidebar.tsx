/**
 * Sidebar — the redesigned Discord-style icon rail (left) of app logos.
 *
 * Brand mark, a scrollable stack of workspace tiles + folders, then rail buttons
 * (add / home / focus / settings) and a compact RAM meter. In portrait the rail
 * becomes a horizontal taskbar dock at the bottom. All behavior is preserved:
 * drag-to-group, custom overlay menus, rename/note/reset/delete, add-by-link.
 */
import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import type { MetricsResult } from '@shared/ipc'
import RailTile from './sidebar/WorkspaceItem'
import RailFolder from './sidebar/RailFolder'
import WorkspaceEditModal from './sidebar/WorkspaceEditModal'
import FolderRenameModal from './sidebar/FolderRenameModal'
import AddDeckModal from './AddDeckModal'
import Logo from './Logo'
import { MOD } from '../lib/platform'
import { templateFor, workspaceFromTemplate } from '@shared/seed'
import type { Workspace, LayoutNode } from '@shared/types'

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

/** RAM/process readout. Vertical → redesign `.ram`; horizontal → compact chip. */
function RamMeter({ compact = false }: { compact?: boolean } = {}): JSX.Element | null {
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
  if (compact) {
    return (
      <div
        title={`${m.ramMB} MB · ${m.liveRenderers} live / ${m.discarded} discarded`}
        className="flex shrink-0 items-center gap-1 rounded-lg bg-bg-elevated px-2 py-1 leading-none"
      >
        <span className="font-mono text-[10px] font-medium tabular-nums text-txt-2">{m.ramMB} MB</span>
        <span className="font-mono text-[9px] tabular-nums text-txt-4">{m.liveRenderers}/{m.discarded}</span>
      </div>
    )
  }
  return (
    <div className="ram" title={`${m.ramMB} MB · ${m.liveRenderers} live / ${m.discarded} discarded`}>
      <div className="mb">
        {m.ramMB}
        <span style={{ fontSize: 8, color: 'var(--txt-4)' }}> MB</span>
      </div>
      <div className="rp">
        {m.liveRenderers} live · {m.discarded} idle
      </div>
    </div>
  )
}

const ICON = {
  add: (
    <svg viewBox="0 0 24 24" width={20} height={20} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
  ),
  home: (
    <svg viewBox="0 0 24 24" width={19} height={19} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 11l9-8 9 8" /><path d="M5 10v10h14V10" /></svg>
  ),
  focus: (
    <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 8V5a1 1 0 0 1 1-1h3M20 8V5a1 1 0 0 0-1-1h-3M4 16v3a1 1 0 0 0 1 1h3M20 16v3a1 1 0 0 1-1 1h-3" /></svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
  )
}

function Sidebar({
  orientation = 'vertical'
}: {
  orientation?: 'vertical' | 'horizontal'
} = {}): JSX.Element {
  const horizontal = orientation === 'horizontal'
  const workspaces = useStore((s) => s.workspaces)
  const activeId = useStore((s) => s.activeWorkspaceId)
  const view = useStore((s) => s.view)
  const focusMode = useStore((s) => s.focusMode)
  const toggleFocusMode = useStore((s) => s.toggleFocusMode)
  const activate = useStore((s) => s.activateWorkspace)
  const goHome = useStore((s) => s.goHome)
  const openSettings = useStore((s) => s.openSettings)
  const removeWorkspace = useStore((s) => s.removeWorkspace)
  const setDecks = useStore((s) => s.setDecks)
  const addDeckOpen = useStore((s) => s.addDeckOpen)
  const openAddDeck = useStore((s) => s.openAddDeck)
  const closeAddDeck = useStore((s) => s.closeAddDeck)
  const setGroup = useStore((s) => s.setGroup)
  const nextGroupName = useStore((s) => s.nextGroupName)

  const [edit, setEdit] = useState<{ ws: Workspace; mode: 'rename' | 'note' } | null>(null)
  const [renameFolder, setRenameFolder] = useState<string | null>(null)
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({})

  const rail = useMemo(() => buildRail(workspaces), [workspaces])

  const toggleGroup = (name: string): void => setOpenGroups((s) => ({ ...s, [name]: !s[name] }))

  const dropOntoTile = (draggedId: string, targetId: string): void => {
    if (draggedId === targetId) return
    const target = workspaces.find((w) => w.id === targetId)
    if (!target) return
    const groupName = target.group ?? nextGroupName()
    if (!target.group) setGroup(target.id, groupName)
    setGroup(draggedId, groupName)
  }

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

  useEffect(() => {
    const off = window.decks?.onFolderMenuAction(({ name, action }) => {
      if (action === 'rename') setRenameFolder(name)
      else if (action === 'ungroup') {
        useStore
          .getState()
          .workspaces.filter((w) => w.group === name)
          .forEach((w) => setGroup(w.id, undefined))
      }
    })
    return () => off?.()
  }, [setGroup])

  const tiles = rail.map((entry) =>
    entry.kind === 'tile' ? (
      <div key={entry.ws.id} className={horizontal ? 'flex w-12 shrink-0 justify-center' : 'w-full'}>
        <RailTile
          workspace={entry.ws}
          active={view === 'workspace' && entry.ws.id === activeId}
          onClick={() => activate(entry.ws.id)}
          onDropWorkspace={(draggedId) => dropOntoTile(draggedId, entry.ws.id)}
        />
      </div>
    ) : (
      <div
        key={`group:${entry.name}`}
        className={horizontal ? 'flex shrink-0 flex-row items-center gap-2' : 'flex w-full flex-col items-center gap-2'}
      >
        <div className={horizontal ? 'flex w-12 shrink-0 justify-center' : 'w-full'}>
          <RailFolder
            name={entry.name}
            members={entry.members}
            open={!!openGroups[entry.name]}
            onToggle={() => toggleGroup(entry.name)}
            onDropWorkspace={(draggedId) => setGroup(draggedId, entry.name)}
          />
        </div>
        {openGroups[entry.name] &&
          entry.members.map((w) => (
            <div
              key={w.id}
              className={horizontal ? 'flex w-12 shrink-0 justify-center' : 'w-full'}
              style={{ transform: 'scale(0.86)' }}
            >
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
  )

  const modals = (
    <>
      {edit && <WorkspaceEditModal workspace={edit.ws} mode={edit.mode} onClose={() => setEdit(null)} />}
      {renameFolder && <FolderRenameModal name={renameFolder} onClose={() => setRenameFolder(null)} />}
      {addDeckOpen && <AddDeckModal onClose={closeAddDeck} />}
    </>
  )

  if (horizontal) {
    return (
      <aside className="flex h-16 w-full shrink-0 flex-row items-center gap-3 border-t border-line bg-bg-rail px-3">
        <nav className="flex min-w-0 flex-1 flex-row items-center gap-2 overflow-x-auto overflow-y-visible py-1">
          {tiles}
        </nav>
        <button className="rail-btn add" onClick={openAddDeck} title={`Add a deck (${MOD === '⌘' ? '⌘N' : 'Ctrl+N'})`}>{ICON.add}</button>
        <button className={`rail-btn ${view === 'home' ? 'on' : ''}`} onClick={goHome} title="Home">{ICON.home}</button>
        <button className={`rail-btn ${view === 'settings' ? 'on' : ''}`} onClick={openSettings} title="Settings">{ICON.settings}</button>
        <RamMeter compact />
        {modals}
      </aside>
    )
  }

  return (
    <aside className={`rail ${focusMode ? 'focusdim' : ''}`}>
      <div className="rail-brand" title="Decks">
        <Logo size={26} />
      </div>
      <div className="rail-divider" />
      <nav className="rail-scroll">{tiles}</nav>
      <div className="rail-divider" />
      <button className="rail-btn add" onClick={openAddDeck} title={`Add a deck (${MOD === '⌘' ? '⌘N' : 'Ctrl+N'})`}>{ICON.add}</button>
      <button className={`rail-btn ${view === 'home' ? 'on' : ''}`} onClick={goHome} title="Home">{ICON.home}</button>
      <button className={`rail-btn ${focusMode ? 'on' : ''}`} onClick={toggleFocusMode} title={`Focus mode (${MOD === '⌘' ? '⌘.' : 'Ctrl+.'})`}>{ICON.focus}</button>
      <button className={`rail-btn ${view === 'settings' ? 'on' : ''}`} onClick={openSettings} title="Settings">{ICON.settings}</button>
      <div className="rail-divider" />
      <RamMeter />
      {modals}
    </aside>
  )
}

export default Sidebar
