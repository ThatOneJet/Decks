/**
 * Decks — shared domain types.
 *
 * This file is the single source of truth for the data model. Both the main
 * process and the renderer import from here (alias: `@shared/types`).
 * Do not redefine these shapes anywhere else.
 */

export type WorkspaceId = string
export type PanelId = string

/**
 * Service providers that back a NATIVE deck (our own React UI over a service's
 * API, data fetched in main and sanitized over IPC). WEB decks (embedded
 * WebContentsViews) have no provider. Add new providers here as they ship.
 *
 * NOTE: Reddit and YouTube intentionally stay EMBEDDED web decks (not native),
 * so they are NOT providers. (A YouTube channel can later feed the follows wall
 * via per-channel RSS — that is the 'rss' provider, not a 'youtube' provider.)
 */
export type ProviderId =
  | 'canvas'
  | 'github'
  | 'bluesky'
  | 'mastodon'
  | 'spotify'
  | 'rss'
  | 'follows-wall'

/**
 * Connection status of a provider, reported by its ProviderClient (main) back
 * to the renderer. `connected` reflects whether a usable token/session exists.
 */
export interface ProviderStatus {
  provider: ProviderId
  connected: boolean
  /** Human-readable account label (e.g. "@octocat") when connected. */
  account?: string
  /** Set when connect/status failed; a short, user-safe message (never a token). */
  error?: string
}

/** A single deck inside a workspace — either an embedded web view or a native one. */
export interface Panel {
  id: PanelId
  title: string
  url: string
  /**
   * Deck kind. Absent/undefined means 'web' (back-compat with existing persisted
   * state and all WEB decks). 'native' decks render OUR React UI over a provider
   * API instead of an embedded WebContentsView.
   */
  kind?: 'web' | 'native'
  /** The backing service provider. Only set when `kind === 'native'`. */
  provider?: ProviderId
  /** Last known favicon URL (updated by main via panel:navigated events). */
  favicon?: string
  /** Navigation capabilities, kept fresh from the live WebContents. */
  canGoBack?: boolean
  canGoForward?: boolean
  /** True while the panel is loading. */
  loading?: boolean
  /** REAL unread count parsed from the page title (e.g. "(3) Reddit" → 3). 0/undefined = none. */
  badge?: number
  /** REAL media state — true while a media element is actively playing in the deck. */
  playing?: boolean
  /**
   * True when the panel's renderer process has been discarded to free RAM. Its
   * WebContentsView no longer exists; the saved `url` is reloaded automatically
   * the next time the panel is shown. Persists across restarts via the store.
   */
  discarded?: boolean
}

/**
 * Split-view layout. A workspace's panels are arranged as a binary-ish tree:
 * either a single leaf panel, or a row/column split of child nodes.
 * `sizes` are fractional weights (sum ~1) parallel to `children`.
 */
export type LayoutNode =
  | { type: 'leaf'; panelId: PanelId }
  | { type: 'split'; direction: 'row' | 'column'; sizes: number[]; children: LayoutNode[] }

/** Live state shown on the workspace rail (the colored dot + subtitle). */
export type WorkspaceStatus = 'active' | 'idle' | 'paused' | 'unread'

export interface WorkspaceLiveState {
  status: WorkspaceStatus
  /** For status='unread'. */
  unread?: number
  /** For status='paused' — epoch ms when it was paused (rail shows "paused HH:MM"). */
  pausedAt?: number
}

export interface Workspace {
  id: WorkspaceId
  name: string
  /** Short descriptor under the name, e.g. "2 panels · term", "chat · code". */
  subtitle?: string
  /** Accent color for the active state / icon chip. */
  color?: string
  /** Optional emoji or short glyph shown in the rail chip. */
  glyph?: string
  panels: Panel[]
  layout: LayoutNode
  live: WorkspaceLiveState
  /** Free-text notes the user leaves on a workspace (shown in its right-click menu). */
  notes?: string
  /** Optional group/section label for organizing the rail (e.g. "Work", "Fun"). */
  group?: string
  /**
   * Electron session partition. Always `persist:<id>` so cookies / logins
   * survive restarts. Set once at creation; never change it.
   */
  partition: string
}

export type Theme = 'dark' | 'light'

/** A target reachable from the Cmd+K palette. */
export interface CommandItem {
  id: string
  kind: 'workspace' | 'pinned-site' | 'command'
  label: string
  hint?: string
  /** For pinned-site: the URL to open. For workspace: the workspace id. */
  value?: string
  glyph?: string
}

/** Pixel rectangle used to position a WebContentsView over the panel slot. */
export interface PanelBounds {
  x: number
  y: number
  width: number
  height: number
}

/** Full app snapshot persisted to disk and hydrated on launch. */
export interface PersistedState {
  version: number
  theme: Theme
  workspaces: Workspace[]
  activeWorkspaceId: WorkspaceId | null
  /** App-level settings (idle-discard timeout, accent color). Optional for back-compat. */
  settings?: {
    discardMinutes: number
    accent: string
  }
}
