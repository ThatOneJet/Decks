/**
 * Decks — renderer state (zustand).
 *
 * Holds the workspace list, which workspace is active, the current "view"
 * (home vs a workspace's split panels), theme, and Cmd+K palette state.
 *
 * IMPORTANT: this store is UI state only. It never talks to the main process
 * directly — components call `window.decks` (the IPC contract) for side effects
 * (creating/positioning WebContentsViews, persistence) and then update this
 * store to reflect the result. Phase 2 wires the two together.
 */
import { create } from 'zustand'
import type {
  Workspace,
  WorkspaceId,
  PanelId,
  Panel,
  LayoutNode,
  Theme
} from '@shared/types'
import { addLeaf, removeLeaf } from './lib/layout'

const deckCount = (n: number): string => `${n} deck${n === 1 ? '' : 's'}`
const EMPTY_LAYOUT: LayoutNode = { type: 'leaf', panelId: '' }
const isEmptyLayout = (l: LayoutNode): boolean => l.type === 'leaf' && l.panelId === ''

/** Which surface the right-hand region is showing. */
export type View = 'home' | 'workspace' | 'settings'

/** App-level settings (persisted). Minimal and typed. */
export interface Settings {
  /** Discard idle panels after this many minutes (1–60). */
  discardMinutes: number
  /** Accent color hex, applied live via the --accent CSS variable. */
  accent: string
}

export const DEFAULT_SETTINGS: Settings = { discardMinutes: 8, accent: '#7c5cff' }

export interface DecksState {
  // ── data ──
  workspaces: Workspace[]
  activeWorkspaceId: WorkspaceId | null
  view: View
  theme: Theme
  settings: Settings

  // ── overlays ──
  paletteOpen: boolean
  addDeckOpen: boolean
  /** Focus mode — collapse the sidebar and focus the active deck. */
  focusMode: boolean
  /** True while a rail tile is being dragged (exposes the page as a drop target). */
  dragging: boolean

  // ── derived helpers ──
  activeWorkspace: () => Workspace | undefined
  panelById: (id: PanelId) => Panel | undefined

  // ── actions: workspaces ──
  setWorkspaces: (ws: Workspace[]) => void
  addWorkspace: (ws: Workspace) => void
  removeWorkspace: (id: WorkspaceId) => void
  activateWorkspace: (id: WorkspaceId) => void
  goHome: () => void
  /** Open the dedicated settings surface. */
  openSettings: () => void
  /** Which Console slide-over panel is open (memory / help / none). */
  consolePanel: 'none' | 'help' | 'memory'
  openHelp: () => void
  openMemory: () => void
  closeConsolePanel: () => void
  updateWorkspaceLive: (id: WorkspaceId, live: Partial<Workspace['live']>) => void
  renameWorkspace: (id: WorkspaceId, name: string) => void
  setNotes: (id: WorkspaceId, notes: string) => void
  setGroup: (id: WorkspaceId, group: string | undefined) => void
  /** Pin/unpin a workspace as keep-alive (its decks never auto-discard). */
  setKeepAlive: (id: WorkspaceId, on: boolean) => void
  /** Rename a folder: move every workspace from `oldName` to `newName`. */
  renameGroup: (oldName: string, newName: string) => void
  /** Next default folder name: "Group N" where N = distinct group count + 1. */
  nextGroupName: () => string
  /** Replace a workspace's decks+layout (e.g. from a reset template). */
  setDecks: (id: WorkspaceId, panels: Panel[], layout: LayoutNode) => void

  // ── actions: panels ──
  addPanel: (workspaceId: WorkspaceId, panel: Panel) => void
  removePanel: (workspaceId: WorkspaceId, panelId: PanelId) => void
  /** Move a panel out of a split into its own new workspace (rail tile). */
  popPanelOut: (workspaceId: WorkspaceId, panelId: PanelId) => void
  /** Per-panel reload counter — bump to remount a native deck (force refresh). */
  panelReloadNonce: Record<PanelId, number>
  bumpPanelReload: (panelId: PanelId) => void
  patchPanel: (panelId: PanelId, patch: Partial<Panel>) => void
  setLayout: (workspaceId: WorkspaceId, layout: LayoutNode) => void

  // ── actions: ui ──
  setTheme: (t: Theme) => void
  /** Merge a partial settings patch. */
  setSettings: (patch: Partial<Settings>) => void
  openPalette: () => void
  closePalette: () => void
  togglePalette: () => void
  openAddDeck: () => void
  closeAddDeck: () => void
  toggleFocusMode: () => void
  /** Set the rail-drag flag. */
  setDragging: (dragging: boolean) => void
}

export const useStore = create<DecksState>((set, get) => ({
  workspaces: [],
  activeWorkspaceId: null,
  view: 'home',
  theme: 'dark',
  settings: { ...DEFAULT_SETTINGS },
  paletteOpen: false,
  addDeckOpen: false,
  focusMode: false,
  dragging: false,
  panelReloadNonce: {},

  activeWorkspace: () => {
    const { workspaces, activeWorkspaceId } = get()
    return workspaces.find((w) => w.id === activeWorkspaceId)
  },
  panelById: (id) => {
    for (const w of get().workspaces) {
      const p = w.panels.find((p) => p.id === id)
      if (p) return p
    }
    return undefined
  },

  setWorkspaces: (workspaces) => set({ workspaces }),
  addWorkspace: (ws) => set((s) => ({ workspaces: [...s.workspaces, ws] })),
  removeWorkspace: (id) =>
    set((s) => {
      const workspaces = s.workspaces.filter((w) => w.id !== id)
      const stillActive = s.activeWorkspaceId === id ? null : s.activeWorkspaceId
      return {
        workspaces,
        activeWorkspaceId: stillActive,
        view: stillActive ? s.view : 'home'
      }
    }),
  activateWorkspace: (id) => set({ activeWorkspaceId: id, view: 'workspace' }),
  goHome: () => set({ view: 'home' }),
  openSettings: () => set({ view: 'settings' }),
  consolePanel: 'none',
  openHelp: () => set({ consolePanel: 'help' }),
  openMemory: () => set({ consolePanel: 'memory' }),
  closeConsolePanel: () => set({ consolePanel: 'none' }),
  updateWorkspaceLive: (id, live) =>
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === id ? { ...w, live: { ...w.live, ...live } } : w
      )
    })),
  renameWorkspace: (id, name) =>
    set((s) => ({
      workspaces: s.workspaces.map((w) => (w.id === id ? { ...w, name } : w))
    })),
  setNotes: (id, notes) =>
    set((s) => ({
      workspaces: s.workspaces.map((w) => (w.id === id ? { ...w, notes } : w))
    })),
  setGroup: (id, group) =>
    set((s) => ({
      workspaces: s.workspaces.map((w) => (w.id === id ? { ...w, group } : w))
    })),
  setKeepAlive: (id, on) =>
    set((s) => ({
      workspaces: s.workspaces.map((w) => (w.id === id ? { ...w, keepAlive: on } : w))
    })),
  renameGroup: (oldName, newName) =>
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.group === oldName ? { ...w, group: newName } : w
      )
    })),
  nextGroupName: () => {
    const groups = new Set<string>()
    for (const w of get().workspaces) if (w.group) groups.add(w.group)
    return `Group ${groups.size + 1}`
  },
  setDecks: (id, panels, layout) =>
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === id ? { ...w, panels, layout, subtitle: deckCount(panels.length) } : w
      )
    })),

  // Add a deck: append it and graft a leaf into the split layout.
  addPanel: (workspaceId, panel) =>
    set((s) => ({
      workspaces: s.workspaces.map((w) => {
        if (w.id !== workspaceId) return w
        const panels = [...w.panels, panel]
        const layout = isEmptyLayout(w.layout)
          ? { type: 'leaf' as const, panelId: panel.id }
          : addLeaf(w.layout, panel.id, 'row')
        return { ...w, panels, layout, subtitle: deckCount(panels.length) }
      })
    })),
  // Delete a deck: drop it and prune its leaf from the layout (collapsing splits).
  removePanel: (workspaceId, panelId) =>
    set((s) => ({
      workspaces: s.workspaces.map((w) => {
        if (w.id !== workspaceId) return w
        const panels = w.panels.filter((p) => p.id !== panelId)
        const layout = removeLeaf(w.layout, panelId) ?? EMPTY_LAYOUT
        return { ...w, panels, layout, subtitle: deckCount(panels.length) }
      })
    })),
  // Pull a panel out of a split into its OWN new workspace (rail tile), so a
  // split-screened deck can become a standalone deck. No-op if it's already the
  // workspace's only deck. The panel keeps its id (and thus its existing view),
  // so a web deck's session/login is preserved.
  popPanelOut: (workspaceId, panelId) =>
    set((s) => {
      const from = s.workspaces.find((w) => w.id === workspaceId)
      const panel = from?.panels.find((p) => p.id === panelId)
      if (!from || !panel || from.panels.length <= 1) return {}
      const remaining = from.panels.filter((p) => p.id !== panelId)
      const prunedLayout = removeLeaf(from.layout, panelId) ?? EMPTY_LAYOUT
      const id = `ws_${crypto.randomUUID().slice(0, 8)}`
      const newWs: Workspace = {
        id,
        name: panel.title || 'Deck',
        subtitle: '1 deck',
        color: from.color,
        glyph: from.glyph,
        // Native decks have no view/session; web decks keep the source partition
        // so the moved view's login carries over.
        partition: panel.kind === 'native' ? `persist:${id}` : from.partition,
        live: { status: 'idle' },
        panels: [panel],
        layout: { type: 'leaf', panelId }
      }
      return {
        workspaces: [
          ...s.workspaces.map((w) =>
            w.id === workspaceId
              ? { ...w, panels: remaining, layout: prunedLayout, subtitle: deckCount(remaining.length) }
              : w
          ),
          newWs
        ],
        activeWorkspaceId: id,
        view: 'workspace'
      }
    }),
  bumpPanelReload: (panelId) =>
    set((s) => ({
      panelReloadNonce: { ...s.panelReloadNonce, [panelId]: (s.panelReloadNonce[panelId] ?? 0) + 1 }
    })),
  patchPanel: (panelId, patch) =>
    set((s) => ({
      workspaces: s.workspaces.map((w) => ({
        ...w,
        panels: w.panels.map((p) => (p.id === panelId ? { ...p, ...patch } : p))
      }))
    })),
  setLayout: (workspaceId, layout) =>
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === workspaceId ? { ...w, layout } : w
      )
    })),

  setTheme: (theme) => set({ theme }),
  setSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),
  openPalette: () => set({ paletteOpen: true }),
  closePalette: () => set({ paletteOpen: false }),
  togglePalette: () => set((s) => ({ paletteOpen: !s.paletteOpen })),
  openAddDeck: () => set({ addDeckOpen: true }),
  closeAddDeck: () => set({ addDeckOpen: false }),
  toggleFocusMode: () => set((s) => ({ focusMode: !s.focusMode })),
  setDragging: (dragging) => set({ dragging })
}))
