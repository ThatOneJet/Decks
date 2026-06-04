/**
 * Decks — app shell + Phase 2 integration seam.
 *
 * Lays out the four surfaces (Sidebar / Home / SplitView / CommandPalette) and
 * wires them to the main process through window.decks (the IPC contract):
 *   1. bootstrap   — hydrate persisted state, else seed; restore last workspace.
 *   2. ensure-create — every panel of the active workspace exists as a native
 *      WebContentsView before SplitView positions it via showOnly.
 *   3. live updates — onPanelUpdate → store.patchPanel (title/favicon/loading/nav).
 *   4. persistence — debounced save of the full PersistedState on any change.
 */
import { useEffect, useRef } from 'react'
import { useStore } from './store'
import Titlebar from './components/Titlebar'
import Sidebar from './components/Sidebar'
import Home from './components/Home'
import SplitView from './components/SplitView'
import CommandPalette from './components/CommandPalette'
import { seedWorkspaces } from '@shared/seed'
import type { PersistedState } from '@shared/types'

const STATE_VERSION = 1

function App(): JSX.Element {
  const view = useStore((s) => s.view)
  const workspaces = useStore((s) => s.workspaces)
  const theme = useStore((s) => s.theme)
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const setWorkspaces = useStore((s) => s.setWorkspaces)
  const activateWorkspace = useStore((s) => s.activateWorkspace)
  const patchPanel = useStore((s) => s.patchPanel)
  const togglePalette = useStore((s) => s.togglePalette)
  const closePalette = useStore((s) => s.closePalette)

  const hydrated = useRef(false)
  const createdPanels = useRef<Set<string>>(new Set())

  // ── 1. Bootstrap: hydrate from disk, else seed; restore last workspace. ──
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const persisted = await window.decks?.state.load().catch(() => null)
      if (cancelled) return
      const ws =
        persisted && persisted.workspaces.length ? persisted.workspaces : seedWorkspaces()
      setWorkspaces(ws)
      if (persisted?.theme) useStore.getState().setTheme(persisted.theme)
      hydrated.current = true
      // Restore the previously active workspace (recreates its views via effect 2).
      if (persisted?.activeWorkspaceId && ws.some((w) => w.id === persisted.activeWorkspaceId)) {
        activateWorkspace(persisted.activeWorkspaceId)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [setWorkspaces, activateWorkspace])

  // ── 2. Ensure every panel of the active workspace exists as a native view. ──
  // SplitView reports slot rects via showOnly; the view must exist first.
  useEffect(() => {
    if (view !== 'workspace' || !activeWorkspaceId) return
    const ws = workspaces.find((w) => w.id === activeWorkspaceId)
    if (!ws) return
    for (const panel of ws.panels) {
      if (createdPanels.current.has(panel.id)) continue
      createdPanels.current.add(panel.id)
      window.decks?.panel
        .create({
          panelId: panel.id,
          workspaceId: ws.id,
          partition: ws.partition,
          url: panel.url,
          bounds: { x: 0, y: 0, width: 800, height: 600 }
        })
        .catch(() => createdPanels.current.delete(panel.id))
    }
  }, [view, activeWorkspaceId, workspaces])

  // ── 3. Live panel updates from main → store. ──
  useEffect(() => {
    const off = window.decks?.onPanelUpdate(({ panelId, patch }) => {
      patchPanel(panelId, patch)
    })
    return () => off?.()
  }, [patchPanel])

  // ── 4. Debounced persistence on any meaningful change. ──
  useEffect(() => {
    if (!hydrated.current) return
    const t = setTimeout(() => {
      const snapshot: PersistedState = {
        version: STATE_VERSION,
        theme,
        workspaces,
        activeWorkspaceId
      }
      window.decks?.state.save(snapshot).catch(() => {})
    }, 500)
    return () => clearTimeout(t)
  }, [workspaces, theme, activeWorkspaceId])

  // ── Global ⌘K / Esc. ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        togglePalette()
      } else if (e.key === 'Escape') {
        closePalette()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePalette, closePalette])

  return (
    <div className="flex h-full w-full flex-col bg-bg text-txt-1">
      <Titlebar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="relative min-w-0 flex-1">
          {view === 'home' || workspaces.length === 0 ? <Home /> : <SplitView />}
        </main>
      </div>
      <CommandPalette />
    </div>
  )
}

export default App
