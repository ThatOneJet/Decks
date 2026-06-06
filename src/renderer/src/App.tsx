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
import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from './store'
import Titlebar from './components/Titlebar'
import Sidebar from './components/Sidebar'
import DashboardHome from './components/DashboardHome'
import SplitView from './components/SplitView'
import SettingsDeck from './components/Settings/SettingsDeck'
import CommandPalette from './components/CommandPalette'
import Tour from './components/Tour'
import { Welcome, HelpPanel, MemoryPanel, welcomeUnseen } from './components/ConsolePanels'
import { tourUnseen } from './store'
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
  const goHome = useStore((s) => s.goHome)
  const openPalette = useStore((s) => s.openPalette)
  const consolePanel = useStore((s) => s.consolePanel)
  const openHelp = useStore((s) => s.openHelp)
  const openMemory = useStore((s) => s.openMemory)
  const closeConsolePanel = useStore((s) => s.closeConsolePanel)
  const openTour = useStore((s) => s.openTour)
  const [welcomeOpen, setWelcomeOpen] = useState(() => welcomeUnseen())

  // ── Console dock: collapse to a slim rail (⌘/Ctrl+B), and AUTO-collapse on
  // narrow screens so small laptops feel as roomy as a big monitor. ──
  const [dockCollapsed, setDockCollapsed] = useState(false)
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < 1080
  )
  useEffect(() => {
    const onResize = (): void => setNarrow(window.innerWidth < 1080)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const collapsed = dockCollapsed || narrow

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

  // ── First-run: auto-start the guided tour once (persisted "seen" flag). ──
  // Slightly delayed so the shell has painted and targets can be measured.
  useEffect(() => {
    if (!tourUnseen()) return
    const id = setTimeout(() => useStore.getState().openTour(), 700)
    return () => clearTimeout(id)
  }, [])

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

  // ── 2b. Keep-alive: push pin state to main for every web panel, and eagerly
  // create pinned decks so they render + stay loaded even when not active. ──
  const keepAliveKey = useMemo(
    () =>
      workspaces
        .map((w) => `${w.id}:${w.keepAlive ? 1 : 0}:${w.panels.map((p) => p.id).join(',')}`)
        .join('|'),
    [workspaces]
  )
  useEffect(() => {
    if (!hydrated.current) return
    for (const ws of useStore.getState().workspaces) {
      const pinned = !!ws.keepAlive
      for (const p of ws.panels) {
        if (p.kind === 'native') continue
        window.decks?.panel.setKeepAlive(p.id, pinned)
        if (pinned && !p.discarded && !createdPanels.current.has(p.id)) {
          createdPanels.current.add(p.id)
          window.decks?.panel
            .create({
              panelId: p.id,
              workspaceId: ws.id,
              partition: ws.partition,
              url: p.url,
              bounds: { x: 0, y: 0, width: 800, height: 600 }
            })
            .catch(() => createdPanels.current.delete(p.id))
        }
      }
    }
  }, [keepAliveKey])

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

  // ── 3c. Mini-player "close" → expand that deck back to full size. ──
  // Main sends only the panelId (it doesn't track workspaces); the renderer owns
  // the store, so we look up which workspace contains the panel and activate it.
  // The next showOnly puts the panel in the show-set, clearing mini-player mode.
  useEffect(() => {
    const off = window.decks?.onFocusPanel(({ panelId }) => {
      const ws = useStore
        .getState()
        .workspaces.find((w) => w.panels.some((p) => p.id === panelId))
      if (ws) activateWorkspace(ws.id)
    })
    return () => off?.()
  }, [activateWorkspace])

  // ── 3d. Background unread counts: show a native deck's notification badge in
  // the dock BEFORE it's opened. (Web decks can't report a count without loading
  // their page, so this covers the native providers that have an inbox.) ──
  useEffect(() => {
    const UNREAD: Record<string, string> = {
      github: 'notifications',
      canvas: 'todo',
      mastodon: 'notifications',
      bluesky: 'notifications'
    }
    let alive = true
    const poll = async (): Promise<void> => {
      for (const w of useStore.getState().workspaces) {
        for (const p of w.panels) {
          if (p.kind !== 'native' || !p.provider) continue
          const resource = UNREAD[p.provider]
          if (!resource) continue
          try {
            const r = await window.decks?.provider.fetch({
              provider: p.provider,
              accountId: p.accountId ?? 'default',
              resource
            })
            const count = Array.isArray(r) ? r.length : 0
            if (alive) patchPanel(p.id, { badge: count })
          } catch {
            /* not connected / failed — leave the badge as-is */
          }
        }
      }
    }
    const first = setTimeout(poll, 4000)
    const id = setInterval(poll, 180_000) // every 3 min
    return () => {
      alive = false
      clearTimeout(first)
      clearInterval(id)
    }
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
      } else if (mod && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        setDockCollapsed((v) => !v)
      } else if (mod && e.key === '.') {
        e.preventDefault()
        toggleFocusMode()
      } else if (!mod && e.key === '?') {
        const tag = (document.activeElement as HTMLElement | null)?.tagName
        if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
          e.preventDefault()
          openHelp()
        }
      } else if (e.key === 'Escape') {
        closePalette()
        closeAddDeck()
        if (useStore.getState().consolePanel !== 'none') closeConsolePanel()
        if (useStore.getState().focusMode) toggleFocusMode()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePalette, closePalette, openAddDeck, closeAddDeck, toggleFocusMode, openHelp, closeConsolePanel])

  // Hide native web views while the palette is open so it isn't covered by them.
  useEffect(() => {
    if (!paletteOpen) return
    window.decks?.panel.hideAll()
    return () => {
      window.dispatchEvent(new Event('resize'))
    }
  }, [paletteOpen])

  // Re-measure deck views when focus mode or the dock rail collapses/expands the
  // workspace. The grid column width animates over ~0.32s, so the slot rects keep
  // shifting; fire several re-measures ACROSS and just AFTER the transition so the
  // native WebContentsViews never get left at a stale position ("monstrosity").
  useEffect(() => {
    const ids = [0, 120, 240, 360, 420].map((d) =>
      setTimeout(() => window.dispatchEvent(new Event('resize')), d)
    )
    return () => ids.forEach(clearTimeout)
  }, [focusMode, collapsed])

  const showSplit = view === 'workspace' && workspaces.length > 0
  const inFocus = focusMode && showSplit

  // Portrait: dock at the BOTTOM → stack [main | dock] vertically.
  // Landscape: rail on the LEFT → [rail | main] horizontally.
  const dockMode = portrait && !inFocus

  // The active surface — each renders its own floating page card (.page-area).
  const surface =
    view === 'settings' ? (
      <SettingsDeck />
    ) : view === 'home' || workspaces.length === 0 ? (
      <DashboardHome />
    ) : (
      <SplitView />
    )

  // Focus mode: small far-left, vertically-centered handle to expand back.
  const focusHandle = inFocus ? (
    <button
      onClick={toggleFocusMode}
      title="Exit focus (Ctrl/⌘+.)"
      className="no-drag absolute left-0 top-1/2 z-50 grid h-12 w-6 -translate-y-1/2 place-items-center rounded-r-xl border border-l-0 border-line bg-bg-elevated/90 text-txt-2 shadow-lg backdrop-blur transition-colors hover:bg-accent-soft hover:text-accent"
    >
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 18l6-6-6-6" />
      </svg>
    </button>
  ) : null

  return (
    // STABLE tree: Titlebar + Sidebar + workspace are ALWAYS rendered in the same
    // positions; focus mode / portrait only toggle CSS classes (no remount), so a
    // native deck keeps its state when you focus/fullscreen it. Layout is driven
    // by `.console` + `.is-focus` / `.is-portrait` / `.rail` in the CSS grid.
    <div
      className={
        'console' +
        (collapsed ? ' rail' : '') +
        (inFocus ? ' is-focus' : '') +
        (dockMode ? ' is-portrait' : '')
      }
    >
      {/* HEADER — full-width Console chrome (brand + command bar + controls). */}
      <Titlebar />

      {/* DOCK — vertical rail (landscape) or bottom taskbar (portrait). */}
      <Sidebar
        collapsed={collapsed}
        onToggleCollapse={() => setDockCollapsed((v) => !v)}
        orientation={dockMode ? 'horizontal' : 'vertical'}
      />

      {/* WORKSPACE — the active surface (its own floating page card). */}
      <div className="workspace relative">
        {surface}
        {focusHandle}
      </div>

      <CommandPalette />

      {/* Console redesign — slide-over panels + first-run tutorial */}
      {consolePanel === 'help' && (
        <HelpPanel
          onClose={closeConsolePanel}
          onAction={(id) => {
            closeConsolePanel()
            if (id === 'palette') openPalette()
            else if (id === 'home') goHome()
            else if (id === 'focus') toggleFocusMode()
            else if (id === 'add') openAddDeck()
            else if (id === 'memory') openMemory()
          }}
        />
      )}
      {/* Replay the guided tour from the Help slide-over (docked to its footer). */}
      {consolePanel === 'help' && (
        <button
          className="help-tour-btn btn-ghost"
          onClick={() => {
            closeConsolePanel()
            openTour()
          }}
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
          Replay the guided tour
        </button>
      )}
      {consolePanel === 'memory' && <MemoryPanel onClose={closeConsolePanel} />}
      {welcomeOpen && !paletteOpen && (
        <Welcome onClose={() => setWelcomeOpen(false)} onHelp={() => { setWelcomeOpen(false); openHelp() }} />
      )}

      {/* First-run guided spotlight tour (replayable from Help / Settings). */}
      <Tour />
    </div>
  )
}

export default App
