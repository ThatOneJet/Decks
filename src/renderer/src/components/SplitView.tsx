/**
 * SplitView — the floating page card the chrome wraps around.
 *
 * The active workspace's layout tree renders as deck PANES inside one rounded,
 * glowing `.page-card` that sits flush against the dock + header (minimal inset).
 * Each leaf = a `.deck-pane` with a compact `.deck-head` (icon + name + Native/Web
 * chip + pop-out / focus / reload / close) over a `.deck-body`. WEB panes: the
 * body is an empty slot whose pixel rect is measured and reported via
 * panel.showOnly so the native WebContentsView sits under the chrome. NATIVE
 * panes: the body renders our React deck (NativeDeckHost).
 *
 * Responsive: in LANDSCAPE splits are side-by-side (row); in PORTRAIT they stack
 * (column). While ANY DOM overlay is open (command palette, add-deck, a Console
 * panel, the tour) the native views are hidden so they never punch through it.
 *
 * Drag a dock tile onto the card → glowing Split-left / Split-right drop zones.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import type { LayoutNode, Panel, PanelBounds, PanelId, Workspace } from '@shared/types'
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

/** Per-panel handlers shared by every pane head. */
function usePanelActions(ws: Workspace): {
  reload: (deck: Panel | undefined) => void
  close: (deck: Panel | undefined) => void
  pop: (deck: Panel | undefined) => void
  toggleFocusMode: () => void
} {
  const removePanel = useStore((s) => s.removePanel)
  const popPanelOut = useStore((s) => s.popPanelOut)
  const toggleFocusMode = useStore((s) => s.toggleFocusMode)
  const bumpPanelReload = useStore((s) => s.bumpPanelReload)

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

function DeckCard({
  panelId,
  ws,
  actions,
  registerContent
}: {
  panelId: PanelId
  ws: Workspace
  actions: ReturnType<typeof usePanelActions>
  registerContent: (id: PanelId, el: HTMLElement | null) => void
}): JSX.Element {
  // Bumped by the rail "Reset decks" action to force a native deck to remount.
  const reloadNonce = useStore((s) => s.panelReloadNonce[panelId] ?? 0)
  // Two-step confirm so a stray click can't delete a deck (and log you out).
  const [confirmClose, setConfirmClose] = useState(false)
  useEffect(() => {
    if (!confirmClose) return
    const t = setTimeout(() => setConfirmClose(false), 3000)
    return () => clearTimeout(t)
  }, [confirmClose])
  const deck = ws.panels.find((p) => p.id === panelId)
  const title = deck?.title || panelId
  const isNative = deck?.kind === 'native'
  const icon = deck && !isNative ? deck.favicon || faviconFor(deck.url) : ''
  const inSplit = ws.panels.length > 1
  const single = ws.panels.length === 1

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
        {!isNative && (
          <HeadBtn
            title="Sign in (opens a real browser window — fixes Google &quot;browser not secure&quot;)"
            onClick={() => deck && window.decks?.panel.signIn(deck.id)}
          >
            <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
              <path d="M10 17l5-5-5-5" />
              <path d="M15 12H3" />
            </svg>
          </HeadBtn>
        )}
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
        <HeadBtn
          title={confirmClose ? 'Click again to remove this deck (your login is kept)' : 'Close deck'}
          onClick={() => {
            if (confirmClose) actions.close(deck)
            else setConfirmClose(true)
          }}
          danger
        >
          {confirmClose ? (
            <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
          ) : (
            <svg viewBox="0 0 24 24" width={14} height={14} stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
          )}
        </HeadBtn>
      </div>

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
  portrait: boolean,
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
    return <DeckCard key={node.panelId} panelId={node.panelId} ws={ws} actions={actions} registerContent={registerContent} />
  }
  // Portrait stacks every split vertically; landscape honors the node's direction.
  const isRow = portrait ? false : node.direction === 'row'
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
          {renderNode(child, ws, portrait, actions, registerContent)}
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
  // Any DOM overlay that must sit ABOVE the native web views.
  const paletteOpen = useStore((s) => s.paletteOpen)
  const addDeckOpen = useStore((s) => s.addDeckOpen)
  const consolePanel = useStore((s) => s.consolePanel)
  const tourOpen = useStore((s) => s.tourOpen)
  const overlayOpen = paletteOpen || addDeckOpen || consolePanel !== 'none' || tourOpen

  const [hotZone, setHotZone] = useState<'left' | 'right' | null>(null)
  const [portrait, setPortrait] = useState(
    () => typeof window !== 'undefined' && window.innerHeight > window.innerWidth
  )
  useEffect(() => {
    const f = (): void => setPortrait(window.innerHeight > window.innerWidth)
    window.addEventListener('resize', f)
    return () => window.removeEventListener('resize', f)
  }, [])

  const containerRef = useRef<HTMLDivElement | null>(null)
  const contentRefs = useRef<Map<PanelId, HTMLElement>>(new Map())

  const layout = ws?.layout

  const allLayoutIds = useMemo(() => {
    if (!layout) return [] as PanelId[]
    const ids: PanelId[] = []
    collectPanelIds(layout, ids)
    return ids.filter(Boolean)
  }, [layout])

  // Only WEB panels get a WebContentsView in main, so only they are positioned.
  const panelIds = useMemo(() => {
    const nativeIds = new Set((ws?.panels ?? []).filter((p) => p.kind === 'native').map((p) => p.id))
    return allLayoutIds.filter((id) => !nativeIds.has(id))
  }, [allLayoutIds, ws?.panels])

  const registerContent = useCallback((id: PanelId, el: HTMLElement | null) => {
    if (el) contentRefs.current.set(id, el)
    else contentRefs.current.delete(id)
  }, [])

  const measureAndReport = useCallback(() => {
    // While a DOM overlay is up, keep ALL native views hidden so they never punch
    // through it (they always paint above the DOM).
    if (overlayOpen) {
      window.decks?.panel.hideAll()
      return
    }
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

    // TEMP DIAGNOSTIC: log the layout rects so we can see what's mispositioned on
    // collapse. Captured to a file by the main process. Remove once fixed.
    try {
      const cont = containerRef.current
      const card = cont?.closest('.page-card') as HTMLElement | null
      const area = cont?.closest('.page-area') as HTMLElement | null
      const pane = cont?.querySelector('.deck-pane') as HTMLElement | null
      const body = cont?.querySelector('.deck-body') as HTMLElement | null
      const r = (el: Element | null): unknown => {
        if (!el) return null
        const b = el.getBoundingClientRect()
        return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }
      }
      console.log(
        'DECKS_LAYOUT::' +
          JSON.stringify({
            win: { w: window.innerWidth, h: window.innerHeight },
            railClass: document.querySelector('.console')?.className,
            area: r(area),
            card: r(card),
            container: r(cont),
            pane: r(pane),
            body: r(body),
            bounds
          })
      )
    } catch {
      /* ignore */
    }
  }, [panelIds, overlayOpen])

  useLayoutEffect(() => {
    measureAndReport()
    const raf = requestAnimationFrame(measureAndReport)
    return () => cancelAnimationFrame(raf)
  }, [measureAndReport, activeWorkspaceId, portrait])

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
      favicon: primary.favicon
    })
    void zone
  }

  if (!ws || !layout) return <div className="page-area" />

  const armed = dragging && view === 'workspace'
  // Portrait drop zones split top/bottom; landscape left/right.
  const zones = portrait ? (['left', 'right'] as const) : (['left', 'right'] as const)

  return (
    <div className="page-area">
      <div className="page-card">
        <div
          key={activeWorkspaceId ?? 'none'}
          ref={containerRef}
          className="splitview-enter flex min-h-0 min-w-0 flex-1"
        >
          {renderNode(layout, ws, portrait, actions, registerContent)}
        </div>

        {/* drag-to-split drop zones (appear while dragging a tile) */}
        <div className={`dropzones ${armed ? 'armed' : ''}`} style={portrait ? { flexDirection: 'column' } : undefined}>
          {zones.map((z) => (
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
              <div className="lab">{atMax ? 'Max 4 decks' : portrait ? (z === 'left' ? 'Split top' : 'Split bottom') : `Split ${z}`}</div>
              <div className="sub">{atMax ? 'Close one first' : 'Release to add this deck'}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export default SplitView
