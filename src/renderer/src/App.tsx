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
import { useEffect, useRef, useState } from 'react'
import { useStore } from './store'
import Titlebar from './components/Titlebar'
import Sidebar from './components/Sidebar'
import Home from './components/Home'
import SplitView from './components/SplitView'
import SettingsDeck from './components/Settings/SettingsDeck'
import CommandPalette from './components/CommandPalette'
import { seedWorkspaces } from '@shared/seed'
import type { PersistedState } from '@shared/types'

const STATE_VERSION = 1

function App(): JSX.Element {
  const view = useStore((s) => s.view)
  const workspaces = useStore((s) => s.workspaces)
  const theme = useStore((s) => s.theme)
  const settings = useStore((s) => s.settings)
  const setSettings = useStore((s) => s.setSettings)
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const setWorkspaces = useStore((s) => s.setWorkspaces)
  const activateWorkspace = useStore((s) => s.activateWorkspace)
  const patchPanel = useStore((s) => s.patchPanel)
  const togglePalette = useStore((s) => s.togglePalette)
  const closePalette = useStore((s) => s.closePalette)
  const paletteOpen = useStore((s) => s.paletteOpen)
  const openAddDeck = useStore((s) => s.openAddDeck)
  const closeAddDeck = useStore((s) => s.closeAddDeck)
  const focusMode = useStore((s) => s.focusMode)
  const toggleFocusMode = useStore((s) => s.toggleFocusMode)

  const hydrated = useRef(false)
  const createdPanels = useRef<Set<string>>(new Set())

  // ── Responsive shape: portrait windows turn the rail into a bottom dock. ──
  const [portrait, setPortrait] = useState(
    () => typeof window !== 'undefined' && window.innerHeight > window.innerWidth
  )
  useEffect(() => {
    const onResize = (): void => setPortrait(window.innerHeight > window.innerWidth)
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // When the rail moves (vertical rail ⇄ bottom dock), the page area changes
  // size, so re-measure the deck views on the next frame.
  useEffect(() => {
    const id = setTimeout(() => window.dispatchEvent(new Event('resize')), 0)
    return () => clearTimeout(id)
  }, [portrait])

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
      // Hydrate app settings, apply the accent live, and push the discard
      // timeout to main (which owns the idle-discard manager).
      if (persisted?.settings) setSettings(persisted.settings)
      const applied = useStore.getState().settings
      document.documentElement.style.setProperty('--accent', applied.accent)
      window.decks?.settings.apply({ discardMinutes: applied.discardMinutes })
      hydrated.current = true
      // Restore the previously active workspace (recreates its views via effect 2).
      if (persisted?.activeWorkspaceId && ws.some((w) => w.id === persisted.activeWorkspaceId)) {
        activateWorkspace(persisted.activeWorkspaceId)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [setWorkspaces, activateWorkspace, setSettings])

  // ── 2. Ensure every panel of the active workspace exists as a native view. ──
  // SplitView reports slot rects via showOnly; the view must exist first.
  // LAZY: views are created only when a workspace is active — nothing at boot,
  // and never for inactive workspaces. Discarded panels are intentionally NOT
  // recreated here; main recreates them automatically when SplitView's showOnly
  // references them, so they stay freed until actually shown.
  useEffect(() => {
    if (view !== 'workspace' || !activeWorkspaceId) return
    const ws = workspaces.find((w) => w.id === activeWorkspaceId)
    if (!ws) return
    for (const panel of ws.panels) {
      // Native decks have NO WebContentsView in main — they render entirely in the
      // renderer (NativeDeckHost). Never call panel.create for them.
      if (panel.kind === 'native') continue
      if (panel.discarded) continue
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

  // ── 3b. Discard/recreate state from the main-process discard manager. ──
  // On discard: mark the panel discarded with its saved URL (persists across
  // restart). On recreate (return): clear the flag. `createdPanels` is updated
  // so effect 2's idempotence stays in sync with main's actual view set.
  useEffect(() => {
    const off = window.decks?.onPanelDiscardState(({ panelId, discarded, url }) => {
      if (discarded) {
        createdPanels.current.delete(panelId)
        patchPanel(panelId, url ? { discarded: true, url } : { discarded: true })
      } else {
        createdPanels.current.add(panelId)
        patchPanel(panelId, { discarded: false })
      }
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
        activeWorkspaceId,
        settings
      }
      window.decks?.state.save(snapshot).catch(() => {})
    }, 500)
    return () => clearTimeout(t)
  }, [workspaces, theme, activeWorkspaceId, settings])

  // ── Keep the main-process idle-discard timeout in sync with settings. ──
  useEffect(() => {
    if (!hydrated.current) return
    window.decks?.settings.apply({ discardMinutes: settings.discardMinutes })
  }, [settings.discardMinutes])

  // ── Global shortcuts: ⌘/Ctrl+K (search), ⌘/Ctrl+N (add deck), Esc (close). ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        togglePalette()
      } else if (mod && (e.key.toLowerCase() === 'n' || e.key === '+' || e.key === '=')) {
        e.preventDefault()
        openAddDeck()
      } else if (mod && e.key === '.') {
        e.preventDefault()
        toggleFocusMode()
      } else if (e.key === 'Escape') {
        closePalette()
        closeAddDeck()
        if (useStore.getState().focusMode) toggleFocusMode()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePalette, closePalette, openAddDeck, closeAddDeck, toggleFocusMode])

  // Hide native web views while the palette is open so it isn't covered by them.
  useEffect(() => {
    if (!paletteOpen) return
    window.decks?.panel.hideAll()
    return () => {
      window.dispatchEvent(new Event('resize'))
    }
  }, [paletteOpen])

  // Re-measure deck views when focus mode collapses/expands the sidebar.
  useEffect(() => {
    const id = setTimeout(() => window.dispatchEvent(new Event('resize')), 0)
    return () => clearTimeout(id)
  }, [focusMode])

  const showSplit = view === 'workspace' && workspaces.length > 0
  const inFocus = focusMode && showSplit

  // Portrait: dock at the BOTTOM → stack [main | dock] vertically.
  // Landscape: rail on the LEFT → [rail | main] horizontally.
  const dockMode = portrait && !inFocus

  return (
    <div className="flex h-full w-full flex-col bg-bg text-txt-1">
      <Titlebar />
      <div className={`flex min-h-0 flex-1 ${dockMode ? 'flex-col' : 'flex-row'}`}>
        {!inFocus && !dockMode && <Sidebar />}
        <main className="relative min-w-0 min-h-0 flex-1">
          {view === 'settings' ? (
            <SettingsDeck />
          ) : view === 'home' || workspaces.length === 0 ? (
            <Home />
          ) : (
            <SplitView />
          )}

          {/* Focus mode: small far-left, vertically-centered handle to expand back. */}
          {inFocus && (
            <button
              onClick={toggleFocusMode}
              title="Exit focus (Ctrl/⌘+.)"
              className="no-drag absolute left-0 top-1/2 z-50 grid h-12 w-6 -translate-y-1/2 place-items-center rounded-r-xl border border-l-0 border-line bg-bg-elevated/90 text-txt-2 shadow-lg backdrop-blur transition-colors hover:bg-accent-soft hover:text-accent"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 18l6-6-6-6" />
              </svg>
            </button>
          )}
        </main>
        {/* Portrait: the rail becomes a horizontal taskbar dock at the bottom. */}
        {dockMode && <Sidebar orientation="horizontal" />}
      </div>
      <CommandPalette />
    </div>
  )
}

export default App
