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
  PanelDiscardStateEvent,
  MiniPlayerMeta
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
  /** Last known URL (kept fresh from navigation) — used for isYouTube checks. */
  url: string
  /** Last now-playing metadata parsed from this view's mediaSession (YouTube). */
  meta?: MiniPlayerMeta
}

/**
 * Callbacks the glue layer (index.ts) installs to bridge the mini-player to the
 * always-on-top overlay window. PanelManager owns the WHEN (corner/teardown);
 * the glue owns the HOW (drawing the control bar).
 */
export interface MiniPlayerHooks {
  /** Mini-player became active: draw the bar at `rect` with `meta`. */
  onStart(rect: PanelBounds, meta: MiniPlayerMeta): void
  /** Now-playing metadata/playstate changed for the active mini-player. */
  onUpdate(meta: MiniPlayerMeta): void
  /** Mini-player ended (returned to full size / went away): hide the bar. */
  onEnd(): void
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

/** True when a URL is a YouTube property eligible for the corner mini-player. */
function isYouTube(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return (
      host === 'youtube.com' ||
      host.endsWith('.youtube.com') ||
      host === 'youtu.be' ||
      host.endsWith('.youtu.be')
    )
  } catch {
    return false
  }
}

// ── Mini-player corner geometry ──
const MINI_WIDTH = 320
const MINI_HEIGHT = 180
const MINI_MARGIN = 16

/**
 * Page-injected metadata/playstate sentinel prefix. The injected script (which
 * runs in the YouTube view's EXISTING sandbox — no preload, no node) cannot use
 * IPC, so it emits one-way messages over `console.log`; we parse them in the
 * `console-message` handler. This is the ONLY page→main channel for these views.
 */
const MP_SENTINEL = 'DECKS_MP::'

/**
 * Idempotent in-page reporter for now-playing state. Reads the WEB-STANDARD
 * `navigator.mediaSession.metadata` (title/artist/artwork — YouTube populates
 * this; we deliberately do NOT scrape DOM/page title) plus the first <video>
 * element's play state, and logs a sentinel line main can parse. Guarded by
 * `window.__decksMP` so re-injection is a no-op.
 */
const MP_INJECT_SCRIPT = `(() => {
  if (window.__decksMP) return;
  window.__decksMP = true;
  var last = '';
  function report() {
    try {
      var md = (navigator.mediaSession && navigator.mediaSession.metadata) || null;
      var v = document.querySelector('video');
      var art = '';
      if (md && md.artwork && md.artwork.length) art = md.artwork[0].src || '';
      var payload = {
        title: md ? (md.title || '') : '',
        artist: md ? (md.artist || '') : '',
        artwork: art,
        paused: v ? !!v.paused : true,
        currentTime: v ? (v.currentTime || 0) : 0,
        duration: v && isFinite(v.duration) ? v.duration : 0
      };
      var s = JSON.stringify(payload);
      if (s === last) return;
      last = s;
      console.log(${JSON.stringify(MP_SENTINEL)} + s);
    } catch (e) {}
  }
  var lastTU = 0;
  function onTimeUpdate() {
    var now = Date.now();
    if (now - lastTU < 1000) return; // throttle ~1s
    lastTU = now;
    report();
  }
  function bind(v) {
    if (!v || v.__decksBound) return;
    v.__decksBound = true;
    v.addEventListener('loadedmetadata', report);
    v.addEventListener('play', report);
    v.addEventListener('pause', report);
    v.addEventListener('timeupdate', onTimeUpdate);
  }
  // Bind the current video and watch for SPA navigations swapping it out.
  bind(document.querySelector('video'));
  var mo = new MutationObserver(function () { bind(document.querySelector('video')); });
  try { mo.observe(document.documentElement, { childList: true, subtree: true }); } catch (e) {}
  report();
})();`

export class PanelManager {
  private readonly panels = new Map<PanelId, PanelEntry>()
  /** Panels whose renderer was discarded; recreated automatically on return. */
  private readonly discarded = new Map<PanelId, DiscardedEntry>()
  private window: BrowserWindow | null = null
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  /** Idle-discard threshold (ms); configurable from Settings. */
  private discardAfterMs = DISCARD_AFTER_MS
  /** The single panel currently shrunk into the corner mini-player (or null). */
  private miniPanelId: PanelId | null = null
  /** Glue hooks for driving the overlay control bar (installed by index.ts). */
  private miniHooks: MiniPlayerHooks | null = null

  /** Bind the window the panels are overlaid onto. Call once after creation. */
  setWindow(win: BrowserWindow): void {
    this.window = win
    this.startSweep()
  }

  /** Change the idle-discard threshold (minutes → ms applied by the caller). */
  setDiscardAfterMs(ms: number): void {
    if (ms > 0) this.discardAfterMs = ms
  }

  /** Install the glue hooks that bridge the mini-player to the overlay window. */
  setMiniPlayerHooks(hooks: MiniPlayerHooks): void {
    this.miniHooks = hooks
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
      hiddenSince: now,
      url
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

    // ── Mini-player now-playing bridge (YouTube views only) ──
    // After each load settles, (re)inject the idempotent reporter so metadata is
    // ready BEFORE the mini-player ever pops. Safe on non-YouTube views (skipped).
    wc.on('did-stop-loading', () => {
      const e = this.panels.get(panelId)
      if (!e || !isYouTube(e.url)) return
      void wc.executeJavaScript(MP_INJECT_SCRIPT).catch(() => {
        /* page may navigate away mid-inject — harmless */
      })
    })

    // One-way page→main channel: the injected reporter emits a sentinel line over
    // console.log; parse it into MiniPlayerMeta and forward to the active player.
    wc.on('console-message', (_e, _level, message) => {
      if (typeof message !== 'string' || !message.startsWith(MP_SENTINEL)) return
      try {
        const data = JSON.parse(message.slice(MP_SENTINEL.length)) as {
          title?: string
          artist?: string
          artwork?: string
          paused?: boolean
        }
        const meta: MiniPlayerMeta = {
          title: data.title || '',
          artist: data.artist || '',
          artwork: data.artwork || undefined,
          paused: !!data.paused
        }
        const e = this.panels.get(panelId)
        if (e) e.meta = meta
        // Only push live updates while THIS panel is the active mini-player.
        if (this.miniPanelId === panelId) this.miniHooks?.onUpdate(meta)
      } catch {
        /* malformed sentinel — ignore */
      }
    })

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
      const e = this.panels.get(panelId)
      if (e) e.url = navUrl
      this.emitUpdate(panelId, { url: navUrl, ...navState() })
    })

    wc.on('did-navigate-in-page', (_e, navUrl, isMainFrame) => {
      if (!isMainFrame) return
      const e = this.panels.get(panelId)
      if (e) e.url = navUrl
      this.emitUpdate(panelId, { url: navUrl, ...navState() })
    })
  }

  /**
   * Tear down the WebContentsView for a panel WITHOUT removing it from the
   * panels map (caller decides). Frees the renderer process. Never throws.
   */
  private teardownView(panelId: PanelId, entry: PanelEntry): void {
    // If this view IS the corner mini-player, end it so the overlay bar clears
    // and we never point controls at a dead WebContents.
    if (this.miniPanelId === panelId) {
      this.miniPanelId = null
      this.miniHooks?.onEnd()
    }
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
    entry.url = payload.url
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

    // ── Decide who (if anyone) should remain as a corner mini-player ──
    // A panel qualifies when it is a YouTube view, currently audible, and NOT in
    // the incoming show-set (the user is switching AWAY from it while it plays).
    let nextMini: PanelId | null = null
    for (const [id, entry] of this.panels) {
      if (show.has(id)) continue
      if (!isYouTube(entry.url)) continue
      try {
        if (entry.view.webContents.isDestroyed()) continue
        if (!entry.view.webContents.isCurrentlyAudible()) continue
      } catch {
        continue
      }
      nextMini = id
      break
    }
    // If the existing mini panel is being shown again (user returned) or it no
    // longer qualifies, it must be torn down below; only keep it if it's still
    // the chosen mini AND not in the show-set.
    if (this.miniPanelId && (show.has(this.miniPanelId) || this.miniPanelId !== nextMini)) {
      this.endMiniPlayer()
    }

    // Detach everything not in the show set first; mark it hidden for the sweep.
    // EXCEPTION: the chosen mini-player panel stays attached (sized to the corner
    // afterwards), so it keeps playing as a real, watchable corner video.
    for (const [id, entry] of this.panels) {
      if (show.has(id)) continue
      if (id === nextMini) continue
      this.detach(entry)
      if (entry.hiddenSince == null) entry.hiddenSince = now
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

    // ── Activate / re-raise the corner mini-player LAST so it stays on top ──
    // addChildView raises to the top of z-order, so attaching the mini view after
    // the workspace panels guarantees the corner video is never covered.
    if (nextMini) {
      const entry = this.panels.get(nextMini)
      if (entry) {
        const rect = this.cornerRect()
        // Re-attach to RAISE above the just-attached workspace panels.
        this.attach(entry)
        entry.view.setBounds(rect)
        entry.lastActiveAt = now
        entry.hiddenSince = null
        this.miniPanelId = nextMini
        const meta = entry.meta ?? { title: '', artist: '', paused: false }
        // onStart (re)draws the bar at the current corner rect — used both when
        // the mini-player first activates and to keep it pinned across switches.
        this.miniHooks?.onStart(rect, meta)
      }
    }
  }

  /** The corner rectangle for the mini-player: bottom-right, fixed size + margin. */
  private cornerRect(): PanelBounds {
    const c = this.window?.getContentBounds()
    const w = c?.width ?? MINI_WIDTH + MINI_MARGIN * 2
    const h = c?.height ?? MINI_HEIGHT + MINI_MARGIN * 2
    return this.toIntBounds({
      x: w - MINI_WIDTH - MINI_MARGIN,
      y: h - MINI_HEIGHT - MINI_MARGIN,
      width: MINI_WIDTH,
      height: MINI_HEIGHT
    })
  }

  /**
   * Tear down the corner mini-player: detach/hide the view (back to a normal
   * hidden panel, eligible for the sweep again) and tell the overlay to hide the
   * control bar. Safe to call when no mini-player is active.
   */
  private endMiniPlayer(): void {
    const id = this.miniPanelId
    if (!id) return
    this.miniPanelId = null
    const entry = this.panels.get(id)
    if (entry && !entry.attached) {
      // Already detached by the showOnly sweep — nothing to do for the view.
    } else if (entry) {
      this.detach(entry)
      if (entry.hiddenSince == null) entry.hiddenSince = Date.now()
    }
    this.miniHooks?.onEnd()
  }

  // ── Mini-player media controls (main → page) ─────────────────────────────

  /** The live WebContents of the active mini-player, or null. */
  private miniWc(): Electron.WebContents | null {
    if (!this.miniPanelId) return null
    const entry = this.panels.get(this.miniPanelId)
    if (!entry) return null
    const wc = entry.view.webContents
    return wc.isDestroyed() ? null : wc
  }

  /** Resume playback in the corner video. STABLE (web-standard HTMLMediaElement). */
  miniPlay(): void {
    void this.miniWc()
      ?.executeJavaScript("document.querySelector('video')?.play()")
      .catch(() => {})
  }

  /** Pause the corner video. STABLE (web-standard HTMLMediaElement). */
  miniPause(): void {
    void this.miniWc()
      ?.executeJavaScript("document.querySelector('video')?.pause()")
      .catch(() => {})
  }

  /** Seek the corner video. STABLE (web-standard HTMLMediaElement). */
  miniSeek(time: number): void {
    const t = Number.isFinite(time) ? Math.max(0, time) : 0
    void this.miniWc()
      ?.executeJavaScript(`(()=>{var v=document.querySelector('video');if(v)v.currentTime=${t};})()`)
      .catch(() => {})
  }

  /**
   * Skip to the next item. ⚠️ FRAGILE: this uses YouTube's OWN keyboard shortcut
   * (Shift+N), which is YouTube-specific and NOT a web standard. If "next" breaks
   * after a YouTube change, suspect this first — everything else here is stable.
   */
  miniNext(): void {
    const wc = this.miniWc()
    if (!wc) return
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'N', modifiers: ['shift'] })
    wc.sendInputEvent({ type: 'char', keyCode: 'N', modifiers: ['shift'] })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'N', modifiers: ['shift'] })
  }

  /**
   * Skip to the previous item. ⚠️ FRAGILE: YouTube's OWN shortcut (Shift+P),
   * YouTube-specific and NOT a web standard. First suspect if "previous" breaks.
   */
  miniPrevious(): void {
    const wc = this.miniWc()
    if (!wc) return
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'P', modifiers: ['shift'] })
    wc.sendInputEvent({ type: 'char', keyCode: 'P', modifiers: ['shift'] })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'P', modifiers: ['shift'] })
  }

  /** The panelId of the active mini-player (for the close→focus glue), or null. */
  get miniPlayerPanelId(): PanelId | null {
    return this.miniPanelId
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
