/**
 * SplitView — the floating page card the chrome wraps around.
 *
 * The active workspace's layout tree renders as deck PANES inside one rounded,
 * glowing `.page-card`. Each leaf = a `.deck-pane` with a `.deck-head` (icon +
 * name + Native/Web chip + pop-out / focus / reload / close) over a `.deck-body`.
 * WEB panes: the body is an empty slot whose pixel rect is measured and reported
 * via panel.showOnly so the native WebContentsView sits under the chrome. NATIVE
 * panes: the body renders our React deck (NativeDeckHost) — no view, not measured.
 *
 * Drag a rail tile onto the card and glowing Split-left / Split-right zones appear
 * (the redesign's discoverability win). All behaviors — the layout tree, the
 * discard/measure pipeline, native vs web, pop-out, reload, close — are preserved.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import type { LayoutNode, PanelBounds, PanelId, Workspace } from '@shared/types'
import { faviconFor } from '../lib/favicon'
import { DECKS_WS_DND } from './sidebar/WorkspaceItem'
import NativeDeckHost from '../native/NativeDeckHost'
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

function DeckCard({
  panelId,
  ws,
  registerContent
}: {
  panelId: PanelId
  ws: Workspace
  registerContent: (id: PanelId, el: HTMLElement | null) => void
}): JSX.Element {
  const removePanel = useStore((s) => s.removePanel)
  const popPanelOut = useStore((s) => s.popPanelOut)
  const toggleFocusMode = useStore((s) => s.toggleFocusMode)
  // Bumped by the rail "Reset decks" action to force a native deck to remount.
  const reloadNonce = useStore((s) => s.panelReloadNonce[panelId] ?? 0)
  const deck = ws.panels.find((p) => p.id === panelId)
  const title = deck?.title || panelId
  const isNative = deck?.kind === 'native'
  const icon = deck && !isNative ? deck.favicon || faviconFor(deck.url) : ''
  // Only meaningful when this deck shares the workspace with others (a split).
  const inSplit = ws.panels.length > 1
  const single = ws.panels.length === 1

  // Native decks have no main-process view: reload = remount the React subtree
  // (bump a key) rather than calling panel.reload. Web decks reload the view.
  const [nativeReloadKey, setNativeReloadKey] = useState(0)
  const onReload = (): void => {
    if (isNative) setNativeReloadKey((k) => k + 1)
    else void window.decks?.panel.reload(panelId)
  }
  const onDelete = (): void => {
    if (!isNative) window.decks?.panel.destroy(panelId)
    removePanel(ws.id, panelId)
  }

  return (
    <div className="deck-pane">
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
          <HeadBtn title="Make this its own deck" onClick={() => popPanelOut(ws.id, panelId)}>
            <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 3h6v6M10 14L21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
            </svg>
          </HeadBtn>
        )}
        <HeadBtn title="Focus this deck (Ctrl/⌘+.)" onClick={toggleFocusMode}>
          <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 9V5a1 1 0 0 1 1-1h4M20 9V5a1 1 0 0 0-1-1h-4M4 15v4a1 1 0 0 0 1 1h4M20 15v4a1 1 0 0 1-1 1h-4" />
          </svg>
        </HeadBtn>
        <HeadBtn title="Reload" onClick={onReload}>
          <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
            <path d="M21 3v5h-5" />
          </svg>
        </HeadBtn>
        <HeadBtn title="Close deck" onClick={onDelete} danger>
          <svg viewBox="0 0 24 24" width={14} height={14} stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </HeadBtn>
      </div>

      {/* Content. WEB: an empty slot the WebContentsView is positioned over
          (measured + reported via showOnly). NATIVE: our own React UI. */}
      {isNative && deck?.provider ? (
        <div className="deck-body">
          <NativeDeckHost
            key={`${nativeReloadKey}-${reloadNonce}`}
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
    return <DeckCard key={node.panelId} panelId={node.panelId} ws={ws} registerContent={registerContent} />
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
          {renderNode(child, ws, registerContent)}
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
  const workspaces = useStore((s) => s.workspaces)

  const [hotZone, setHotZone] = useState<'left' | 'right' | null>(null)

  const containerRef = useRef<HTMLDivElement | null>(null)
  const contentRefs = useRef<Map<PanelId, HTMLElement>>(new Map())

  const layout = ws?.layout
  // Only WEB panels get a WebContentsView in main, so only they are reported via
  // showOnly/bounds. Native panels render entirely in the renderer.
  const panelIds = useMemo(() => {
    if (!layout) return [] as PanelId[]
    const ids: PanelId[] = []
    collectPanelIds(layout, ids)
    const nativeIds = new Set((ws?.panels ?? []).filter((p) => p.kind === 'native').map((p) => p.id))
    return ids.filter((id) => !nativeIds.has(id))
  }, [layout, ws?.panels])

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

  // Count ALL decks (web + native) for the cap.
  const allLayoutIds = useMemo(() => {
    if (!layout) return [] as PanelId[]
    const ids: PanelId[] = []
    collectPanelIds(layout, ids)
    return ids
  }, [layout])
  const atMax = allLayoutIds.filter(Boolean).length >= MAX_PANELS

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

  return (
    <div className="page-area">
      <div className="page-card">
        <div
          key={activeWorkspaceId ?? 'none'}
          ref={containerRef}
          className="splitview-enter flex min-h-0 min-w-0 flex-1"
        >
          {renderNode(layout, ws, registerContent)}
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
    </div>
  )
}

export default SplitView
