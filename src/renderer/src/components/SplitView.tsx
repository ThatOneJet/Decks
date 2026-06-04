/**
 * SplitView — the workspace surface (shown when view==='workspace').
 *
 * Renders the active workspace's `layout` (LayoutNode tree) as nested flex
 * containers, producing one empty positioned SLOT per leaf panelId. It draws NO
 * web content — the real pages are native WebContentsViews owned by main.
 *
 * GEOMETRY CONTRACT (the critical part): after layout/render and on every
 * resize, each leaf slot's pixel rect is measured via getBoundingClientRect()
 * in viewport coordinates (main positions views in window coords), rounded to
 * ints, collected into a `bounds` map keyed by panelId, and reported via
 * window.decks.panel.showOnly({ panelIds, bounds }). Re-measured on: workspace
 * change, layout change, container resize (ResizeObserver) and window resize,
 * plus a rAF after mount so the first measure is post-layout.
 *
 * Workspace-switch motion: a short, non-looping fade/scale-in entrance keyed on
 * the active workspace id (no looping animation behind the live web panels).
 *
 * No props (reads activeWorkspace from the store).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { useStore } from '../store'
import type { LayoutNode, PanelBounds, PanelId } from '@shared/types'
import './home/splitview.css'

/** Collect every leaf panelId in the tree (left-to-right, depth-first). */
function collectPanelIds(node: LayoutNode, out: PanelId[]): void {
  if (node.type === 'leaf') {
    out.push(node.panelId)
    return
  }
  for (const child of node.children) collectPanelIds(child, out)
}

/** Recursively render the layout tree as nested flex containers + leaf slots. */
function renderNode(
  node: LayoutNode,
  slotRefs: Map<PanelId, HTMLElement>,
  titleFor: (id: PanelId) => string
): JSX.Element {
  if (node.type === 'leaf') {
    const { panelId } = node
    return (
      <div
        key={panelId}
        data-panel-id={panelId}
        ref={(el) => {
          if (el) slotRefs.set(panelId, el)
          else slotRefs.delete(panelId)
        }}
        className="relative min-h-0 min-w-0 flex-1 overflow-hidden rounded-xl2 border border-line bg-bg-panel"
      >
        {/* subtle label; the native web view is positioned over this slot */}
        <span className="pointer-events-none absolute left-3 top-2 select-none text-[11px] font-medium text-txt-4">
          {titleFor(panelId)}
        </span>
      </div>
    )
  }

  const isRow = node.direction === 'row'
  return (
    <div
      className={`flex min-h-0 min-w-0 flex-1 gap-2 ${isRow ? 'flex-row' : 'flex-col'}`}
    >
      {node.children.map((child, i) => {
        const weight = node.sizes[i] ?? 1 / node.children.length
        return (
          <div
            key={i}
            className="flex min-h-0 min-w-0"
            style={{ flexGrow: weight, flexShrink: 1, flexBasis: 0 }}
          >
            {renderNode(child, slotRefs, titleFor)}
          </div>
        )
      })}
    </div>
  )
}

function SplitView(): JSX.Element {
  const ws = useStore((s) => s.activeWorkspace())
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)

  const containerRef = useRef<HTMLDivElement | null>(null)
  // Live registry of leaf slot DOM nodes, keyed by panelId.
  const slotRefs = useRef<Map<PanelId, HTMLElement>>(new Map())

  const layout = ws?.layout
  const panelIds = useMemo(() => {
    if (!layout) return [] as PanelId[]
    const ids: PanelId[] = []
    collectPanelIds(layout, ids)
    return ids
  }, [layout])

  const titleFor = useCallback(
    (id: PanelId) => ws?.panels.find((p) => p.id === id)?.title ?? id,
    [ws]
  )

  /** Measure each leaf slot and report rects to main so it positions views. */
  const measureAndReport = useCallback(() => {
    if (!panelIds.length) return
    const bounds: Record<PanelId, PanelBounds> = {}
    for (const id of panelIds) {
      const el = slotRefs.current.get(id)
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
    if (!ids.length) return
    window.decks?.panel.showOnly({ panelIds: ids, bounds })
  }, [panelIds])

  // Measure synchronously after DOM layout, then again on the next frame so the
  // very first report lands after fonts/flex settle. Re-runs on ws/layout change.
  useLayoutEffect(() => {
    measureAndReport()
    const raf = requestAnimationFrame(measureAndReport)
    return () => cancelAnimationFrame(raf)
  }, [measureAndReport, activeWorkspaceId])

  // Re-measure on container resize and window resize.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => measureAndReport())
    ro.observe(el)
    const onWinResize = (): void => measureAndReport()
    window.addEventListener('resize', onWinResize)
    // The entrance animation scales the container; re-measure once it settles so
    // the final reported rects use steady-state (scale(1)) geometry.
    const onAnimEnd = (): void => measureAndReport()
    el.addEventListener('animationend', onAnimEnd)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', onWinResize)
      el.removeEventListener('animationend', onAnimEnd)
    }
    // activeWorkspaceId is included so the observer re-binds to the freshly
    // remounted container element after a workspace switch.
  }, [measureAndReport, activeWorkspaceId])

  if (!ws || !layout) {
    return <div className="h-full w-full bg-bg" />
  }

  return (
    <div className="h-full w-full bg-bg p-2">
      {/* keyed on workspace id → React remounts → entrance animation replays */}
      <div
        key={activeWorkspaceId ?? 'none'}
        ref={containerRef}
        className="splitview-enter flex h-full w-full"
      >
        {renderNode(layout, slotRefs.current, titleFor)}
      </div>
    </div>
  )
}

export default SplitView
