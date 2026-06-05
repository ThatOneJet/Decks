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
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { useStore } from '../store'
import type { LayoutNode, PanelBounds, PanelId, Workspace } from '@shared/types'
import { faviconFor } from '../lib/favicon'
import './home/splitview.css'

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
  const deck = ws.panels.find((p) => p.id === panelId)
  const title = deck?.title || panelId
  const icon = deck ? deck.favicon || faviconFor(deck.url) : ''

  const onReload = (): void => void window.decks?.panel.reload(panelId)
  const onDelete = (): void => {
    window.decks?.panel.destroy(panelId)
    removePanel(ws.id, panelId)
  }

  return (
    <div className="flex h-full w-full min-h-0 min-w-0 flex-col overflow-hidden bg-bg-panel">
      {/* Card header */}
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line bg-bg-elevated px-2.5">
        {icon ? (
          <img src={icon} alt="" className="h-3.5 w-3.5 rounded-sm object-contain" draggable={false} />
        ) : (
          <span className="text-xs">{ws.glyph ?? '◻'}</span>
        )}
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-txt-2">{title}</span>
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
      {/* Content area — the native web view is positioned over THIS rect. */}
      <div ref={(el) => registerContent(panelId, el)} className="min-h-0 flex-1 bg-bg" />
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
    <div className={`flex min-h-0 min-w-0 flex-1 gap-px bg-line ${isRow ? 'flex-row' : 'flex-col'}`}>
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

  const containerRef = useRef<HTMLDivElement | null>(null)
  const contentRefs = useRef<Map<PanelId, HTMLElement>>(new Map())

  const layout = ws?.layout
  const panelIds = useMemo(() => {
    if (!layout) return [] as PanelId[]
    const ids: PanelId[] = []
    collectPanelIds(layout, ids)
    return ids
  }, [layout])

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

  if (!ws || !layout) return <div className="h-full w-full bg-bg" />

  return (
    <div className="h-full w-full bg-bg">
      <div key={activeWorkspaceId ?? 'none'} ref={containerRef} className="splitview-enter flex h-full w-full gap-px bg-line">
        {renderNode(layout, ws, registerContent)}
      </div>
    </div>
  )
}

export default SplitView
