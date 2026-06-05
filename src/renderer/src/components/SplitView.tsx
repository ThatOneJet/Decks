/**
 * SplitView — the workspace surface: the active workspace's decks as cards.
 *
 * Each leaf in the layout tree renders a DECK CARD = a header bar (favicon +
 * title + reload + delete ✕) over an empty CONTENT area. The real page is a
 * native WebContentsView owned by main; this component measures each card's
 * CONTENT rect (below the header) and reports it via panel.showOnly so the view
 * sits under the card chrome. Re-measures on workspace/layout change + resize.
 *
 * Deleting a deck destroys its view (main) and prunes it from the layout (store).
 * No props (reads the active workspace from the store).
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
  const focusMode = useStore((s) => s.focusMode)
  const toggleFocusMode = useStore((s) => s.toggleFocusMode)
  const deck = ws.panels.find((p) => p.id === panelId)
  const title = deck?.title || panelId
  // A native deck renders OUR React UI in the body (no WebContentsView in main).
  const isNative = deck?.kind === 'native'
  const icon = deck && !isNative ? deck.favicon || faviconFor(deck.url) : ''

  // Native decks have no main-process view: reload = remount the React subtree
  // (bump a key) rather than calling panel.reload. Web decks reload the view.
  const [nativeReloadKey, setNativeReloadKey] = useState(0)
  const onReload = (): void => {
    if (isNative) setNativeReloadKey((k) => k + 1)
    else void window.decks?.panel.reload(panelId)
  }
  const onDelete = (): void => {
    // No-op in main for native decks (no view to destroy), but harmless.
    if (!isNative) window.decks?.panel.destroy(panelId)
    removePanel(ws.id, panelId)
  }

  return (
    <div className="flex h-full w-full min-h-0 min-w-0 flex-col overflow-hidden rounded-t-xl2 bg-bg-panel">
      {/* Card header */}
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line bg-bg-elevated px-2.5">
        {icon ? (
          <img src={icon} alt="" className="h-3.5 w-3.5 rounded-sm object-contain" draggable={false} />
        ) : (
          <span className="text-xs">{ws.glyph ?? '◻'}</span>
        )}
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-txt-2">{title}</span>
        <button
          onClick={toggleFocusMode}
          title={focusMode ? 'Exit focus (Ctrl/⌘+.)' : 'Focus this deck (Ctrl/⌘+.)'}
          className="grid h-5 w-5 place-items-center rounded text-txt-4 hover:bg-bg-panel hover:text-txt-1"
        >
          {focusMode ? (
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 4v4a1 1 0 0 1-1 1H4M20 9h-4a1 1 0 0 1-1-1V4M15 20v-4a1 1 0 0 1 1-1h4M4 15h4a1 1 0 0 1 1 1v4" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 9V5a1 1 0 0 1 1-1h4M20 9V5a1 1 0 0 0-1-1h-4M4 15v4a1 1 0 0 0 1 1h4M20 15v4a1 1 0 0 1-1 1h-4" />
            </svg>
          )}
        </button>
        <button
          onClick={onReload}
          title="Reload"
          className="grid h-5 w-5 place-items-center rounded text-txt-4 hover:bg-bg-panel hover:text-txt-1"
        >
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
            <path d="M21 3v5h-5" />
          </svg>
        </button>
        <button
          onClick={onDelete}
          title="Delete deck"
          className="grid h-5 w-5 place-items-center rounded text-txt-4 hover:bg-err hover:text-white"
        >
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </div>
      {/* Content area. WEB decks: an empty slot the WebContentsView is positioned
          over (measured + reported via showOnly). NATIVE decks: our own React UI,
          NOT registered as a slot (main has no view for them). */}
      {isNative && deck?.provider ? (
        <div className="min-h-0 flex-1 overflow-auto bg-bg">
          <NativeDeckHost
            key={nativeReloadKey}
            provider={deck.provider}
            panelId={panelId}
            workspaceId={ws.id}
          />
        </div>
      ) : (
        <div ref={(el) => registerContent(panelId, el)} className="min-h-0 flex-1 bg-bg" />
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
        <div className="grid h-full w-full place-items-center rounded-xl2 border border-dashed border-line text-sm text-txt-4">
          No decks — press + to add one
        </div>
      )
    }
    return <DeckCard key={node.panelId} panelId={node.panelId} ws={ws} registerContent={registerContent} />
  }
  const isRow = node.direction === 'row'
  return (
    <div className={`flex min-h-0 min-w-0 flex-1 gap-px bg-bg-rail ${isRow ? 'flex-row' : 'flex-col'}`}>
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

  const [dropActive, setDropActive] = useState(false)
  const [maxHint, setMaxHint] = useState(false)

  const containerRef = useRef<HTMLDivElement | null>(null)
  const contentRefs = useRef<Map<PanelId, HTMLElement>>(new Map())

  const layout = ws?.layout
  // Only WEB panels get a WebContentsView in main, so only they are reported via
  // showOnly/bounds. Native panels render entirely in the renderer (NativeDeckHost)
  // and must be EXCLUDED here — otherwise main would try to position a view it has
  // no record of.
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

  // Count ALL decks (web + native) for the cap — panelIds excludes native, so
  // collect straight from the layout here.
  const allLayoutIds = useMemo(() => {
    if (!layout) return [] as PanelId[]
    const ids: PanelId[] = []
    collectPanelIds(layout, ids)
    return ids
  }, [layout])
  const panelCount = allLayoutIds.filter(Boolean).length
  const atMax = panelCount >= MAX_PANELS

  // Drop a rail deck onto the page area to split the ACTIVE workspace evenly.
  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    setDropActive(false)
    const draggedId = e.dataTransfer.getData(DECKS_WS_DND)
    if (!draggedId || !activeWorkspaceId) return
    if (draggedId === activeWorkspaceId) return // dropping a deck onto itself: ignore
    if (atMax) {
      // Cap reached — flash a subtle "max 4" hint and bail.
      setMaxHint(true)
      setTimeout(() => setMaxHint(false), 1200)
      return
    }
    const draggedWs = workspaces.find((w) => w.id === draggedId)
    const primary = draggedWs?.panels[0]
    if (!primary) return
    // addPanel grafts a new leaf into the split via addLeaf (even-ish). App's
    // ensure-create makes the native view; SplitView re-measures on next render.
    addPanel(activeWorkspaceId, {
      id: crypto.randomUUID(),
      title: primary.title,
      url: primary.url
    })
  }

  if (!ws || !layout) return <div className="h-full w-full bg-bg" />

  // Only expose the page as a drop target while a rail tile is being dragged
  // and we're actually showing a workspace.
  const dropEnabled = dragging && view === 'workspace'

  return (
    <div className="relative h-full w-full bg-bg-rail">
      <div key={activeWorkspaceId ?? 'none'} ref={containerRef} className="splitview-enter flex h-full w-full gap-px bg-bg-rail">
        {renderNode(layout, ws, registerContent)}
      </div>

      {dropEnabled && (
        <div
          className="absolute inset-0 z-40"
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes(DECKS_WS_DND)) return
            e.preventDefault()
            e.dataTransfer.dropEffect = atMax ? 'none' : 'move'
            setDropActive(true)
          }}
          onDragLeave={(e) => {
            // Ignore leaves bubbling from children inside the overlay.
            if (e.currentTarget.contains(e.relatedTarget as Node)) return
            setDropActive(false)
          }}
          onDrop={onDrop}
        >
          <div
            className={`pointer-events-none absolute inset-3 grid place-items-center rounded-xl2 border-2 border-dashed transition-all ${
              dropActive
                ? atMax
                  ? 'border-err bg-err/5'
                  : 'border-accent bg-accent-soft/40'
                : 'border-line/60 bg-bg/30'
            }`}
          >
            <div
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                atMax ? 'text-err' : 'text-accent'
              } ${dropActive ? 'opacity-100' : 'opacity-70'}`}
            >
              {atMax ? 'Max 4 decks' : 'Drop to split'}
            </div>
          </div>
        </div>
      )}

      {maxHint && (
        <div className="pointer-events-none absolute left-1/2 top-4 z-50 -translate-x-1/2 rounded-lg bg-err px-3 py-1.5 text-sm font-medium text-white shadow-lg">
          Max 4 decks reached
        </div>
      )}
    </div>
  )
}

export default SplitView
