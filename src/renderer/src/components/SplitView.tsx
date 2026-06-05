/**
 * SplitView — the floating page card the chrome wraps around, now dressed in the
 * "Console" workspace chrome: a TAB STRIP across the top of the card, an explicit
 * open-beside / split affordance, and a contextual ACTION SHELF below it.
 *
 * The active workspace's layout tree still renders as deck PANES inside one
 * rounded, glowing `.page-card`. Each leaf = a `.deck-pane` with a `.deck-head`
 * (icon + name + Native/Web chip + pop-out / focus / reload / close) over a
 * `.deck-body`. WEB panes: the body is an empty slot whose pixel rect is measured
 * and reported via panel.showOnly so the native WebContentsView sits under the
 * chrome. NATIVE panes: the body renders our React deck (NativeDeckHost).
 *
 * Drag a rail tile onto the card and glowing Split-left / Split-right zones appear.
 * All behaviors — the layout tree, the discard/measure pipeline, native vs web,
 * pop-out, reload, close, drop zones, the split-ghost hint — are preserved; the
 * Console chrome is layered ON TOP.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import type { LayoutNode, Panel, PanelBounds, PanelId, Workspace } from '@shared/types'
import { faviconFor } from '../lib/favicon'
import { DECKS_WS_DND } from './sidebar/WorkspaceItem'
import NativeDeckHost from '../native/NativeDeckHost'
import { modCombo } from '../lib/platform'
import './home/splitview.css'

/** Max decks a single workspace's split can hold (drag-into-page cap). */
const MAX_PANELS = 4

function collectPanelIds(node: LayoutNode, out: PanelId[]): void {
  if (node.type === 'leaf') {
    if (node.panelId) out.push(node.panelId)
    return
  }
  for (const child of node.children) collectPanelIds(child, out)
}

/** Per-panel handlers shared by the pane head, the tab strip, and the shelf. */
function usePanelActions(ws: Workspace) {
  const removePanel = useStore((s) => s.removePanel)
  const popPanelOut = useStore((s) => s.popPanelOut)
  const toggleFocusMode = useStore((s) => s.toggleFocusMode)
  const bumpPanelReload = useStore((s) => s.bumpPanelReload)

  // Native decks have no main-process view: reload = remount the React subtree
  // (bump the per-panel nonce) rather than calling panel.reload. Web decks reload
  // the view.
  const reload = useCallback(
    (deck: Panel | undefined): void => {
      if (!deck) return
      if (deck.kind === 'native') bumpPanelReload(deck.id)
      else void window.decks?.panel.reload(deck.id)
    },
    [bumpPanelReload]
  )

  const close = useCallback(
    (deck: Panel | undefined): void => {
      if (!deck) return
      if (deck.kind !== 'native') window.decks?.panel.destroy(deck.id)
      removePanel(ws.id, deck.id)
    },
    [removePanel, ws.id]
  )

  const pop = useCallback(
    (deck: Panel | undefined): void => {
      if (deck) popPanelOut(ws.id, deck.id)
    },
    [popPanelOut, ws.id]
  )

  return { reload, close, pop, toggleFocusMode }
}

function HeadBtn({
  title,
  onClick,
  danger,
  children
}: {
  title: string
  onClick: () => void
  danger?: boolean
  children: React.ReactNode
}): JSX.Element {
  return (
    <button onClick={onClick} title={title} className={`hb${danger ? ' close' : ''}`}>
      {children}
    </button>
  )
}

/** Tab strip across the top of the page card — one tab per pane in the layout. */
function TabStrip({
  ws,
  panelIds,
  activeTab,
  onActivate,
  onClose,
  onSplit,
  onAdd
}: {
  ws: Workspace
  panelIds: PanelId[]
  activeTab: PanelId | null
  onActivate: (id: PanelId) => void
  onClose: (deck: Panel | undefined) => void
  onSplit: () => void
  onAdd: () => void
}): JSX.Element {
  const decks = panelIds.map((id) => ws.panels.find((p) => p.id === id)).filter(Boolean) as Panel[]
  const splitCount = decks.length
  const canSplit = splitCount < MAX_PANELS

  return (
    <div className="tabstrip no-drag">
      {decks.map((deck) => {
        const isNative = deck.kind === 'native'
        const icon = !isNative ? deck.favicon || faviconFor(deck.url) : ''
        const active = deck.id === activeTab
        return (
          <div
            key={deck.id}
            className={`tab ${active ? 'active' : ''}`}
            onClick={() => onActivate(deck.id)}
            title={deck.title}
          >
            <span className="tfav">
              {icon ? <img src={icon} alt="" draggable={false} /> : <span>{ws.glyph ?? '◻'}</span>}
            </span>
            <span className="tnm">{deck.title || deck.id}</span>
            <span className={`tkind ${isNative ? 'native' : 'web'}`}>
              {isNative ? 'native' : 'web'}
            </span>
            {decks.length > 1 && (
              <span
                className="tx"
                title="Close deck"
                onClick={(e) => {
                  e.stopPropagation()
                  onClose(deck)
                }}
              >
                <svg viewBox="0 0 24 24" width={12} height={12} stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </span>
            )}
          </div>
        )
      })}
      <button
        className="tab-add"
        title={canSplit ? 'Open another deck beside (split view)' : 'Max 4 decks — close one first'}
        onClick={canSplit ? onSplit : undefined}
        disabled={!canSplit}
      >
        <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="8" height="16" rx="1" />
          <rect x="13" y="4" width="8" height="16" rx="1" strokeDasharray="3 3" />
          <path d="M17 8v6M14 11h6" />
        </svg>
      </button>
      <button className="tab-add" title="Open command palette (⌘K)" onClick={onAdd}>
        <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
      <span className="tsp" />
      {splitCount > 1 && (
        <span className="layout-hint">
          <svg viewBox="0 0 24 24" width={13} height={13} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="8" height="16" rx="1" />
            <rect x="13" y="4" width="8" height="16" rx="1" />
          </svg>
          {splitCount}-up split · drag a deck in for more
        </span>
      )}
    </div>
  )
}

/** Contextual action shelf below the card — labeled actions for the active deck. */
function ActionShelf({
  ws,
  primary,
  splitCount,
  actions
}: {
  ws: Workspace
  primary: Panel | undefined
  splitCount: number
  actions: ReturnType<typeof usePanelActions>
}): JSX.Element | null {
  if (!primary) return null
  const isNative = primary.kind === 'native'
  const icon = !isNative ? primary.favicon || faviconFor(primary.url) : ''

  return (
    <div className="shelf no-drag">
      <div className="ctx">
        <span className="cfav">
          {icon ? <img src={icon} alt="" draggable={false} /> : <span>{ws.glyph ?? '◻'}</span>}
        </span>
        <span className="ctt">
          <b>{primary.title || primary.id}</b> · {isNative ? 'native deck' : 'web deck'}
        </span>
      </div>
      <span className="ssep" />
      <div className="shelf-actions">
        <button className="sact" onClick={() => actions.reload(primary)}>
          <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
            <path d="M21 3v5h-5" />
          </svg>
          Reload
          <span className="kbd sk">{modCombo('R')}</span>
        </button>
        <button className="sact" onClick={actions.toggleFocusMode}>
          <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 9V5a1 1 0 0 1 1-1h4M20 9V5a1 1 0 0 0-1-1h-4M4 15v4a1 1 0 0 0 1 1h4M20 15v4a1 1 0 0 1-1 1h-4" />
          </svg>
          Focus
          <span className="kbd sk">{modCombo('.')}</span>
        </button>
        {splitCount > 1 && (
          <button className="sact" onClick={() => actions.pop(primary)}>
            <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 3h6v6M10 14L21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
            </svg>
            Pop out
          </button>
        )}
        <button className="sact" onClick={() => actions.close(primary)}>
          <svg viewBox="0 0 24 24" width={14} height={14} stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
          Close
        </button>
      </div>
      <span className="shint">
        <svg viewBox="0 0 24 24" width={13} height={13} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="9" /><path d="M12 16v-4M12 8h.01" />
        </svg>
        Drag a deck onto the card to split
      </span>
    </div>
  )
}

function DeckCard({
  panelId,
  ws,
  active,
  onActivate,
  actions,
  registerContent
}: {
  panelId: PanelId
  ws: Workspace
  active: boolean
  onActivate: (id: PanelId) => void
  actions: ReturnType<typeof usePanelActions>
  registerContent: (id: PanelId, el: HTMLElement | null) => void
}): JSX.Element {
  // Bumped by the rail "Reset decks" action / shelf reload to force a native
  // deck to remount.
  const reloadNonce = useStore((s) => s.panelReloadNonce[panelId] ?? 0)
  const deck = ws.panels.find((p) => p.id === panelId)
  const title = deck?.title || panelId
  const isNative = deck?.kind === 'native'
  const icon = deck && !isNative ? deck.favicon || faviconFor(deck.url) : ''
  // Only meaningful when this deck shares the workspace with others (a split).
  const inSplit = ws.panels.length > 1
  const single = ws.panels.length === 1

  return (
    <div
      className={`deck-pane${active && inSplit ? ' active' : ''}`}
      onMouseDown={() => onActivate(panelId)}
    >
      <div className="deck-head">
        <span className="fav">
          {icon ? <img src={icon} alt="" draggable={false} /> : <span>{ws.glyph ?? '◻'}</span>}
        </span>
        <span className="nm">{title}</span>
        <span
          className={`kind-chip ${isNative ? 'native' : 'web'}`}
          style={{ fontSize: 9, padding: '2px 6px' }}
          title={
            isNative
              ? 'Native: our UI on the app’s data — no browser engine, low RAM'
              : 'Web: sandboxed embedded page'
          }
        >
          <span className="dot" />
          {isNative ? 'native' : 'web'}
        </span>
        <span className="sp" />
        {inSplit && (
          <HeadBtn title="Make this its own deck" onClick={() => actions.pop(deck)}>
            <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 3h6v6M10 14L21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
            </svg>
          </HeadBtn>
        )}
        <HeadBtn title="Focus this deck (Ctrl/⌘+.)" onClick={actions.toggleFocusMode}>
          <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 9V5a1 1 0 0 1 1-1h4M20 9V5a1 1 0 0 0-1-1h-4M4 15v4a1 1 0 0 0 1 1h4M20 15v4a1 1 0 0 1-1 1h-4" />
          </svg>
        </HeadBtn>
        <HeadBtn title="Reload" onClick={() => actions.reload(deck)}>
          <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
            <path d="M21 3v5h-5" />
          </svg>
        </HeadBtn>
        <HeadBtn title="Close deck" onClick={() => actions.close(deck)} danger>
          <svg viewBox="0 0 24 24" width={14} height={14} stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </HeadBtn>
      </div>

      {/* Content. WEB: an empty slot the WebContentsView is positioned over
          (measured + reported via showOnly). NATIVE: our own React UI. */}
      {isNative && deck?.provider ? (
        <div className="deck-body">
          <NativeDeckHost
            key={reloadNonce}
            provider={deck.provider}
            accountId={deck.accountId ?? 'default'}
            panelId={panelId}
            workspaceId={ws.id}
          />
        </div>
      ) : (
        <div className="deck-body" ref={(el) => registerContent(panelId, el)}>
          {single && (
            <div className="split-ghost">
              <svg viewBox="0 0 24 24" width={22} height={22} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="4" width="8" height="16" rx="1" />
                <rect x="13" y="4" width="8" height="16" rx="1" strokeDasharray="3 3" />
              </svg>
              <div className="t">
                Drag a deck
                <br />
                here to split
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function renderNode(
  node: LayoutNode,
  ws: Workspace,
  activeTab: PanelId | null,
  onActivate: (id: PanelId) => void,
  actions: ReturnType<typeof usePanelActions>,
  registerContent: (id: PanelId, el: HTMLElement | null) => void
): JSX.Element {
  if (node.type === 'leaf') {
    if (!node.panelId) {
      return (
        <div className="grid h-full w-full place-items-center text-sm text-txt-4">
          No decks — press + to add one
        </div>
      )
    }
    return (
      <DeckCard
        key={node.panelId}
        panelId={node.panelId}
        ws={ws}
        active={node.panelId === activeTab}
        onActivate={onActivate}
        actions={actions}
        registerContent={registerContent}
      />
    )
  }
  const isRow = node.direction === 'row'
  // 1px gap over the line color renders a hairline divider between panes.
  return (
    <div
      className={`flex min-h-0 min-w-0 flex-1 ${isRow ? 'flex-row' : 'flex-col'}`}
      style={{ gap: 1, background: 'var(--line-2)' }}
    >
      {node.children.map((child, i) => (
        <div
          key={i}
          className="flex min-h-0 min-w-0"
          style={{ flexGrow: node.sizes[i] ?? 1 / node.children.length, flexShrink: 1, flexBasis: 0 }}
        >
          {renderNode(child, ws, activeTab, onActivate, actions, registerContent)}
        </div>
      ))}
    </div>
  )
}

function SplitView(): JSX.Element {
  const ws = useStore((s) => s.activeWorkspace())
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const view = useStore((s) => s.view)
  const dragging = useStore((s) => s.dragging)
  const addPanel = useStore((s) => s.addPanel)
  const openPalette = useStore((s) => s.openPalette)
  const workspaces = useStore((s) => s.workspaces)

  const [hotZone, setHotZone] = useState<'left' | 'right' | null>(null)
  // Visual emphasis only — which tab/pane is "current". Does not change layout.
  const [activeTab, setActiveTab] = useState<PanelId | null>(null)

  const containerRef = useRef<HTMLDivElement | null>(null)
  const contentRefs = useRef<Map<PanelId, HTMLElement>>(new Map())

  const layout = ws?.layout

  // Every pane in the layout (web + native), in tree order — drives the tab strip.
  const allLayoutIds = useMemo(() => {
    if (!layout) return [] as PanelId[]
    const ids: PanelId[] = []
    collectPanelIds(layout, ids)
    return ids.filter(Boolean)
  }, [layout])

  // Only WEB panels get a WebContentsView in main, so only they are reported via
  // showOnly/bounds. Native panels render entirely in the renderer.
  const panelIds = useMemo(() => {
    const nativeIds = new Set((ws?.panels ?? []).filter((p) => p.kind === 'native').map((p) => p.id))
    return allLayoutIds.filter((id) => !nativeIds.has(id))
  }, [allLayoutIds, ws?.panels])

  // Keep the active-tab selection valid as panes come and go.
  useEffect(() => {
    if (allLayoutIds.length === 0) {
      if (activeTab !== null) setActiveTab(null)
      return
    }
    if (!activeTab || !allLayoutIds.includes(activeTab)) setActiveTab(allLayoutIds[0])
  }, [allLayoutIds, activeTab])

  const registerContent = useCallback((id: PanelId, el: HTMLElement | null) => {
    if (el) contentRefs.current.set(id, el)
    else contentRefs.current.delete(id)
  }, [])

  const measureAndReport = useCallback(() => {
    const bounds: Record<PanelId, PanelBounds> = {}
    for (const id of panelIds) {
      const el = contentRefs.current.get(id)
      if (!el) continue
      const r = el.getBoundingClientRect()
      bounds[id] = {
        x: Math.round(r.left),
        y: Math.round(r.top),
        width: Math.round(r.width),
        height: Math.round(r.height)
      }
    }
    const ids = Object.keys(bounds)
    if (ids.length) window.decks?.panel.showOnly({ panelIds: ids, bounds })
    else window.decks?.panel.hideAll()
  }, [panelIds])

  useLayoutEffect(() => {
    measureAndReport()
    const raf = requestAnimationFrame(measureAndReport)
    return () => cancelAnimationFrame(raf)
  }, [measureAndReport, activeWorkspaceId])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => measureAndReport())
    ro.observe(el)
    const onWin = (): void => measureAndReport()
    window.addEventListener('resize', onWin)
    const onAnim = (): void => measureAndReport()
    el.addEventListener('animationend', onAnim)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', onWin)
      el.removeEventListener('animationend', onAnim)
    }
  }, [measureAndReport, activeWorkspaceId])

  const atMax = allLayoutIds.length >= MAX_PANELS

  const actions = usePanelActions(ws ?? ({ id: '', panels: [] } as unknown as Workspace))

  // Drop a rail deck onto a split zone → add it to the ACTIVE workspace split.
  const onDropZone = (e: React.DragEvent, zone: 'left' | 'right'): void => {
    e.preventDefault()
    setHotZone(null)
    const draggedId = e.dataTransfer.getData(DECKS_WS_DND)
    if (!draggedId || !activeWorkspaceId || draggedId === activeWorkspaceId || atMax) return
    const draggedWs = workspaces.find((w) => w.id === draggedId)
    const primary = draggedWs?.panels[0]
    if (!primary) return
    addPanel(activeWorkspaceId, {
      id: crypto.randomUUID(),
      title: primary.title,
      url: primary.url,
      kind: primary.kind,
      provider: primary.provider,
      accountId: primary.accountId,
      // 'left' prepends visually via the layout's row order; addPanel appends, so
      // we leave order as-is (both zones add the deck — the split is even).
      favicon: primary.favicon
    })
    void zone
  }

  if (!ws || !layout) return <div className="page-area" />

  // Only expose the drop zones while a rail tile is being dragged onto a workspace.
  const armed = dragging && view === 'workspace'
  const primary = ws.panels.find((p) => p.id === activeTab) ?? ws.panels.find((p) => allLayoutIds.includes(p.id))

  return (
    <div className="page-area workspace">
      <TabStrip
        ws={ws}
        panelIds={allLayoutIds}
        activeTab={activeTab}
        onActivate={setActiveTab}
        onClose={actions.close}
        onSplit={openPalette}
        onAdd={openPalette}
      />

      <div className="page-card">
        <div
          key={activeWorkspaceId ?? 'none'}
          ref={containerRef}
          className="splitview-enter flex min-h-0 min-w-0 flex-1"
        >
          {renderNode(layout, ws, activeTab, setActiveTab, actions, registerContent)}
        </div>

        {/* drag-to-split drop zones (appear while dragging a tile) */}
        <div className={`dropzones ${armed ? 'armed' : ''}`}>
          {(['left', 'right'] as const).map((z) => (
            <div
              key={z}
              className={`dz ${hotZone === z ? 'hot' : ''} ${atMax ? 'opacity-50' : ''}`}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes(DECKS_WS_DND)) return
                e.preventDefault()
                e.dataTransfer.dropEffect = atMax ? 'none' : 'move'
                setHotZone(z)
              }}
              onDragLeave={() => setHotZone((h) => (h === z ? null : h))}
              onDrop={(e) => onDropZone(e, z)}
            >
              <svg viewBox="0 0 24 24" width={26} height={26} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="4" width="8" height="16" rx="1" />
                <rect x="13" y="4" width="8" height="16" rx="1" />
              </svg>
              <div className="lab">{atMax ? 'Max 4 decks' : `Split ${z}`}</div>
              <div className="sub">{atMax ? 'Close one first' : 'Release to add this deck'}</div>
            </div>
          ))}
        </div>
      </div>

      <ActionShelf ws={ws} primary={primary} splitCount={allLayoutIds.length} actions={actions} />
    </div>
  )
}

export default SplitView
