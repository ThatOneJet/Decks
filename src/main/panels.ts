/**
 * Decks — panel manager (native WebContentsViews).
 *
 * Each "panel" is an Electron `WebContentsView` overlaid on top of the renderer
 * web page. The renderer draws empty slots and tells us their pixel rects; we
 * position the views over them. Hiding a panel means detaching its view from the
 * window's contentView (and zeroing its bounds), so the renderer UI underneath
 * (Home / Cmd+K) is fully visible.
 *
 * The per-workspace `partition` (always `persist:<workspaceId>`) gives each
 * workspace its own persistent Electron session, so logins survive restarts.
 */
import { WebContentsView, shell } from 'electron'
import type { BrowserWindow } from 'electron'
import { IPC } from '@shared/ipc'
import type {
  PanelCreatePayload,
  PanelNavigatePayload,
  PanelSetBoundsPayload,
  PanelShowOnlyPayload,
  PanelUpdateEvent,
  PanelDiscardStateEvent
} from '@shared/ipc'
import type { PanelBounds, PanelId } from '@shared/types'

/**
 * Discard policy. A panel whose renderer has been HIDDEN (detached from the
 * window) continuously for longer than DISCARD_AFTER_MS has its entire
 * WebContentsView destroyed, freeing the Chromium renderer process. The saved
 * URL is remembered and reloaded automatically the next time the panel is shown.
 * Tune higher to keep more panels warm (more RAM); lower to reclaim sooner.
 */
const DISCARD_AFTER_MS = 8 * 60 * 1000
/** How often the discard sweep runs. */
const SWEEP_INTERVAL_MS = 60 * 1000

interface PanelEntry {
  view: WebContentsView
  /** Whether the view is currently a child of the window's contentView. */
  attached: boolean
  /** Session partition — needed to recreate the view identically after discard. */
  partition: string
  /** Last time this view was active/visible/audible (epoch ms). */
  lastActiveAt: number
  /** Epoch ms the view became hidden (detached); null while visible. */
  hiddenSince: number | null
}

/** What we remember about a discarded panel so we can recreate it on return. */
interface DiscardedEntry {
  url: string
  partition: string
}

/**
 * Extract a real unread count from a page title. Sites encode it as a leading
 * "(N)" or "(N+)" — e.g. "(3) Reddit", "(12+) Gmail". Returns 0 when absent, so
 * a badge only ever shows when the site itself reports one.
 */
function parseBadge(title: string): number {
  const m = /^\s*\((\d+)\+?\)/.exec(title || '')
  return m ? Number(m[1]) : 0
}

export class PanelManager {
  private readonly panels = new Map<PanelId, PanelEntry>()
  /** Panels whose renderer was discarded; recreated automatically on return. */
  private readonly discarded = new Map<PanelId, DiscardedEntry>()
  private window: BrowserWindow | null = null
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  /** Idle-discard threshold (ms); configurable from Settings. */
  private discardAfterMs = DISCARD_AFTER_MS

  /** Bind the window the panels are overlaid onto. Call once after creation. */
  setWindow(win: BrowserWindow): void {
    this.window = win
    this.startSweep()
  }

  /** Change the idle-discard threshold (minutes → ms applied by the caller). */
  setDiscardAfterMs(ms: number): void {
    if (ms > 0) this.discardAfterMs = ms
  }

  /** Number of live WebContentsViews (one renderer process each). */
  get liveCount(): number {
    return this.panels.size
  }

  /** Number of panels currently discarded. */
  get discardedCount(): number {
    return this.discarded.size
  }

  /** Emit a discard/recreate state change to the renderer. */
  private emitDiscardState(panelId: PanelId, discarded: boolean, url?: string): void {
    const wc = this.window?.webContents
    if (!wc || wc.isDestroyed()) return
    const event: PanelDiscardStateEvent = { panelId, discarded, url }
    wc.send(IPC.PanelDiscardState, event)
  }

  /** Emit a PanelUpdate event to the renderer (no-op if window is gone). */
  private emitUpdate(panelId: PanelId, patch: PanelUpdateEvent['patch']): void {
    const wc = this.window?.webContents
    if (!wc || wc.isDestroyed()) return
    const event: PanelUpdateEvent = { panelId, patch }
    wc.send(IPC.PanelUpdate, event)
  }

  private toIntBounds(b: PanelBounds): PanelBounds {
    return {
      x: Math.round(b.x),
      y: Math.round(b.y),
      width: Math.round(b.width),
      height: Math.round(b.height)
    }
  }

  /** Create a panel view, load its URL, wire events, and keep it hidden. */
  create(payload: PanelCreatePayload): void {
    const { panelId, partition, url } = payload
    if (this.panels.has(panelId)) {
      // Idempotent: if it already exists, just (re)navigate.
      this.navigate({ panelId, url })
      return
    }
    // If it was discarded, a fresh create supersedes the saved entry.
    this.discarded.delete(panelId)
    this.buildView(panelId, partition, url)
  }

  /**
   * Build a hidden WebContentsView for a panel, wire it, and load `url`. Shared
   * by create() and the recreate-on-return path; both want identical setup.
   */
  private buildView(panelId: PanelId, partition: string, url: string): PanelEntry {
    const view = new WebContentsView({
      webPreferences: {
        partition,
        contextIsolation: true,
        sandbox: true
      }
    })

    const now = Date.now()
    const entry: PanelEntry = {
      view,
      attached: false,
      partition,
      lastActiveAt: now,
      // Newly created views start hidden, so they are eligible to be swept.
      hiddenSince: now
    }
    this.panels.set(panelId, entry)

    // Hidden until ShowOnly positions it; start with zeroed bounds.
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
    view.setVisible(false)

    this.wireEvents(panelId, view)

    const wc = view.webContents
    // Keep navigation inside the view; route real new-window/_blank externally.
    wc.setWindowOpenHandler(({ url: target }) => {
      if (target && /^https?:\/\//i.test(target)) {
        void shell.openExternal(target)
      }
      return { action: 'deny' }
    })

    void wc.loadURL(url).catch((err) => {
      console.error(`[decks] panel ${panelId} failed to load ${url}:`, err)
    })

    return entry
  }

  /**
   * Ensure a panel has a live view, recreating it from the discarded record if
   * needed. Returns the entry, or undefined if the panel is unknown to us.
   */
  private ensureLive(panelId: PanelId): PanelEntry | undefined {
    const existing = this.panels.get(panelId)
    if (existing) return existing
    const saved = this.discarded.get(panelId)
    if (!saved) return undefined
    this.discarded.delete(panelId)
    const entry = this.buildView(panelId, saved.partition, saved.url)
    // Tell the renderer the panel is back so it clears `discarded`.
    this.emitDiscardState(panelId, false)
    return entry
  }

  private wireEvents(panelId: PanelId, view: WebContentsView): void {
    const wc = view.webContents

    const navState = (): { canGoBack: boolean; canGoForward: boolean } => ({
      canGoBack: wc.canGoBack(),
      canGoForward: wc.canGoForward()
    })

    wc.on('page-title-updated', (_e, title) => {
      this.emitUpdate(panelId, { title, badge: parseBadge(title) })
    })

    // REAL media state — gate on actual AUDIBILITY so silent/background media
    // elements (e.g. Claude's UI) don't light up the badge. Only audible playback
    // counts as "playing".
    const syncAudible = (): void => {
      if (wc.isDestroyed()) return
      const audible = wc.isCurrentlyAudible()
      // Audible playback keeps the view "active" so the sweep never discards it.
      if (audible) {
        const e = this.panels.get(panelId)
        if (e) e.lastActiveAt = Date.now()
      }
      this.emitUpdate(panelId, { playing: audible })
    }
    wc.on('media-started-playing', () => setTimeout(syncAudible, 250))
    wc.on('media-paused', () => this.emitUpdate(panelId, { playing: false }))
    // Audibility can change without a media event (mute/unmute) — re-check.
    wc.on('did-stop-loading', syncAudible)

    wc.on('page-favicon-updated', (_e, favicons) => {
      if (favicons && favicons.length > 0) {
        this.emitUpdate(panelId, { favicon: favicons[0] })
      }
    })

    wc.on('did-start-loading', () => {
      this.emitUpdate(panelId, { loading: true })
    })

    wc.on('did-stop-loading', () => {
      this.emitUpdate(panelId, { loading: false, ...navState() })
    })

    wc.on('did-navigate', (_e, navUrl) => {
      this.emitUpdate(panelId, { url: navUrl, ...navState() })
    })

    wc.on('did-navigate-in-page', (_e, navUrl, isMainFrame) => {
      if (!isMainFrame) return
      this.emitUpdate(panelId, { url: navUrl, ...navState() })
    })
  }

  /**
   * Tear down the WebContentsView for a panel WITHOUT removing it from the
   * panels map (caller decides). Frees the renderer process. Never throws.
   */
  private teardownView(panelId: PanelId, entry: PanelEntry): void {
    this.detach(entry)
    try {
      const wc = entry.view.webContents
      if (!wc.isDestroyed()) {
        wc.removeAllListeners()
        wc.close()
      }
    } catch (err) {
      console.error(`[decks] error tearing down panel ${panelId}:`, err)
    }
  }

  /** Destroy a panel entirely: free its view and forget it (incl. discard record). */
  destroy(panelId: PanelId): void {
    const entry = this.panels.get(panelId)
    if (entry) {
      this.teardownView(panelId, entry)
      this.panels.delete(panelId)
    }
    // A user-initiated destroy (delete deck / reset) also clears any discard
    // memory so the panel won't silently come back.
    this.discarded.delete(panelId)
  }

  navigate(payload: PanelNavigatePayload): void {
    // Recreate the view if this panel was discarded, then load.
    const entry = this.ensureLive(payload.panelId)
    if (!entry) return
    entry.lastActiveAt = Date.now()
    void entry.view.webContents.loadURL(payload.url).catch((err) => {
      console.error(`[decks] panel ${payload.panelId} navigate failed:`, err)
    })
  }

  reload(panelId: PanelId): void {
    const entry = this.ensureLive(panelId)
    if (!entry) return
    entry.lastActiveAt = Date.now()
    entry.view.webContents.reload()
  }

  goBack(panelId: PanelId): void {
    const wc = this.panels.get(panelId)?.view.webContents
    if (wc && wc.canGoBack()) wc.goBack()
  }

  goForward(panelId: PanelId): void {
    const wc = this.panels.get(panelId)?.view.webContents
    if (wc && wc.canGoForward()) wc.goForward()
  }

  setBounds(payload: PanelSetBoundsPayload): void {
    // Referencing a discarded panel recreates it (renderer repositions on return).
    const entry = this.ensureLive(payload.panelId)
    if (!entry) return
    entry.view.setBounds(this.toIntBounds(payload.bounds))
  }

  /** Attach a view to the window's contentView (top of z-order) if needed. */
  private attach(entry: PanelEntry): void {
    if (!this.window || this.window.isDestroyed()) return
    if (!entry.attached) {
      this.window.contentView.addChildView(entry.view)
      entry.attached = true
    }
    entry.view.setVisible(true)
  }

  /** Detach a view from the window and hide/zero it. */
  private detach(entry: PanelEntry): void {
    try {
      entry.view.setVisible(false)
      entry.view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
      if (entry.attached && this.window && !this.window.isDestroyed()) {
        this.window.contentView.removeChildView(entry.view)
      }
    } catch {
      /* view may already be torn down — ignore */
    }
    entry.attached = false
  }

  /**
   * Show ONLY the given panels (positioned via the bounds map, in the given
   * z-order) and detach every other panel. This is how workspace switching
   * works: the active workspace's panels appear, all others vanish.
   */
  showOnly(payload: PanelShowOnlyPayload): void {
    const show = new Set(payload.panelIds)
    const now = Date.now()

    // Detach everything not in the show set first; mark it hidden for the sweep.
    for (const [id, entry] of this.panels) {
      if (!show.has(id)) {
        this.detach(entry)
        if (entry.hiddenSince == null) entry.hiddenSince = now
      }
    }

    // Attach + position the requested panels, honoring the array's z-order
    // (later entries are added last → drawn on top). Recreate any discarded ones.
    for (const id of payload.panelIds) {
      const entry = this.ensureLive(id)
      if (!entry) continue
      const b = payload.bounds[id]
      this.attach(entry)
      // Shown ⇒ active and no longer hidden.
      entry.lastActiveAt = now
      entry.hiddenSince = null
      if (b) entry.view.setBounds(this.toIntBounds(b))
    }
  }

  /** Detach/hide every panel so pure-renderer UI is fully visible. */
  hideAll(): void {
    const now = Date.now()
    for (const entry of this.panels.values()) {
      this.detach(entry)
      if (entry.hiddenSince == null) entry.hiddenSince = now
    }
  }

  // ── Discard manager ─────────────────────────────────────────────────────

  /** Start the periodic sweep that discards long-hidden views. Idempotent. */
  private startSweep(): void {
    if (this.sweepTimer) return
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS)
    // Don't let the timer keep the process alive on its own.
    this.sweepTimer.unref?.()
  }

  /**
   * Discard any view hidden longer than DISCARD_AFTER_MS. Never discards a
   * visible (attached) panel or one that's currently audible (mirrors Chrome).
   */
  private sweep(): void {
    const now = Date.now()
    for (const [id, entry] of [...this.panels]) {
      // Visible/active panels have no hiddenSince and are never candidates.
      if (entry.hiddenSince == null || entry.attached) continue
      // Audible playback pins the panel even while hidden.
      try {
        if (entry.view.webContents.isCurrentlyAudible()) {
          entry.lastActiveAt = now
          continue
        }
      } catch {
        /* destroyed mid-sweep — fall through to cleanup */
      }
      if (now - entry.hiddenSince < this.discardAfterMs) continue
      this.discardPanel(id, entry)
    }
  }

  /**
   * Free a hidden panel's renderer: capture its URL, destroy the view, remember
   * the URL+partition for recreation, and notify the renderer to mark discarded.
   */
  private discardPanel(panelId: PanelId, entry: PanelEntry): void {
    let url = ''
    try {
      url = entry.view.webContents.getURL() || ''
    } catch {
      /* ignore */
    }
    this.teardownView(panelId, entry)
    this.panels.delete(panelId)
    this.discarded.set(panelId, { url, partition: entry.partition })
    this.emitDiscardState(panelId, true, url)
  }

  /** Destroy every panel view + stop the sweep (used on shutdown). Never throws. */
  destroyAll(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
    for (const id of [...this.panels.keys()]) {
      try {
        this.destroy(id)
      } catch {
        /* ignore */
      }
    }
    this.panels.clear()
    this.discarded.clear()
  }
}
