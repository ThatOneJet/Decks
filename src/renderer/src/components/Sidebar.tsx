/**
 * Sidebar — the Console "DOCK": a labeled, sectioned, collapsible workspace list.
 *
 * Instead of a bare icon rail, workspaces are grouped into labeled sections
 * (Native decks / Web decks, plus a section per folder/group). Each ROW shows the
 * app logo + name + a live STATUS IN WORDS ("Playing", "N new", "Idle", …)
 * derived from real panel signals (badge / playing / discarded / keepAlive). A
 * dock footer hosts Home / Focus / Memory / Settings; the (+) add-deck row lives
 * under the last section. ⌘B collapses the dock to a dense icon rail (icon-only,
 * badges preserved). In portrait the dock becomes a horizontal bottom taskbar.
 *
 * All prior behavior is preserved: drag-to-group (dropOntoTile / DECKS_WS_DND +
 * panel.hideAll), the custom overlay context menus (workspace + folder, incl.
 * rename / note / reset / delete / keepAlive), hover cards, add-by-link, and the
 * RAM/memory readout. Tiles still: click to activate, right-click menu, drag,
 * drop-to-group, show native/web kind + unread/playing badges.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import type { MetricsResult } from '@shared/ipc'
import RailTile, { DECKS_WS_DND } from './sidebar/WorkspaceItem'
import RailFolder from './sidebar/RailFolder'
import TileIcon from './sidebar/TileIcon'
import WorkspaceEditModal from './sidebar/WorkspaceEditModal'
import FolderRenameModal from './sidebar/FolderRenameModal'
import AddDeckModal from './AddDeckModal'
import { MOD } from '../lib/platform'
import { iconCandidates } from '../lib/favicon'
import type { Workspace } from '@shared/types'

type RailEntry =
  | { kind: 'tile'; ws: Workspace }
  | { kind: 'folder'; name: string; members: Workspace[] }

/** Stable sort: pinned workspaces first, preserving manual order within each subset. */
function pinnedFirst(list: Workspace[]): Workspace[] {
  return [...list].sort((a, b) => (a.pinned ? 0 : 1) - (b.pinned ? 0 : 1))
}

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

/** Aggregate the live signals a dock row needs from a workspace's panels. */
function signals(ws: Workspace): {
  unread: number
  playing: boolean
  discarded: boolean
  isNative: boolean
} {
  const unread = ws.panels.reduce((sum, p) => sum + (p.badge || 0), 0)
  const playing = ws.panels.some((p) => p.playing)
  const live = ws.panels.filter((p) => p.kind !== 'native')
  const discarded = live.length > 0 && live.every((p) => p.discarded)
  const isNative = ws.panels[0]?.kind === 'native'
  return { unread, playing, discarded, isNative }
}

/** The status line, in words, derived from real signals. */
function statusText(ws: Workspace): { text: string; cls: '' | 'playing' | 'unread' | 'idle' } {
  const { unread, playing, discarded } = signals(ws)
  if (playing) return { text: 'Playing', cls: 'playing' }
  if (unread > 0) return { text: `${unread} new`, cls: 'unread' }
  if (discarded) return { text: 'Discarded', cls: 'idle' }
  if (ws.keepAlive) return { text: 'Kept alive', cls: '' }
  return { text: 'Idle', cls: 'idle' }
}

/**
 * DockRow — one workspace rendered as a labeled row (logo + name + status), or,
 * in `rail` mode, an icon-only chip with unread/playing corner badges. Preserves
 * the full RailTile behavior set: click→activate, right-click→overlay menu, drag
 * (DECKS_WS_DND + hideAll so native views release the DOM), drop-onto to group,
 * native/web kind indicator, hover card, and an "open beside / split" affordance.
 */
function DockRow({
  ws,
  active,
  rail,
  indent,
  onClick,
  onReorder,
  canReorderFrom,
  onBeside
}: {
  ws: Workspace
  active: boolean
  rail: boolean
  indent?: boolean
  onClick: () => void
  /** A deck row was dropped onto THIS row (same-section) → insert before it. */
  onReorder?: (draggedId: string) => void
  /** Whether the dragged deck shares THIS row's section (valid reorder target). */
  canReorderFrom?: (draggedId: string) => boolean
  onBeside?: () => void
}): JSX.Element {
  const ref = useRef<HTMLButtonElement>(null)
  const [dragging, setDragging] = useState(false)
  /** 'valid' = same-section insertion target (show line); 'invalid' = cross-section. */
  const [dropOver, setDropOver] = useState<'none' | 'valid' | 'invalid'>('none')
  const setGlobalDragging = useStore((s) => s.setDragging)

  const primary = ws.panels[0]
  const { unread, playing, isNative } = signals(ws)
  const status = statusText(ws)
  const color = ws.color || '#45d6e8'

  const showHover = (): void => {
    const rect = ref.current?.getBoundingClientRect()
    if (!rect) return
    window.decks?.hover.show({
      summary: {
        name: ws.name,
        iconUrl: primary ? iconCandidates(primary.url, primary.favicon)[0] ?? '' : '',
        color,
        deckCount: ws.panels.filter((p) => p.id).length,
        unread,
        playing,
        notes: ws.notes
      },
      x: rect.right + 10,
      y: rect.top
    })
  }
  const hideHover = (): void => window.decks?.hover.hide()

  const openMenu = (x: number, y: number): void =>
    window.decks?.menu.show({
      kind: 'workspace',
      targetId: ws.id,
      hasNotes: !!ws.notes,
      keepAlive: !!ws.keepAlive,
      pinned: !!ws.pinned,
      x,
      y
    })

  return (
    <button
      ref={ref}
      className={`drow ${active ? 'active' : ''} ${dragging ? 'dragging' : ''} ${
        dropOver === 'valid' ? 'drop-before' : ''
      }`}
      style={indent && !rail ? { paddingLeft: 6 } : undefined}
      onClick={onClick}
      onContextMenu={(e) => {
        e.preventDefault()
        hideHover()
        openMenu(e.clientX, e.clientY)
      }}
      onMouseEnter={showHover}
      onMouseLeave={hideHover}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DECKS_WS_DND, ws.id)
        e.dataTransfer.effectAllowed = 'move'
        setDragging(true)
        hideHover()
        // Hide native web views so the renderer page area becomes a real DOM drop
        // target (views sit OVER the DOM and would otherwise eat drag events).
        setGlobalDragging(true)
        // Remember WHICH deck is dragging so other rows can validate same-section
        // reorder during dragover (dataTransfer.getData is empty mid-drag).
        useStore.getState().setDraggingId(ws.id)
        window.decks?.panel.hideAll()
      }}
      onDragEnd={() => {
        setDragging(false)
        setGlobalDragging(false)
        useStore.getState().setDraggingId(null)
        window.dispatchEvent(new Event('resize'))
      }}
      onDragOver={(e) => {
        if (!onReorder) return
        if (!e.dataTransfer.types.includes(DECKS_WS_DND)) return
        const dragId = useStore.getState().draggingId
        if (!dragId || dragId === ws.id) {
          setDropOver('invalid')
          return
        }
        const ok = canReorderFrom ? canReorderFrom(dragId) : false
        e.preventDefault()
        e.dataTransfer.dropEffect = ok ? 'move' : 'none'
        setDropOver(ok ? 'valid' : 'invalid')
      }}
      onDragLeave={() => setDropOver('none')}
      onDrop={(e) => {
        setDropOver('none')
        if (!onReorder) return
        const id = e.dataTransfer.getData(DECKS_WS_DND)
        if (!id || id === ws.id) return
        if (canReorderFrom && !canReorderFrom(id)) return
        e.preventDefault()
        onReorder(id)
      }}
      title={rail ? `${ws.name} · ${status.text}` : undefined}
    >
      <span className="marker" />
      <span className="ico">
        <span className={`tile-kind ${isNative ? 'native' : 'web'}`} title={isNative ? 'Native deck' : 'Web deck'} />
        <TileIcon url={primary?.url} favicon={primary?.favicon} color={color} glyph={ws.glyph} name={ws.name} />
        {rail && unread > 0 && (
          <span className="corner count">{unread > 99 ? '99+' : unread}</span>
        )}
        {rail && playing && unread === 0 && (
          <span className="corner play">
            <svg viewBox="0 0 24 24" width={8} height={8} fill="#fff"><path d="M8 5v14l11-7z" /></svg>
          </span>
        )}
        {rail && ws.pinned && (
          <span className="corner pin" title="Pinned to top">
            <svg viewBox="0 0 24 24" width={7} height={7} fill="#fff"><path d="M14 2l8 8-4 1-3 3-1 5-3-3-5 5-1-1 5-5-3-3 5-1 3-3z" /></svg>
          </span>
        )}
      </span>
      <span className="meta">
        <span className="nm">
          {ws.name}
          {ws.pinned && (
            <span className="pin-dot" title="Pinned to top" aria-label="Pinned">
              <svg viewBox="0 0 24 24" width={9} height={9} fill="currentColor">
                <path d="M14 2l8 8-4 1-3 3-1 5-3-3-5 5-1-1 5-5-3-3 5-1 3-3z" />
              </svg>
            </span>
          )}
        </span>
        <span className={`status ${status.cls}`}>
          {playing && <span className="sd" style={{ background: 'var(--live)' }} />}
          {!playing && unread > 0 && <span className="sd" style={{ background: 'var(--accent)' }} />}
          {status.text}
        </span>
      </span>
      {onBeside && (
        <span
          className="openbeside"
          title="Open beside (split view)"
          role="button"
          onClick={(e) => {
            e.stopPropagation()
            onBeside()
          }}
        >
          <svg viewBox="0 0 24 24" width={15} height={15} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="8" height="16" rx="1.5" />
            <path d="M16 9v6M13 12h6" />
          </svg>
        </span>
      )}
    </button>
  )
}

/** A labeled section header. In rail mode it collapses to a faint divider tick. */
function SectionHead({
  icon,
  label
}: {
  icon: 'native' | 'web' | 'pinned'
  label: string
}): JSX.Element {
  return (
    <div className="dock-sec-head">
      <span className={`lbldot ${icon}`} />
      <span className="lbl">{label}</span>
    </div>
  )
}

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
    <svg viewBox="0 0 24 24" width={17} height={17} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
  ),
  home: (
    <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 11l9-8 9 8" /><path d="M5 10v10h14V10" /></svg>
  ),
  focus: (
    <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 8V5a1 1 0 0 1 1-1h3M20 8V5a1 1 0 0 0-1-1h-3M4 16v3a1 1 0 0 0 1 1h3M20 16v3a1 1 0 0 1-1 1h-3" /></svg>
  ),
  chip: (
    <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="7" y="7" width="10" height="10" rx="1.5" /><path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3" /></svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
  ),
  chevL: (
    <svg viewBox="0 0 24 24" width={13} height={13} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
  )
}

function Sidebar({
  orientation = 'vertical',
  collapsed = false,
  onToggleCollapse
}: {
  orientation?: 'vertical' | 'horizontal'
  collapsed?: boolean
  onToggleCollapse?: () => void
} = {}): JSX.Element {
  const horizontal = orientation === 'horizontal'
  // Collapse only applies to the vertical dock; the portrait taskbar ignores it.
  const rail = collapsed && !horizontal

  const workspaces = useStore((s) => s.workspaces)
  const activeId = useStore((s) => s.activeWorkspaceId)
  const view = useStore((s) => s.view)
  const focusMode = useStore((s) => s.focusMode)
  const toggleFocusMode = useStore((s) => s.toggleFocusMode)
  const activate = useStore((s) => s.activateWorkspace)
  const goHome = useStore((s) => s.goHome)
  const openSettings = useStore((s) => s.openSettings)
  const openMemory = useStore((s) => s.openMemory)
  const removeWorkspace = useStore((s) => s.removeWorkspace)
  const addDeckOpen = useStore((s) => s.addDeckOpen)
  const openAddDeck = useStore((s) => s.openAddDeck)
  const closeAddDeck = useStore((s) => s.closeAddDeck)
  const setGroup = useStore((s) => s.setGroup)
  const nextGroupName = useStore((s) => s.nextGroupName)
  const reorderWorkspace = useStore((s) => s.reorderWorkspace)

  const [edit, setEdit] = useState<{ ws: Workspace; mode: 'rename' | 'note' } | null>(null)
  const [renameFolder, setRenameFolder] = useState<string | null>(null)
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({})

  const rail_ = useMemo(() => buildRail(workspaces), [workspaces])

  const toggleGroup = (name: string): void => setOpenGroups((s) => ({ ...s, [name]: !s[name] }))

  const dropOntoTile = (draggedId: string, targetId: string): void => {
    if (draggedId === targetId) return
    const target = workspaces.find((w) => w.id === targetId)
    if (!target) return
    const groupName = target.group ?? nextGroupName()
    if (!target.group) setGroup(target.id, groupName)
    setGroup(draggedId, groupName)
  }

  // Whether `draggedId` is in the SAME dock section as `targetWs` (and thus a
  // valid reorder target): same group, OR both ungrouped AND same kind.
  const sameSection = (draggedId: string, targetWs: Workspace): boolean => {
    const dragged = workspaces.find((w) => w.id === draggedId)
    if (!dragged || dragged.id === targetWs.id) return false
    const kindOf = (w: Workspace): boolean => w.panels[0]?.kind === 'native'
    return dragged.group || targetWs.group
      ? dragged.group === targetWs.group
      : kindOf(dragged) === kindOf(targetWs)
  }

  // "Open beside" — activate the workspace; SplitView/drag-to-split owns the
  // actual pane geometry, so we don't fabricate panels here.
  const openBeside = (id: string): void => activate(id)

  useEffect(() => {
    const off = window.decks?.onWorkspaceMenuAction(({ workspaceId, action }) => {
      const ws = useStore.getState().workspaces.find((w) => w.id === workspaceId)
      if (!ws) return
      if (action === 'rename') setEdit({ ws, mode: 'rename' })
      else if (action === 'note') setEdit({ ws, mode: 'note' })
      else if (action === 'reset') {
        // FORCE the workspace's decks to load. Web decks: panel.create is
        // idempotent — it builds the WebContentsView if it was never created or
        // got discarded (so a blank/unloaded deck actually loads), and just
        // re-navigates one that's already live. Native decks remount via a bumped
        // nonce keyed in SplitView.
        const { bumpPanelReload } = useStore.getState()
        ws.panels.forEach((p) => {
          if (p.kind === 'native') {
            bumpPanelReload(p.id)
          } else {
            void window.decks?.panel.create({
              panelId: p.id,
              workspaceId: ws.id,
              partition: ws.partition,
              url: p.url,
              bounds: { x: 0, y: 0, width: 800, height: 600 }
            })
          }
        })
      } else if (action === 'keepalive') {
        useStore.getState().setKeepAlive(ws.id, !ws.keepAlive)
      } else if (action === 'pin') {
        useStore.getState().setPinned(ws.id, !ws.pinned)
      } else if (action === 'delete') {
        ws.panels.forEach((p) => window.decks?.panel.destroy(p.id))
        removeWorkspace(ws.id)
      }
    })
    return () => off?.()
  }, [removeWorkspace])

  useEffect(() => {
    const off = window.decks?.onFolderMenuAction(({ name, action }) => {
      const members = useStore.getState().workspaces.filter((w) => w.group === name)
      if (action === 'rename') setRenameFolder(name)
      else if (action === 'ungroup') {
        members.forEach((w) => setGroup(w.id, undefined))
      } else if (action === 'keepalive') {
        // Toggle the whole group together: if all are pinned, unpin; else pin all.
        const allOn = members.length > 0 && members.every((w) => w.keepAlive)
        members.forEach((w) => useStore.getState().setKeepAlive(w.id, !allOn))
      }
    })
    return () => off?.()
  }, [setGroup])

  const isActive = (id: string): boolean => view === 'workspace' && id === activeId

  const modals = (
    <>
      {edit && <WorkspaceEditModal workspace={edit.ws} mode={edit.mode} onClose={() => setEdit(null)} />}
      {renameFolder && <FolderRenameModal name={renameFolder} onClose={() => setRenameFolder(null)} />}
      {addDeckOpen && <AddDeckModal onClose={closeAddDeck} />}
    </>
  )

  // ──────────────────────────────────────────────────────────────────────────
  // Portrait: horizontal taskbar dock (icon tiles, unchanged behavior).
  // ──────────────────────────────────────────────────────────────────────────
  if (horizontal) {
    const tiles = rail_.map((entry) =>
      entry.kind === 'tile' ? (
        <div key={entry.ws.id} className="flex w-12 shrink-0 justify-center">
          <RailTile
            workspace={entry.ws}
            active={view === 'workspace' && entry.ws.id === activeId}
            onClick={() => activate(entry.ws.id)}
            onDropWorkspace={(draggedId) => dropOntoTile(draggedId, entry.ws.id)}
          />
        </div>
      ) : (
        <div key={`group:${entry.name}`} className="flex shrink-0 flex-row items-center gap-2">
          <div className="flex w-12 shrink-0 justify-center">
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
              <div key={w.id} className="flex w-12 shrink-0 justify-center" style={{ transform: 'scale(0.86)' }}>
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

  // ──────────────────────────────────────────────────────────────────────────
  // Landscape: the labeled, sectioned DOCK (collapses to an icon rail).
  // Sections: ungrouped Native decks, then a section per folder/group, then
  // ungrouped Web decks (with the add-deck row).
  // ──────────────────────────────────────────────────────────────────────────
  const ungrouped = rail_.filter((e): e is { kind: 'tile'; ws: Workspace } => e.kind === 'tile')
  const folders = rail_.filter(
    (e): e is { kind: 'folder'; name: string; members: Workspace[] } => e.kind === 'folder'
  )
  // Pinned decks sort to the top of each section (manual order kept within subset).
  const nativeWs = pinnedFirst(ungrouped.filter((e) => signals(e.ws).isNative).map((e) => e.ws))
  const webWs = pinnedFirst(ungrouped.filter((e) => !signals(e.ws).isNative).map((e) => e.ws))

  const renderRow = (ws: Workspace, indent?: boolean): JSX.Element => (
    <DockRow
      key={ws.id}
      ws={ws}
      active={isActive(ws.id)}
      rail={rail}
      indent={indent}
      onClick={() => activate(ws.id)}
      // Dropping a deck row onto another row in the SAME section reorders it
      // (insert before the target). Cross-section drops are rejected.
      onReorder={(draggedId) => reorderWorkspace(draggedId, ws.id)}
      canReorderFrom={(draggedId) => sameSection(draggedId, ws)}
      onBeside={() => openBeside(ws.id)}
    />
  )

  return (
    <aside className={`dock ${rail ? 'rail' : ''} ${focusMode ? 'focusdim' : ''}`}>
      {onToggleCollapse && (
        <button
          className="dock-collapse"
          onClick={onToggleCollapse}
          title={rail ? 'Expand dock' : `Collapse to rail (${MOD === '⌘' ? '⌘B' : 'Ctrl+B'})`}
        >
          {ICON.chevL}
        </button>
      )}

      <div className="dock-scroll">
        {nativeWs.length > 0 && (
          <div className="dock-sec">
            <SectionHead icon="native" label="Native decks" />
            {nativeWs.map((ws) => renderRow(ws))}
          </div>
        )}

        {folders.map((entry) => {
          const open = !!openGroups[entry.name]
          const groupActive = entry.members.some((m) => isActive(m.id))
          const groupUnread = entry.members.reduce((s, w) => s + signals(w).unread, 0)
          const groupPlaying = entry.members.some((w) => signals(w).playing)
          return (
            <div className="dock-sec" key={`group:${entry.name}`}>
              <button
                className={`drow ${groupActive ? 'active' : ''}`}
                onClick={() => toggleGroup(entry.name)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  window.decks?.menu.show({
                    kind: 'folder',
                    targetId: entry.name,
                    keepAlive: entry.members.length > 0 && entry.members.every((m) => m.keepAlive),
                    x: e.clientX,
                    y: e.clientY
                  })
                }}
                onDragOver={(e) => {
                  if (!e.dataTransfer.types.includes(DECKS_WS_DND)) return
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                }}
                onDrop={(e) => {
                  const id = e.dataTransfer.getData(DECKS_WS_DND)
                  if (!id) return
                  e.preventDefault()
                  setGroup(id, entry.name)
                }}
                title={rail ? `${entry.name} · ${entry.members.length} decks` : undefined}
              >
                <span className="marker" />
                <span className="folderico">
                  {entry.members.slice(0, 4).map((m) => (
                    <span key={m.id}>
                      <TileIcon
                        url={m.panels[0]?.url}
                        favicon={m.panels[0]?.favicon}
                        color={m.color || '#45d6e8'}
                        glyph={m.glyph}
                        name={m.name}
                      />
                    </span>
                  ))}
                  {rail && groupUnread > 0 && (
                    <span className="corner count">{groupUnread > 99 ? '99+' : groupUnread}</span>
                  )}
                  {rail && groupPlaying && groupUnread === 0 && (
                    <span className="corner play">
                      <svg viewBox="0 0 24 24" width={8} height={8} fill="#fff"><path d="M8 5v14l11-7z" /></svg>
                    </span>
                  )}
                </span>
                <span className="meta">
                  <span className="nm">{entry.name}</span>
                  <span className="status">
                    {entry.members.length} decks · {open ? 'expanded' : 'collapsed'}
                  </span>
                </span>
                <span className="openbeside" style={{ opacity: 1, transform: 'none' }}>
                  <svg
                    viewBox="0 0 24 24"
                    width={14}
                    height={14}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .2s' }}
                  >
                    <path d="M9 18l6-6-6-6" />
                  </svg>
                </span>
              </button>
              {open && (
                <div className="gmembers">
                  {pinnedFirst(entry.members).map((ws) => renderRow(ws, true))}
                </div>
              )}
            </div>
          )
        })}

        <div className="dock-sec">
          {webWs.length > 0 && <SectionHead icon="web" label="Web decks" />}
          {webWs.map((ws) => renderRow(ws))}
          <button className="add-row" onClick={openAddDeck} title={`Add a deck (${MOD === '⌘' ? '⌘N' : 'Ctrl+N'})`}>
            <span className="pl">{ICON.add}</span>
            <span className="atx">Add a deck…</span>
          </button>
        </div>
      </div>

      <div className="dock-foot">
        <button className={`frow ${view === 'home' ? 'on' : ''}`} onClick={goHome} title="Home">
          <span className="fi">{ICON.home}</span>
          <span className="ftx">Home</span>
        </button>
        <button className={`frow ${focusMode ? 'on' : ''}`} onClick={toggleFocusMode} title={`Focus mode (${MOD === '⌘' ? '⌘.' : 'Ctrl+.'})`}>
          <span className="fi">{ICON.focus}</span>
          <span className="ftx">Focus mode</span>
          {!rail && <span className="kbd" style={{ marginLeft: 'auto' }}>{MOD === '⌘' ? '⌘.' : 'Ctrl+.'}</span>}
        </button>
        <button className="frow" onClick={openMemory} title="Memory">
          <span className="fi">{ICON.chip}</span>
          <span className="ftx">Memory</span>
        </button>
        <button className={`frow ${view === 'settings' ? 'on' : ''}`} onClick={openSettings} title="Settings">
          <span className="fi">{ICON.settings}</span>
          <span className="ftx">Settings</span>
        </button>
        {!rail && (
          <div className="dock-ram">
            <RamMeter />
          </div>
        )}
      </div>
      {modals}
    </aside>
  )
}

export default Sidebar
