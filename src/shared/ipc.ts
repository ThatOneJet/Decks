/**
 * Decks — IPC contract.
 *
 * The exact, typed boundary between the main process and the renderer.
 * - `IPC` holds every channel name (no string literals anywhere else).
 * - The payload/result interfaces type each call.
 * - `DecksApi` is the shape the preload exposes as `window.decks`, and the
 *   only thing the renderer is allowed to touch in the main process.
 *
 * Renderer → main calls are request/response (ipcRenderer.invoke).
 * Main → renderer messages are events the renderer subscribes to.
 */
import type { PanelBounds, PersistedState, PanelId, WorkspaceId } from './types'

export const IPC = {
  // ── Panel (WebContentsView) lifecycle — renderer → main (invoke) ──
  PanelCreate: 'panel:create',
  PanelDestroy: 'panel:destroy',
  PanelNavigate: 'panel:navigate',
  PanelReload: 'panel:reload',
  PanelGoBack: 'panel:go-back',
  PanelGoForward: 'panel:go-forward',
  PanelSetBounds: 'panel:set-bounds',
  /** Attach the given panels to the window and detach all others. */
  PanelShowOnly: 'panel:show-only',
  /** Detach every panel view (so pure-renderer UI like Home/Cmd+K is visible). */
  PanelHideAll: 'panel:hide-all',

  // ── Persistence — renderer → main (invoke) ──
  StateLoad: 'state:load',
  StateSave: 'state:save',

  // ── Process metrics — renderer → main (invoke) ──
  /** Total RAM + live/discarded panel counts for the sidebar readout. */
  MetricsGet: 'metrics:get',

  // ── Window controls — renderer → main (send) ──
  WindowMinimize: 'window:minimize',
  WindowMaximize: 'window:maximize',
  WindowClose: 'window:close',

  // ── Native workspace context menu — renderer → main (send) ──
  WorkspaceContextMenu: 'workspace:context-menu',

  // ── Events — main → renderer (on) ──
  /** A panel's live WebContents changed (title/url/favicon/loading/nav state). */
  PanelUpdate: 'panel:update',
  /** A native workspace menu item was chosen. */
  WorkspaceMenuAction: 'workspace:menu-action',
  /**
   * The discard manager freed a panel's renderer (event carries the saved URL),
   * or recreated it on return (discarded:false). Renderer applies via patchPanel.
   */
  PanelDiscardState: 'panel:discard-state'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

/** payload: PanelCreate */
export interface PanelCreatePayload {
  panelId: PanelId
  workspaceId: WorkspaceId
  /** Always `persist:<workspaceId>` — keeps logins across restarts. */
  partition: string
  url: string
  /** Initial placement; may be updated later via PanelSetBounds. */
  bounds: PanelBounds
}

/** payload: PanelNavigate */
export interface PanelNavigatePayload {
  panelId: PanelId
  url: string
}

/** payload: PanelSetBounds */
export interface PanelSetBoundsPayload {
  panelId: PanelId
  bounds: PanelBounds
}

/** payload: PanelShowOnly — show these (in z-order), detach everything else. */
export interface PanelShowOnlyPayload {
  panelIds: PanelId[]
  /** Bounds keyed by panelId for the panels being shown. */
  bounds: Record<PanelId, PanelBounds>
}

/** payload: WorkspaceContextMenu (renderer → main) */
export interface WorkspaceContextMenuPayload {
  workspaceId: WorkspaceId
  hasNotes: boolean
}

/** event: WorkspaceMenuAction (main → renderer) */
export interface WorkspaceMenuActionEvent {
  workspaceId: WorkspaceId
  action: 'rename' | 'reset' | 'note' | 'delete'
}

/** event: PanelUpdate (main → renderer) */
export interface PanelUpdateEvent {
  panelId: PanelId
  patch: {
    title?: string
    url?: string
    favicon?: string
    loading?: boolean
    canGoBack?: boolean
    canGoForward?: boolean
    badge?: number
    playing?: boolean
  }
}

/** event: PanelDiscardState (main → renderer) */
export interface PanelDiscardStateEvent {
  panelId: PanelId
  /** True = renderer was discarded (free RAM); false = view recreated on return. */
  discarded: boolean
  /** The saved URL to reload on return. Only meaningful when discarded === true. */
  url?: string
}

/** result: MetricsGet (main → renderer) */
export interface MetricsResult {
  /** Summed workingSetSize across all app processes, in MB. */
  ramMB: number
  /** Number of live WebContentsViews (renderer processes for panels). */
  liveRenderers: number
  /** Number of panels currently discarded (renderer freed, URL remembered). */
  discarded: number
}

/**
 * The full API surface exposed on `window.decks` by the preload.
 * Renderer code depends ONLY on this interface.
 */
export interface DecksApi {
  panel: {
    create(payload: PanelCreatePayload): Promise<void>
    destroy(panelId: PanelId): Promise<void>
    navigate(payload: PanelNavigatePayload): Promise<void>
    reload(panelId: PanelId): Promise<void>
    goBack(panelId: PanelId): Promise<void>
    goForward(panelId: PanelId): Promise<void>
    setBounds(payload: PanelSetBoundsPayload): Promise<void>
    showOnly(payload: PanelShowOnlyPayload): Promise<void>
    hideAll(): Promise<void>
  }
  state: {
    load(): Promise<PersistedState | null>
    save(state: PersistedState): Promise<void>
  }
  metrics: {
    /** Total RAM + live/discarded panel counts for the sidebar readout. */
    get(): Promise<MetricsResult>
  }
  window: {
    minimize(): void
    maximize(): void
    close(): void
  }
  workspace: {
    /** Pop a NATIVE context menu at the cursor (renders above web views). */
    contextMenu(payload: WorkspaceContextMenuPayload): void
  }
  /** Subscribe to live panel updates. Returns an unsubscribe fn. */
  onPanelUpdate(cb: (e: PanelUpdateEvent) => void): () => void
  /** Subscribe to native workspace-menu choices. Returns an unsubscribe fn. */
  onWorkspaceMenuAction(cb: (e: WorkspaceMenuActionEvent) => void): () => void
  /** Subscribe to discard/recreate state changes. Returns an unsubscribe fn. */
  onPanelDiscardState(cb: (e: PanelDiscardStateEvent) => void): () => void
}
