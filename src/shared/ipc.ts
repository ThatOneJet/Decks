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
import type {
  PanelBounds,
  PersistedState,
  PanelId,
  WorkspaceId,
  ProviderId,
  ProviderStatus,
  AccountSummary
} from './types'

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
  /** Pin/unpin a panel as keep-alive (never auto-discarded). */
  PanelSetKeepAlive: 'panel:set-keep-alive',

  // ── Native deck providers — renderer → main (invoke) ──
  /** Connect a provider (paste a token, or run the OAuth helper). */
  ProviderConnect: 'provider:connect',
  /** Fetch a sanitized resource from a connected provider. */
  ProviderFetch: 'provider:fetch',
  /** Disconnect a provider (forget its stored token). */
  ProviderDisconnect: 'provider:disconnect',
  /** Query one account's connection status. */
  ProviderStatus: 'provider:status',
  /** List a provider's connected accounts. */
  ProviderAccounts: 'provider:accounts',

  // ── code-server (local VS Code in a deck) — renderer → main (invoke) ──
  /** Pick a folder + spawn code-server; resolves its loopback URL. */
  CodeServerStart: 'codeserver:start',
  /** Stop the running code-server (also torn down on quit). */
  CodeServerStop: 'codeserver:stop',

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

  // ── Floating hover card overlay — renderer → main (send) ──
  /** Show the always-on-top hover card for a rail tile at a position. */
  HoverShow: 'hover:show',
  /** Hide the hover card. */
  HoverHide: 'hover:hide',

  // ── Settings applied to the main process — renderer → main (send) ──
  /** Apply settings that affect main (e.g. discard timeout). */
  SettingsApply: 'settings:apply',

  // ── Custom context menu (rendered in the overlay window, floats over pages) ──
  MenuShow: 'menu:show', // renderer → main
  MenuPick: 'menu:pick', // overlay → main (an item was chosen)
  MenuDismiss: 'menu:dismiss', // overlay → main (clicked outside)

  // ── YouTube corner mini-player (overlay control bar over a corner video) ──
  /** main → the OVERLAY window: show/update/hide the mini-player control bar. */
  OverlayMiniPlayer: 'overlay:miniplayer',
  /** overlay → main (send): a mini-player control button was pressed. */
  MiniPlayerControl: 'miniplayer:control',
  /** main → the MAIN renderer: focus/expand a panel's deck back to full size. */
  FocusPanel: 'panel:focus',

  // ── Events — main → renderer (on) ──
  /** main → the OVERLAY window only: render/hide the hover card. */
  OverlayRender: 'overlay:render',
  /** main → the OVERLAY window only: render/hide the custom context menu. */
  OverlayMenu: 'overlay:menu',
  /** main → the MAIN renderer: a folder menu item was chosen. */
  FolderMenuAction: 'folder:menu-action',
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

/** payload: ProviderConnect — connect a native deck's backing provider. */
export interface ProviderConnectPayload {
  provider: ProviderId
  /** Which account to connect (a provider may hold several). */
  accountId: string
  /** 'token' = the user pastes a personal access token; 'oauth' = run the helper. */
  mode: 'token' | 'oauth'
  /** The pasted token. Only used (and required) when mode === 'token'. */
  token?: string
  /**
   * Extra non-secret connection fields a provider needs alongside (or instead
   * of) a token — e.g. Canvas/Mastodon `instanceUrl`, Bluesky `handle` +
   * `appPassword`, an OAuth `clientId`. The client persists whatever it needs
   * via the secure token store (as a JSON blob); nothing here is logged.
   */
  fields?: Record<string, string>
}

/** payload: ProviderFetch — request a sanitized resource from a provider. */
export interface ProviderFetchPayload {
  provider: ProviderId
  /** Which connected account to read. */
  accountId: string
  /** Provider-defined resource name (e.g. 'courses', 'feed', 'repos'). */
  resource: string
  /** Optional provider-defined query params. */
  params?: Record<string, unknown>
}

/** payload: ProviderDisconnect / ProviderStatus — scope to one account. */
export interface ProviderAccountPayload {
  provider: ProviderId
  accountId: string
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

/** event: WorkspaceMenuAction (main → renderer) */
export interface WorkspaceMenuActionEvent {
  workspaceId: WorkspaceId
  action: 'rename' | 'reset' | 'note' | 'keepalive' | 'delete'
}

/** What kind of target a custom context menu is acting on. */
export type MenuKind = 'workspace' | 'folder'

/** payload: MenuShow (renderer → main). x/y are main-window-relative px. */
export interface MenuShowPayload {
  kind: MenuKind
  /** workspace id (kind='workspace') or group name (kind='folder'). */
  targetId: string
  x: number
  y: number
  hasNotes?: boolean
  /** Current keep-alive state, so the menu renders the toggle on/off. */
  keepAlive?: boolean
}

/** event: OverlayMenu (main → the overlay window). */
export interface OverlayMenuEvent {
  kind: MenuKind
  targetId: string
  hasNotes: boolean
  /** Current keep-alive state for the toggle item. */
  keepAlive?: boolean
  /** When true, the menu should be cleared (overlay reverts to hover mode). */
  hide?: boolean
}

/** payload: MenuPick (overlay → main). An item was chosen. */
export interface MenuPickPayload {
  kind: MenuKind
  targetId: string
  action: string
}

/** Now-playing metadata for the corner mini-player control bar. */
export interface MiniPlayerMeta {
  title: string
  artist: string
  /** Artwork URL from the page's mediaSession metadata (may be absent). */
  artwork?: string
  /** True while playback is paused. */
  paused: boolean
  /** True while the corner video is set to loop. */
  loop?: boolean
}

/** event: OverlayMiniPlayer (main → the overlay window). */
export interface OverlayMiniPlayerEvent {
  show: boolean
  meta?: MiniPlayerMeta
}

/** payload: MiniPlayerControl (overlay → main). A control button / drag event. */
export interface MiniPlayerControlEvent {
  action: 'play' | 'pause' | 'next' | 'prev' | 'loop' | 'close' | 'move-start' | 'move' | 'move-end'
  /** Optional seek target (seconds), for action === 'play'/'pause' scrubbing. */
  time?: number
  /** For action === 'move': drag delta (screen px) since 'move-start'. */
  dx?: number
  dy?: number
}

/** event: FocusPanel (main → the MAIN renderer). Expand a panel's deck full-size. */
export interface FocusPanelEvent {
  panelId: PanelId
}

/** event: FolderMenuAction (main → the MAIN renderer). */
export interface FolderMenuActionEvent {
  name: string
  action: 'rename' | 'ungroup' | 'keepalive'
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

/** A workspace summary for the floating hover card. */
export interface HoverSummary {
  name: string
  iconUrl: string
  color: string
  deckCount: number
  unread: number
  playing: boolean
  notes?: string
}

/** payload: HoverShow (renderer → main). x/y are window-relative (px). */
export interface HoverShowPayload {
  summary: HoverSummary
  x: number
  y: number
}

/** event: OverlayRender (main → the overlay window). */
export interface OverlayRenderEvent {
  show: boolean
  summary?: HoverSummary
}

/** payload: SettingsApply (renderer → main). */
export interface SettingsApplyPayload {
  /** Discard idle panels after this many minutes (0/undefined = leave unchanged). */
  discardMinutes?: number
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

/** result: CodeServerStart — outcome of trying to launch local code-server. */
export interface CodeServerResult {
  /** The loopback URL to load as a web deck, when it started. */
  url?: string
  /** A human-readable error when it didn't (e.g. not installed, cancelled). */
  error?: string
  /** True when the failure was specifically "code-server isn't installed". */
  notInstalled?: boolean
  /** True when the user cancelled the folder picker. */
  cancelled?: boolean
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
    /** Pin/unpin a panel as keep-alive (never auto-discarded/evicted). */
    setKeepAlive(panelId: PanelId, keepAlive: boolean): Promise<void>
  }
  /**
   * Native deck providers. The renderer never holds tokens or talks to a service
   * directly — it asks main to connect/fetch and gets back sanitized JSON.
   */
  provider: {
    /** Connect (token paste or OAuth). Resolves with the resulting status. */
    connect(payload: ProviderConnectPayload): Promise<ProviderStatus>
    /** Fetch a sanitized resource from a connected provider. */
    fetch(payload: ProviderFetchPayload): Promise<unknown>
    /** Disconnect one connected account (forget its stored credential). */
    disconnect(provider: ProviderId, accountId: string): Promise<void>
    /** Query one account's connection status. */
    status(provider: ProviderId, accountId: string): Promise<ProviderStatus>
    /** List a provider's connected accounts. */
    accounts(provider: ProviderId): Promise<AccountSummary[]>
  }
  codeserver: {
    /** Pick a folder + spawn code-server; resolves a result with the URL. */
    start(): Promise<CodeServerResult>
    /** Stop the running code-server. */
    stop(): Promise<void>
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
  menu: {
    /** Ask main to float the custom context menu in the overlay at the cursor. */
    show(payload: MenuShowPayload): void
    /** Report (from the overlay) that a menu item was chosen. */
    pick(payload: MenuPickPayload): void
    /** Report (from the overlay) that the menu was dismissed (clicked outside). */
    dismiss(): void
  }
  hover: {
    /** Show the always-on-top floating hover card (over live web pages). */
    show(payload: HoverShowPayload): void
    /** Hide the floating hover card. */
    hide(): void
  }
  miniPlayer: {
    /** (Overlay window only) report a mini-player control button press. */
    control(e: MiniPlayerControlEvent): void
  }
  settings: {
    /** Apply settings that affect the main process (discard timeout, …). */
    apply(payload: SettingsApplyPayload): void
  }
  /** Subscribe to live panel updates. Returns an unsubscribe fn. */
  onPanelUpdate(cb: (e: PanelUpdateEvent) => void): () => void
  /** Subscribe to workspace-menu choices. Returns an unsubscribe fn. */
  onWorkspaceMenuAction(cb: (e: WorkspaceMenuActionEvent) => void): () => void
  /** Subscribe to folder-menu choices. Returns an unsubscribe fn. */
  onFolderMenuAction(cb: (e: FolderMenuActionEvent) => void): () => void
  /** Subscribe to discard/recreate state changes. Returns an unsubscribe fn. */
  onPanelDiscardState(cb: (e: PanelDiscardStateEvent) => void): () => void
  /** (Overlay window only) subscribe to hover-card render events. */
  onOverlayRender(cb: (e: OverlayRenderEvent) => void): () => void
  /** (Overlay window only) subscribe to custom context-menu render events. */
  onOverlayMenu(cb: (e: OverlayMenuEvent) => void): () => void
  /** (Overlay window only) subscribe to mini-player render events. */
  onMiniPlayer(cb: (e: OverlayMiniPlayerEvent) => void): () => void
  /** (Main renderer only) subscribe to focus-panel requests. */
  onFocusPanel(cb: (e: FocusPanelEvent) => void): () => void
}
