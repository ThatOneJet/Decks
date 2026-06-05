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
export type View = 'home' | 'workspace'

export interface DecksState {
  // ── data ──
  workspaces: Workspace[]
  activeWorkspaceId: WorkspaceId | null
  view: View
  theme: Theme

  // ── command palette ──
  paletteOpen: boolean

  // ── derived helpers ──
  activeWorkspace: () => Workspace | undefined
  panelById: (id: PanelId) => Panel | undefined

  // ── actions: workspaces ──
  setWorkspaces: (ws: Workspace[]) => void
  addWorkspace: (ws: Workspace) => void
  removeWorkspace: (id: WorkspaceId) => void
  activateWorkspace: (id: WorkspaceId) => void
  goHome: () => void
  updateWorkspaceLive: (id: WorkspaceId, live: Partial<Workspace['live']>) => void

  // ── actions: panels ──
  addPanel: (workspaceId: WorkspaceId, panel: Panel) => void
  removePanel: (workspaceId: WorkspaceId, panelId: PanelId) => void
  patchPanel: (panelId: PanelId, patch: Partial<Panel>) => void
  setLayout: (workspaceId: WorkspaceId, layout: LayoutNode) => void

  // ── actions: ui ──
  setTheme: (t: Theme) => void
  openPalette: () => void
  closePalette: () => void
  togglePalette: () => void
}

export const useStore = create<DecksState>((set, get) => ({
  workspaces: [],
  activeWorkspaceId: null,
  view: 'home',
  theme: 'dark',
  paletteOpen: false,

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
  updateWorkspaceLive: (id, live) =>
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === id ? { ...w, live: { ...w.live, ...live } } : w
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
  openPalette: () => set({ paletteOpen: true }),
  closePalette: () => set({ paletteOpen: false }),
  togglePalette: () => set((s) => ({ paletteOpen: !s.paletteOpen }))
}))
