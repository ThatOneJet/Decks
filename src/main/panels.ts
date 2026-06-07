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
import { WebContentsView, BrowserWindow, shell, app, screen } from 'electron'
import type { Display } from 'electron'
import { appendFileSync } from 'fs'
import { join } from 'path'
import { IPC } from '@shared/ipc'
import type {
  PanelCreatePayload,
  PanelNavigatePayload,
  PanelSetBoundsPayload,
  PanelShowOnlyPayload,
  PanelTearOffPayload,
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
/**
 * Soft cap on LIVE WebContentsViews (renderer processes). Before creating a new
 * view, if we're at/over this many live panels we proactively discard the
 * least-recently-active HIDDEN deck to make room — so a deck the user is opening
 * always gets a renderer and never comes up blank, regardless of the idle timer.
 * Visible (attached), audible, and keep-alive decks are never evicted.
 */
const MAX_LIVE_PANELS = 14

/**
 * Clean desktop-Chrome User-Agent presented to every embedded deck (and any
 * in-app OAuth popup it opens). Google sign-in and other providers reject the
 * default Electron UA ("disallowed_useragent" / "unsupported browser"), so we
 * masquerade as plain Chrome. Shared with the app-level userAgentFallback in
 * index.ts so child windows that bypass the per-view UA still look like Chrome.
 */
export const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

/**
 * Client-hint (`Sec-CH-UA*`) values matching CHROME_UA. Setting the User-Agent
 * string alone is NOT enough for Google sign-in: Chromium ALSO sends a brand
 * list that includes "Electron", and Google reads those headers to flag an
 * embedded/insecure browser ("Couldn't sign you in — this browser may not be
 * secure"). We rewrite the brand headers per session so they look like real
 * Chrome. ⚠️ Best-effort: Google actively fights embedded sign-in and may add
 * new signals, so this can need bumping over time.
 */
const CH_UA = '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"'
const CH_UA_FULL =
  '"Chromium";v="130.0.0.0", "Google Chrome";v="130.0.0.0", "Not?A_Brand";v="99.0.0.0"'

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
  /** Mini-player became active: draw the bar at `rect` with `meta`. When
   *  `collapsed`, draw the slim side tab (arrow points in from `edge`). */
  onStart(
    rect: PanelBounds,
    meta: MiniPlayerMeta,
    collapsed: boolean,
    edge: 'left' | 'right'
  ): void
  /** Now-playing metadata/playstate changed for the active mini-player. */
  onUpdate(meta: MiniPlayerMeta): void
  /** Live audio levels (0..1 per bar) for the active mini-player's visualizer. */
  onLevels(levels: number[]): void
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

/** True for the Spotify web player (open.spotify.com). */
function isSpotify(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return host === 'open.spotify.com' || host.endsWith('.spotify.com')
  } catch {
    return false
  }
}

/** Any audio site we drive with the corner mini-player (now-playing + controls
 *  via web-standard mediaSession/<video>/<audio>; ad-skip is YouTube-only). */
function isMiniSite(url: string): boolean {
  return isYouTube(url) || isSpotify(url)
}

// ── Mini-player card geometry ──
// A vertical card: thumbnail + title, a controls row, a seek bar with a timer,
// and a search box. Positioned in SCREEN coordinates (not window-relative) so it
// floats anywhere on the display and survives the app window being minimized.
const CARD_WIDTH = 320
// Generous upper bound for the card's content (thumbnail row + visualizer +
// controls + seek bar + search box). The card is top-anchored with AUTO height,
// so any leftover window space below it is transparent — never a visible gap —
// while still guaranteeing the content is never clipped.
const CARD_HEIGHT = 196
const BAR_MARGIN = 16
// Collapsed "pull tab" — a slim arrow handle docked at a screen edge.
const TAB_W = 22
const TAB_H = 64

/**
 * Page-injected metadata/playstate sentinel prefix. The injected script (which
 * runs in the YouTube view's EXISTING sandbox — no preload, no node) cannot use
 * IPC, so it emits one-way messages over `console.log`; we parse them in the
 * `console-message` handler. This is the ONLY page→main channel for these views.
 */
const MP_SENTINEL = 'DECKS_MP::'

/** Sentinel for live audio levels (real visualizer): `DECKS_EQ::[0.1,0.4,...]`. */
const EQ_SENTINEL = 'DECKS_EQ::'

/**
 * Idempotent in-page reporter for now-playing state. Reads the WEB-STANDARD
 * `navigator.mediaSession.metadata` (title/artist/artwork — YouTube populates
 * this; we deliberately do NOT scrape DOM/page title) plus the first <video>
 * element's play state, and logs a sentinel line main can parse. Guarded by
 * `window.__decksMP` so re-injection is a no-op.
 *
 * It ALSO runs a best-effort YouTube ad-skipper: clicks the "Skip" button when
 * one appears, fast-forwards unskippable ads to their end, and dismisses ad
 * overlays. ⚠️ FRAGILE: this depends on YouTube's DOM/class names (`.ad-showing`,
 * `.ytp-ad-skip-button*`), so it can break if YouTube changes them.
 */
const MP_INJECT_SCRIPT = `(() => {
  if (window.__decksMP) return;
  window.__decksMP = true;
  // The playing media element — <video> (YouTube) or <audio> (Spotify web).
  function mediaEl() { return document.querySelector('video') || document.querySelector('audio'); }
  var last = '';
  function report() {
    try {
      var md = (navigator.mediaSession && navigator.mediaSession.metadata) || null;
      var v = mediaEl();
      var art = '';
      if (md && md.artwork && md.artwork.length) art = md.artwork[0].src || '';
      var payload = {
        title: md ? (md.title || '') : '',
        artist: md ? (md.artist || '') : '',
        artwork: art,
        paused: v ? !!v.paused : true,
        loop: v ? !!v.loop : false,
        currentTime: v ? (v.currentTime || 0) : 0,
        duration: v && isFinite(v.duration) ? v.duration : 0,
        adShowing: !!document.querySelector('.html5-video-player.ad-showing')
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
    v.addEventListener('play', function () { setupEq(v); });
    v.addEventListener('pause', report);
    v.addEventListener('timeupdate', onTimeUpdate);
  }
  // Bind the current media element and watch for SPA navigations swapping it out.
  bind(mediaEl());
  var mo = new MutationObserver(function () { bind(mediaEl()); });
  try { mo.observe(document.documentElement, { childList: true, subtree: true }); } catch (e) {}
  // Best-effort ad-skipper (YouTube-specific DOM; see JSDoc).
  function skipAds() {
    try {
      var btn = document.querySelector(
        '.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button, .ytp-ad-skip-button-container button'
      );
      if (btn) { btn.click(); }
      var player = document.querySelector('.html5-video-player');
      var v = document.querySelector('video');
      // Unskippable ad playing → jump to its end so real content resumes.
      if (player && player.classList.contains('ad-showing') && v && isFinite(v.duration) && v.duration > 0) {
        v.currentTime = v.duration;
        if (v.paused) { try { v.play(); } catch (e) {} }
      }
      var ov = document.querySelector('.ytp-ad-overlay-close-button, .ytp-ad-overlay-close-container');
      if (ov) { ov.click(); }
    } catch (e) {}
  }
  try { setInterval(skipAds, 500); } catch (e) {}

  // ── Real audio visualizer ──
  // Analyze a COPY of the element's audio via captureStream() → a
  // MediaStreamAudioSourceNode → AnalyserNode. Unlike createMediaElementSource
  // this does NOT reroute the element's output (so audio is never silenced) and
  // it works even when the site already taps the element with its own Web Audio
  // graph (YouTube does) — that's why the previous approach showed nothing.
  var EQ_BARS = ${'18'};
  var eqCtx = null, eqAnalyser = null, eqData = null, eqRAF = 0, eqSrcEl = null;
  function ensureAnalyser() {
    if (eqAnalyser) return;
    eqAnalyser = eqCtx.createAnalyser();
    eqAnalyser.fftSize = 1024;
    eqAnalyser.smoothingTimeConstant = 0.5;
    eqData = new Uint8Array(eqAnalyser.frequencyBinCount);
  }
  function eqConnect(v) {
    try {
      if (eqSrcEl === v || !eqCtx || eqCtx.state !== 'running') return;
      ensureAnalyser();
      var src = null;
      try {
        // Preferred: tap the element directly (route its audio through the graph
        // so it stays audible).
        src = eqCtx.createMediaElementSource(v);
        eqAnalyser.connect(eqCtx.destination);
      } catch (e1) {
        // The element is already tapped by the site (YouTube) → analyze a COPY via
        // captureStream instead (do NOT connect to destination — avoids an echo).
        var cs = v.captureStream || v.mozCaptureStream;
        if (cs) {
          var stream = cs.call(v);
          if (stream && stream.getAudioTracks && stream.getAudioTracks().length) {
            src = eqCtx.createMediaStreamSource(stream);
          }
        }
      }
      if (!src) return; // not ready yet — retry later
      src.connect(eqAnalyser);
      eqSrcEl = v;
      if (!eqRAF) eqLoop();
    } catch (e) { /* not ready / unsupported — leave audio untouched, retry later */ }
  }
  function setupEq(v) {
    try {
      if (!v || eqSrcEl === v) return;
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!eqCtx) eqCtx = new AC();
      // The analyser only updates while the context is RUNNING; resume it (sticky
      // user activation from pressing play lets this succeed on the hidden page).
      if (eqCtx.state === 'suspended') {
        eqCtx.resume().then(function () { eqConnect(v); }).catch(function () {});
      } else {
        eqConnect(v);
      }
    } catch (e) {}
  }
  var eqLastSend = 0;
  function eqLoop() {
    eqRAF = requestAnimationFrame(eqLoop);
    try {
      var now = Date.now();
      if (now - eqLastSend < 45) return; // ~22fps, snappy enough for drum hits
      eqLastSend = now;
      if (!eqAnalyser || !eqData) return;
      eqAnalyser.getByteFrequencyData(eqData);
      // Map bins to bars on a LOG scale (music/pitch is logarithmic), so bass,
      // mids and treble each get their own bars instead of bass swamping all of
      // them. Skip the lowest couple of bins (DC/rumble). Use the peak in each
      // band (punchier than the mean) and boost higher bands (naturally quieter).
      var bins = eqData.length;
      var minBin = 2;
      var maxBin = Math.floor(bins * 0.85);
      var out = [];
      for (var b = 0; b < EQ_BARS; b++) {
        var lo = Math.floor(minBin * Math.pow(maxBin / minBin, b / EQ_BARS));
        var hi = Math.floor(minBin * Math.pow(maxBin / minBin, (b + 1) / EQ_BARS));
        if (hi <= lo) hi = lo + 1;
        var peak = 0;
        for (var k = lo; k < hi && k < bins; k++) if (eqData[k] > peak) peak = eqData[k];
        var raw = peak / 255; // 0..1
        // Tilt up the higher bands so treble is visible next to bass.
        raw *= 1 + (b / EQ_BARS) * 0.9;
        if (raw > 1) raw = 1;
        // Expand dynamics: drop a ~12% noise floor and rescale, then a slight
        // power curve so LOUD content (drum hits) shoots up while quiet content
        // stays low — the opposite of compressing everything toward the top.
        var v = (raw - 0.12) / 0.88;
        if (v < 0) v = 0;
        v = Math.pow(v, 1.35);
        // ...but keep a little life proportional to the actual signal so a quiet
        // singer still wiggles (and true silence reads as flat, not a fake idle).
        var floor = raw * 0.18;
        if (v < floor) v = floor;
        if (v > 1) v = 1;
        out.push(Math.round(v * 100) / 100);
      }
      console.log(${JSON.stringify(EQ_SENTINEL)} + JSON.stringify(out));
    } catch (e) {}
  }
  setupEq(mediaEl());
  // Re-tap when the page swaps the media element on navigation.
  var eqMo = new MutationObserver(function () { setupEq(mediaEl()); });
  try { eqMo.observe(document.documentElement, { childList: true, subtree: true }); } catch (e) {}
  // captureStream only exposes audio tracks once playback has started, so keep
  // retrying until we're connected (then stop).
  var eqTries = 0;
  var eqRetry = setInterval(function () {
    if (eqSrcEl) { clearInterval(eqRetry); return; }
    setupEq(mediaEl());
    if (++eqTries > 60) clearInterval(eqRetry);
  }, 700);

  // TEMP DIAGNOSTIC: report the analyser's state so we can see why bars aren't
  // moving. Removed once the visualizer is confirmed working.
  setInterval(function () {
    try {
      var v = mediaEl();
      var mx = 0;
      if (eqAnalyser && eqData) {
        eqAnalyser.getByteFrequencyData(eqData);
        for (var i = 0; i < eqData.length; i++) if (eqData[i] > mx) mx = eqData[i];
      }
      console.log('DECKS_DBG::' + JSON.stringify({
        ctx: !!eqCtx,
        state: eqCtx ? eqCtx.state : 'none',
        connected: !!eqSrcEl,
        raf: !!eqRAF,
        media: v ? v.tagName : 'none',
        paused: v ? !!v.paused : true,
        cs: !!(v && (v.captureStream || v.mozCaptureStream)),
        max: mx
      }));
    } catch (e) { console.log('DECKS_DBG::err ' + (e && e.message)); }
  }, 2000);

  // Refresh hook: re-arm the visualizer + re-report WITHOUT reloading the page
  // (so the song doesn't restart). Clears a stuck equalizer.
  window.__decksMPRefresh = function () {
    try {
      if (eqCtx && eqCtx.state === 'suspended') { try { eqCtx.resume(); } catch (e) {} }
      bind(mediaEl());
      setupEq(mediaEl());
      if (eqAnalyser && !eqRAF) eqLoop();
      last = '';
      report();
    } catch (e) {}
  };

  report();
})();`

export class PanelManager {
  private readonly panels = new Map<PanelId, PanelEntry>()
  /** Panels whose renderer was discarded; recreated automatically on return. */
  private readonly discarded = new Map<PanelId, DiscardedEntry>()
  /** Panels the user pinned "keep alive": never discarded/evicted, kept loaded. */
  private readonly keepAlive = new Set<PanelId>()
  /** Partitions whose session has had the Chrome client-hint header patch applied. */
  private readonly patchedSessions = new Set<string>()
  private window: BrowserWindow | null = null
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  /** Idle-discard threshold (ms); configurable from Settings. */
  private discardAfterMs = DISCARD_AFTER_MS
  /** The single panel currently shrunk into the corner mini-player (or null). */
  private miniPanelId: PanelId | null = null
  /** True when the active mini was popped because the window was minimized (so it
   *  is torn down again on restore, rather than persisting like a switched-away one). */
  private miniByMinimize = false
  /** True when the mini-player is collapsed to its slim side "pull tab". */
  private miniCollapsed = false
  /** TEMP: counts EQ sentinel messages for diagnostics. */
  private eqDbgCount = 0
  /** Glue hooks for driving the overlay control bar (installed by index.ts). */
  private miniHooks: MiniPlayerHooks | null = null
  /**
   * User-chosen top-left of the corner video (window-relative px). null → the
   * default bottom-right corner. Set by dragging; remembered across pops.
   */
  private miniPos: { x: number; y: number } | null = null
  /** Snapshot of the corner top-left at drag start, for delta-based moves. */
  private miniDragAnchor: { x: number; y: number } | null = null

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

  /**
   * Pin/unpin a panel as "keep alive": it is never auto-discarded or evicted, so
   * its content stays loaded and ready. Called by the renderer when the user
   * toggles keep-alive on a workspace (and on hydrate for persisted pins).
   */
  setKeepAlive(panelId: PanelId, on: boolean): void {
    if (on) {
      this.keepAlive.add(panelId)
      // A pinned panel must not be sitting in the discarded set.
      const entry = this.panels.get(panelId)
      if (entry) {
        entry.lastActiveAt = Date.now()
        entry.hiddenSince = entry.attached ? null : entry.hiddenSince
      }
    } else {
      this.keepAlive.delete(panelId)
    }
  }

  /**
   * Before creating another renderer, make room if we're at the live soft cap:
   * discard the least-recently-active HIDDEN panel (never one that's attached,
   * audible, or keep-alive). Repeats until under the cap or nothing is evictable.
   */
  private evictForRoom(): void {
    let guard = 0
    while (this.panels.size >= MAX_LIVE_PANELS && guard++ < MAX_LIVE_PANELS) {
      let victim: PanelId | null = null
      let oldest = Infinity
      for (const [id, entry] of this.panels) {
        if (entry.attached || this.keepAlive.has(id) || id === this.miniPanelId) continue
        try {
          if (entry.view.webContents.isCurrentlyAudible()) continue
        } catch {
          /* destroyed — treat as evictable */
        }
        if (entry.lastActiveAt < oldest) {
          oldest = entry.lastActiveAt
          victim = id
        }
      }
      if (!victim) return // nothing evictable (all visible/audible/pinned)
      const entry = this.panels.get(victim)
      if (entry) this.discardPanel(victim, entry)
    }
  }

  /** Number of panels currently discarded. */
  get discardedCount(): number {
    return this.discarded.size
  }

  /**
   * Real per-panel memory for every LIVE panel. Maps each view's renderer OS pid
   * (getOSProcessId) to that pid's workingSetSize (KB) from app.getAppMetrics(),
   * converted to MB. Panels whose pid can't be resolved/found report 0 MB.
   */
  panelMetrics(): Array<{ panelId: string; mb: number }> {
    // Build a pid → workingSetSize(KB) lookup once per call.
    const byPid = new Map<number, number>()
    for (const m of app.getAppMetrics()) {
      byPid.set(m.pid, m.memory?.workingSetSize ?? 0)
    }
    const out: Array<{ panelId: string; mb: number }> = []
    for (const [panelId, entry] of this.panels) {
      let mb = 0
      try {
        const wc = entry.view.webContents
        if (!wc.isDestroyed()) {
          const pid = wc.getOSProcessId()
          const kb = byPid.get(pid)
          if (kb) mb = Math.round(kb / 1024)
        }
      } catch {
        /* destroyed mid-call — report 0 */
      }
      out.push({ panelId, mb })
    }
    return out
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
  /**
   * Rewrite outgoing User-Agent + Sec-CH-UA* client-hint headers on a session so
   * it presents as real Chrome (no "Electron" brand). Applied once per partition.
   * This is the server-side half of defeating Google's "browser may not be
   * secure" block; the UA string is set per-webContents separately.
   */
  private patchSessionUa(ses: Electron.Session, partition: string): void {
    if (this.patchedSessions.has(partition)) return
    this.patchedSessions.add(partition)
    ses.webRequest.onBeforeSendHeaders((details, cb) => {
      const headers = details.requestHeaders
      // Drop any existing UA / client-hint variants (case-insensitive) first so
      // we never end up sending duplicates of the same header.
      for (const key of Object.keys(headers)) {
        if (/^user-agent$/i.test(key) || /^sec-ch-ua/i.test(key)) delete headers[key]
      }
      headers['User-Agent'] = CHROME_UA
      headers['sec-ch-ua'] = CH_UA
      headers['sec-ch-ua-full-version-list'] = CH_UA_FULL
      headers['sec-ch-ua-mobile'] = '?0'
      headers['sec-ch-ua-platform'] = '"Windows"'
      headers['sec-ch-ua-platform-version'] = '"15.0.0"'
      cb({ requestHeaders: headers })
    })
  }

  /**
   * Override the User-Agent AND its client-hint METADATA at the CDP layer. Unlike
   * setUserAgent (string only) or header rewriting (request headers only), this
   * also drives `navigator.userAgentData` in page JS — which Google's OAuth
   * "this browser may not be secure" check reads to detect Electron. Setting a
   * real-Chrome brand list here is what actually lets Google sign-in through.
   * Best-effort: a no-op if the debugger can't attach (e.g. DevTools open).
   */
  private applyUaOverride(wc: Electron.WebContents): void {
    try {
      if (wc.isDestroyed()) return
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
      void wc.debugger.sendCommand('Network.setUserAgentOverride', {
        userAgent: CHROME_UA,
        acceptLanguage: 'en-US,en',
        platform: 'Windows',
        userAgentMetadata: {
          brands: [
            { brand: 'Chromium', version: '130' },
            { brand: 'Google Chrome', version: '130' },
            { brand: 'Not?A_Brand', version: '99' }
          ],
          fullVersionList: [
            { brand: 'Chromium', version: '130.0.0.0' },
            { brand: 'Google Chrome', version: '130.0.0.0' },
            { brand: 'Not?A_Brand', version: '99.0.0.0' }
          ],
          fullVersion: '130.0.0.0',
          platform: 'Windows',
          platformVersion: '15.0.0',
          architecture: 'x86',
          model: '',
          mobile: false,
          bitness: '64',
          wow64: false
        }
      })
    } catch {
      /* debugger unavailable (e.g. DevTools attached) — header rewrite still applies */
    }
  }

  private buildView(panelId: PanelId, partition: string, url: string): PanelEntry {
    // Make room first so this new deck is guaranteed a renderer process.
    this.evictForRoom()
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
    // Present as plain Chrome so Google sign-in et al. don't block the embedded
    // page ("disallowed_useragent"). Must be set BEFORE the first load.
    wc.setUserAgent(CHROME_UA)
    // Also rewrite the Sec-CH-UA* client-hint headers (brand list) so Chromium's
    // "Electron" brand never reaches Google — the UA string alone isn't enough.
    this.patchSessionUa(wc.session, partition)
    // And override the UA metadata at the CDP layer so navigator.userAgentData
    // (JS-visible) also presents as Chrome — required for Google OAuth.
    this.applyUaOverride(wc)

    // OAuth (Google, GitHub, …) opens a popup via window.open/_blank. We DENY the
    // auto-created popup and open our OWN window for it instead — that lets us set
    // the Chrome UA + UA-metadata override BEFORE the first byte loads. With the
    // old `action:'allow'` path the override could only be applied in
    // `did-create-window`, which fires AFTER the popup's document has already
    // started — too late for Google's `navigator.userAgentData` "is this a secure
    // browser" check, which is exactly why sign-in kept failing. The window shares
    // the deck's partition so the login still lands in the deck.
    // Non-http(s) schemes (mailto:, custom protocols) go to the OS handler.
    wc.setWindowOpenHandler(({ url: target }) => {
      if (target && /^https?:\/\//i.test(target)) {
        this.openAuthPopup(target, partition)
        return { action: 'deny' }
      }
      if (target) void shell.openExternal(target)
      return { action: 'deny' }
    })

    void wc.loadURL(url).catch((err: NodeJS.ErrnoException) => {
      // ERR_ABORTED (-3) is almost always a benign superseded navigation — the
      // page itself redirected (e.g. youtube.com → www.youtube.com/?themeRefresh),
      // which aborts the original load while the new one proceeds. Don't treat it
      // as a failure; only log real load errors.
      if (err?.code === 'ERR_ABORTED' || err?.errno === -3) return
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
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward()
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
      if (!e || !isMiniSite(e.url)) return
      void wc.executeJavaScript(MP_INJECT_SCRIPT).catch(() => {
        /* page may navigate away mid-inject — harmless */
      })
    })

    // One-way page→main channel: the injected reporter emits a sentinel line over
    // console.log; parse it into MiniPlayerMeta and forward to the active player.
    wc.on('console-message', (_e, _level, message) => {
      if (typeof message !== 'string') return
      // TEMP DIAGNOSTIC: persist analyser state lines to a log file.
      if (message.startsWith('DECKS_DBG::')) {
        try {
          appendFileSync(
            join(app.getPath('temp'), 'decks-mp-debug.log'),
            `${new Date().toISOString()} mini=${this.miniPanelId} p=${panelId} ${message.slice(11)}\n`
          )
        } catch {
          /* ignore */
        }
        return
      }
      // Live audio levels for the visualizer (high-frequency, separate channel).
      if (message.startsWith(EQ_SENTINEL)) {
        this.eqDbgCount = (this.eqDbgCount ?? 0) + 1
        if (this.eqDbgCount % 40 === 1) {
          try {
            appendFileSync(
              join(app.getPath('temp'), 'decks-mp-debug.log'),
              `${new Date().toISOString()} EQ recv n=${this.eqDbgCount} match=${this.miniPanelId === panelId} hook=${!!this.miniHooks} body=${message.slice(EQ_SENTINEL.length, EQ_SENTINEL.length + 60)}\n`
            )
          } catch {
            /* ignore */
          }
        }
        if (this.miniPanelId !== panelId) return
        try {
          const levels = JSON.parse(message.slice(EQ_SENTINEL.length)) as number[]
          if (Array.isArray(levels)) this.miniHooks?.onLevels(levels)
        } catch {
          /* malformed — ignore */
        }
        return
      }
      if (!message.startsWith(MP_SENTINEL)) return
      try {
        const data = JSON.parse(message.slice(MP_SENTINEL.length)) as {
          title?: string
          artist?: string
          artwork?: string
          paused?: boolean
          loop?: boolean
          currentTime?: number
          duration?: number
          adShowing?: boolean
        }
        const meta: MiniPlayerMeta = {
          title: data.title || '',
          artist: data.artist || '',
          artwork: data.artwork || undefined,
          paused: !!data.paused,
          loop: !!data.loop,
          currentTime: Number.isFinite(data.currentTime) ? data.currentTime : 0,
          duration: Number.isFinite(data.duration) ? data.duration : 0,
          adShowing: !!data.adShowing
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
    this.keepAlive.delete(panelId)
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

  /** Reload every live deck web view (used by the dev auto-refresh so decks pick
   *  up the latest after a code update without closing the app). */
  reloadAll(): void {
    for (const entry of this.panels.values()) {
      try {
        if (!entry.view.webContents.isDestroyed()) entry.view.webContents.reload()
      } catch {
        /* destroyed mid-iterate — ignore */
      }
    }
  }

  /**
   * Sign in to a web deck via a REAL top-level browser window (not the embedded
   * WebContentsView). Google blocks OAuth performed inside an embedded frame
   * ("this browser may not be secure"), so we open the deck's site in a standalone
   * BrowserWindow that SHARES the deck's session partition. The user completes
   * Google login there (a normal top-level context Google accepts); the cookies
   * land in the shared partition. When the window returns to the deck's own origin
   * (off accounts.google.com) we close it and reload the deck — now authenticated,
   * and the persisted partition keeps it logged in across restarts.
   */
  /**
   * Open an OAuth/login popup that a deck requested via window.open, in our OWN
   * top-level window that shares the deck's partition. Crucially the Chrome UA +
   * client-hint metadata override is applied BEFORE `loadURL`, so the provider's
   * very first request AND first script see real Chrome (the embedded-popup path
   * couldn't guarantee that). Nested popups (Google sometimes chains one) inherit
   * the same treatment.
   */
  private openAuthPopup(target: string, partition: string): void {
    const win = new BrowserWindow({
      width: 520,
      height: 680,
      title: 'Sign in',
      autoHideMenuBar: true,
      backgroundColor: '#0e0e13',
      webPreferences: { partition, contextIsolation: true, sandbox: true }
    })
    win.webContents.setUserAgent(CHROME_UA)
    this.applyUaOverride(win.webContents)
    this.patchSessionUa(win.webContents.session, partition)
    win.webContents.setWindowOpenHandler(({ url: nested }) => {
      if (nested && /^https?:\/\//i.test(nested)) {
        this.openAuthPopup(nested, partition)
      } else if (nested) {
        void shell.openExternal(nested)
      }
      return { action: 'deny' }
    })
    void win.loadURL(target)
  }

  /**
   * Pop a web deck out into its own standalone, resizable BrowserWindow (the user
   * dragged the deck out of the app). It SHARES the deck's session partition, so
   * the new window is already logged-in, and presents as Chrome so embedded sites
   * behave. This is a fresh top-level window — independent of the main app.
   */
  tearOff(payload: PanelTearOffPayload): void {
    const { url, partition, title } = payload
    if (!url || !/^https?:\/\//i.test(url)) return
    const win = new BrowserWindow({
      width: 1100,
      height: 800,
      title: title || 'Decks',
      autoHideMenuBar: true,
      backgroundColor: '#14161b',
      webPreferences: { partition, contextIsolation: true, sandbox: true }
    })
    win.webContents.setUserAgent(CHROME_UA)
    this.applyUaOverride(win.webContents)
    this.patchSessionUa(win.webContents.session, partition)
    // Auth popups from the torn-off deck get the same Chrome treatment.
    win.webContents.setWindowOpenHandler(({ url: target }) => {
      if (target && /^https?:\/\//i.test(target)) this.openAuthPopup(target, partition)
      else if (target) void shell.openExternal(target)
      return { action: 'deny' }
    })
    void win.loadURL(url)
  }

  openSignIn(panelId: PanelId): void {
    const entry = this.ensureLive(panelId)
    if (!entry) return
    const partition = entry.partition
    const url = entry.url
    let host = ''
    try {
      host = new URL(url).host
    } catch {
      /* leave host empty — only auto-close on Google→app transitions then */
    }

    const win = new BrowserWindow({
      width: 520,
      height: 700,
      title: 'Sign in',
      autoHideMenuBar: true,
      backgroundColor: '#0e0e13',
      webPreferences: { partition, contextIsolation: true, sandbox: true }
    })
    // Present as real Chrome (string + client-hint metadata) so Google's
    // embedded-browser detection is satisfied for this top-level window too.
    win.webContents.setUserAgent(CHROME_UA)
    this.applyUaOverride(win.webContents)

    let sawAuth = false
    const onNav = (navUrl: string): void => {
      try {
        const h = new URL(navUrl).host
        const isGoogleAuth = /(^|\.)google\.com$/.test(h) || /accounts\.google\./.test(navUrl)
        if (isGoogleAuth) {
          sawAuth = true
        } else if (sawAuth && host && h === host) {
          // Returned to the deck's site after Google → login finished.
          if (!win.isDestroyed()) win.close()
        }
      } catch {
        /* ignore non-URL navigations */
      }
    }
    win.webContents.on('did-navigate', (_e, u) => onNav(u))
    win.webContents.on('did-navigate-in-page', (_e, u) => onNav(u))
    // Popups inside the login window (Google sometimes opens one) stay top-level
    // and share the partition + Chrome UA.
    win.webContents.setWindowOpenHandler(() => ({
      action: 'allow',
      overrideBrowserWindowOptions: {
        webPreferences: { partition, contextIsolation: true, sandbox: true },
        autoHideMenuBar: true,
        width: 520,
        height: 640
      }
    }))
    win.webContents.on('did-create-window', (child) => {
      child.webContents.setUserAgent(CHROME_UA)
      this.applyUaOverride(child.webContents)
    })
    // Whenever the window closes (auto on success, or the user closes it), reload
    // the deck so it picks up the now-shared authenticated session.
    win.on('closed', () => {
      const e = this.panels.get(panelId)
      if (e && !e.view.webContents.isDestroyed()) e.view.webContents.reload()
    })
    void win.loadURL(url)
  }

  goBack(panelId: PanelId): void {
    const wc = this.panels.get(panelId)?.view.webContents
    if (wc && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
  }

  goForward(panelId: PanelId): void {
    const wc = this.panels.get(panelId)?.view.webContents
    if (wc && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
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

    // Detach everything not in the show set. A mini-player deck just stays hidden
    // here — it keeps playing audio while the floating bar shows its controls; we
    // never show the actual video.
    for (const [id, entry] of this.panels) {
      if (show.has(id)) continue
      this.detach(entry)
      if (entry.hiddenSince == null) entry.hiddenSince = now
    }

    // Attach + position the requested panels (z-order = array order). Recreate any
    // discarded ones.
    for (const id of payload.panelIds) {
      const entry = this.ensureLive(id)
      if (!entry) continue
      const b = payload.bounds[id]
      this.attach(entry)
      entry.lastActiveAt = now
      entry.hiddenSince = null
      if (b) entry.view.setBounds(this.toIntBounds(b))
    }

    this.refreshMini(show)
  }

  /**
   * Keep / pick / refresh the corner mini-player BAR. The bar shows now-playing
   * controls for an audible YouTube deck you've switched away from (the deck
   * itself stays hidden — audio keeps playing). An active mini stays until you
   * RETURN to that deck (it enters `show`) or its view is gone; audible state only
   * PICKS a new mini, it never ends one.
   */
  private refreshMini(show: Set<PanelId>): void {
    let mini = this.miniPanelId
    if (mini && (show.has(mini) || !this.panels.has(mini))) {
      this.endMiniPlayer()
      mini = null
    }
    if (!mini) mini = this.pickMiniCandidate(show)
    if (mini) this.activateMini(mini)
  }

  /**
   * Pick the panel that should become the mini-player: the first audio-site view
   * (YouTube/Spotify) that is currently audible and NOT in the `show` set (the
   * user is switching away from it while it plays). Returns null if none qualify.
   */
  private pickMiniCandidate(show: Set<PanelId>): PanelId | null {
    for (const [id, entry] of this.panels) {
      if (show.has(id)) continue
      if (!this.isAudiblePanel(entry)) continue
      return id
    }
    return null
  }

  /** True if this panel is an audio site (YouTube/Spotify) currently audible. */
  private isAudiblePanel(entry: PanelEntry): boolean {
    if (!isMiniSite(entry.url)) return false
    try {
      if (entry.view.webContents.isDestroyed()) return false
      return entry.view.webContents.isCurrentlyAudible()
    } catch {
      return false
    }
  }

  /** First audible audio-site panel REGARDLESS of show-set (used on minimize). */
  private pickAudibleAny(): PanelId | null {
    for (const [id, entry] of this.panels) {
      if (this.isAudiblePanel(entry)) return id
    }
    return null
  }

  /**
   * The app window was minimized: if music is playing in a YouTube/Spotify deck,
   * pop the floating mini-player (which lives in a separate always-on-top window)
   * so the user can keep controlling it while Decks is out of the way.
   */
  onWindowMinimized(): void {
    if (this.miniPanelId) return // a switched-away mini is already showing
    const cand = this.pickAudibleAny()
    if (cand) {
      this.miniByMinimize = true
      this.activateMini(cand)
    }
  }

  /** The app window was restored/shown: tear down a minimize-triggered mini. */
  onWindowRestored(): void {
    if (!this.miniByMinimize) return
    this.miniByMinimize = false
    this.endMiniPlayer()
  }

  /**
   * Make a panel the mini-player and (re)draw the floating overlay control bar.
   * The deck's view is NOT shown — it stays hidden and keeps playing audio; only
   * the bar (artwork + title + poster + controls) is drawn. Idempotent: called on
   * every showOnly/hideAll to keep the bar pinned + positioned.
   */
  private activateMini(panelId: PanelId): void {
    const entry = this.panels.get(panelId)
    if (!entry) return
    const wasActive = this.miniPanelId === panelId
    this.miniPanelId = panelId
    const meta = entry.meta ?? { title: '', artist: '', paused: false }
    this.miniHooks?.onStart(this.barRect(), meta, this.miniCollapsed, this.miniArrowEdge())
    // When a deck first becomes the mini-player, kick the visualizer WITH a user
    // gesture (2nd arg) so its AudioContext can resume even if the video
    // autoplayed without a page gesture — otherwise the analyser stays silent and
    // the bars fall back to the canned animation.
    if (!wasActive) this.kickVisualizer(panelId)
  }

  /** Resume + (re)connect the in-page analyser, executed AS a user gesture so a
   *  suspended AudioContext (autoplay with no page gesture) can actually resume. */
  private kickVisualizer(panelId: PanelId): void {
    const entry = this.panels.get(panelId)
    if (!entry) return
    const wc = entry.view.webContents
    if (wc.isDestroyed()) return
    void wc
      .executeJavaScript(
        '(()=>{if(window.__decksMPRefresh){window.__decksMPRefresh();return true}return false})()',
        true // userGesture → lets AudioContext.resume() succeed
      )
      .catch(() => {})
  }

  /** Which screen edge the collapsed tab sits on → the arrow points inward. */
  private miniArrowEdge(): 'left' | 'right' {
    const area = this.currentDisplay().workArea
    const x = this.miniPos?.x ?? area.x + area.width
    return x + TAB_W / 2 < area.x + area.width / 2 ? 'left' : 'right'
  }

  /** Collapse the mini-player into its slim side tab, snapped to the nearer edge. */
  miniCollapse(): void {
    if (!this.miniPanelId || this.miniCollapsed) return
    const area = this.currentDisplay().workArea
    const r = this.barRect() // current expanded card rect
    const onLeft = r.x + r.width / 2 < area.x + area.width / 2
    this.miniPos = {
      x: onLeft ? area.x : area.x + Math.max(0, area.width - TAB_W),
      y: Math.min(Math.max(r.y, area.y), area.y + Math.max(0, area.height - TAB_H))
    }
    this.miniCollapsed = true
    this.activateMini(this.miniPanelId)
  }

  /** Expand the collapsed tab back into the full mini-player card. */
  miniExpand(): void {
    if (!this.miniPanelId || !this.miniCollapsed) return
    this.miniCollapsed = false
    this.activateMini(this.miniPanelId)
  }

  /** The display the mini-player lives on — the one the app window is on (its
   *  normal bounds when minimized), falling back to the primary display. */
  private currentDisplay(): Display {
    try {
      const w = this.window
      if (w && !w.isDestroyed()) {
        const b = w.isMinimized() ? w.getNormalBounds() : w.getBounds()
        return screen.getDisplayMatching(b)
      }
    } catch {
      /* fall through to primary */
    }
    return screen.getPrimaryDisplay()
  }

  /**
   * The floating card's rectangle in SCREEN coordinates. Defaults to the
   * TOP-RIGHT of the current display's work area; once the user has dragged it,
   * uses the remembered `miniPos` (screen coords), clamped so the whole card
   * stays on the display but can reach every edge — independent of the app
   * window's position or size, so it works even while Decks is minimized.
   */
  private barRect(): PanelBounds {
    const w = this.miniCollapsed ? TAB_W : CARD_WIDTH
    const h = this.miniCollapsed ? TAB_H : CARD_HEIGHT
    // Not yet dragged → default to the TOP-RIGHT of the app's current display.
    if (!this.miniPos) {
      const area = this.currentDisplay().workArea
      const x = area.x + Math.max(0, area.width - w - BAR_MARGIN)
      const y = area.y + BAR_MARGIN
      return this.toIntBounds({ x, y, width: w, height: h })
    }
    // Dragged → clamp to whichever display the card's CENTER currently sits over
    // (MULTI-MONITOR aware), so it can be dragged freely onto any connected
    // screen instead of being trapped on the app window's display.
    const center = { x: Math.round(this.miniPos.x + w / 2), y: Math.round(this.miniPos.y + h / 2) }
    const area = screen.getDisplayNearestPoint(center).workArea
    const x = Math.min(Math.max(this.miniPos.x, area.x), area.x + Math.max(0, area.width - w))
    const y = Math.min(Math.max(this.miniPos.y, area.y), area.y + Math.max(0, area.height - h))
    return this.toIntBounds({ x, y, width: w, height: h })
  }

  /** Begin a drag: snapshot the bar's current top-left as the delta anchor. */
  miniMoveStart(): void {
    const r = this.barRect()
    this.miniDragAnchor = { x: r.x, y: r.y }
  }

  /** Move the bar by a screen-pixel delta from the drag anchor (fixed size). */
  miniMove(dx: number, dy: number): void {
    if (!this.miniPanelId) return
    const anchor = this.miniDragAnchor ?? { x: this.barRect().x, y: this.barRect().y }
    this.miniPos = { x: anchor.x + dx, y: anchor.y + dy }
    const entry = this.panels.get(this.miniPanelId)
    const meta = entry?.meta ?? { title: '', artist: '', paused: false }
    this.miniHooks?.onStart(this.barRect(), meta, this.miniCollapsed, this.miniArrowEdge())
  }

  /** End a drag. */
  miniMoveEnd(): void {
    this.miniDragAnchor = null
  }

  /**
   * Clear the mini-player and hide the bar. The deck's view stays hidden (it's
   * detached/attached by the normal showOnly flow). Safe when none is active.
   */
  private endMiniPlayer(): void {
    if (!this.miniPanelId) return
    this.miniPanelId = null
    this.miniCollapsed = false // next pop starts as the full card
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

  /** Resume playback in the corner media. STABLE (web-standard HTMLMediaElement). */
  miniPlay(): void {
    void this.miniWc()
      ?.executeJavaScript("(document.querySelector('video')||document.querySelector('audio'))?.play()")
      .catch(() => {})
  }

  /** Pause the corner media. STABLE (web-standard HTMLMediaElement). */
  miniPause(): void {
    void this.miniWc()
      ?.executeJavaScript("(document.querySelector('video')||document.querySelector('audio'))?.pause()")
      .catch(() => {})
  }

  /** Toggle loop on the current media. STABLE (web-standard HTMLMediaElement). */
  miniToggleLoop(): void {
    const wc = this.miniWc()
    if (!wc) return
    void wc
      .executeJavaScript(
        "(()=>{var v=document.querySelector('video')||document.querySelector('audio');if(v){v.loop=!v.loop;return v.loop;}return false;})()"
      )
      .then((looped: unknown) => {
        const e = this.miniPanelId ? this.panels.get(this.miniPanelId) : null
        if (e?.meta) {
          e.meta = { ...e.meta, loop: !!looped }
          this.miniHooks?.onUpdate(e.meta)
        }
      })
      .catch(() => {})
  }

  /** Refresh the corner PANEL's now-playing + visualizer in place — re-arms the
   *  reporter/analyzer WITHOUT reloading the page (so the song doesn't restart),
   *  clearing a stuck/“bugged” equalizer. Falls back to a full reload only if the
   *  in-page hook isn't present. */
  miniReload(): void {
    const wc = this.miniWc()
    if (!wc) return
    void wc
      .executeJavaScript(
        '(()=>{if(window.__decksMPRefresh){window.__decksMPRefresh();return true}return false})()',
        true // userGesture → lets a suspended AudioContext resume
      )
      .then((ok) => {
        if (!ok) wc.reload()
      })
      .catch(() => {})
  }

  /** Seek the corner media. STABLE (web-standard HTMLMediaElement). */
  miniSeek(time: number): void {
    const t = Number.isFinite(time) ? Math.max(0, time) : 0
    void this.miniWc()
      ?.executeJavaScript(
        `(()=>{var v=document.querySelector('video')||document.querySelector('audio');if(v)v.currentTime=${t};})()`
      )
      .catch(() => {})
  }

  /**
   * Play another song/video from the mini-player's search box. To keep the
   * user's YouTube SEARCH HISTORY from being flooded, we DON'T run the query in
   * the logged-in deck. Instead we resolve it to a video id with a COOKIELESS
   * request from the main process (not attributed to the account → no search
   * entry), then load the watch URL directly in the deck so it plays in place.
   * (Playing the video still appears in watch history, as expected.) If the
   * cookieless resolve fails, we fall back to navigating the deck to the results
   * page and clicking the first result. ⚠️ Both the id-scrape and the result
   * click depend on YouTube's markup, so they're best-effort.
   */
  miniSearch(query: string): void {
    const wc = this.miniWc()
    if (!wc) return
    const q = (query || '').trim()
    if (!q) return
    void this.resolveYouTubeVideoId(q)
      .then((videoId) => {
        const live = this.miniWc()
        if (!live) return
        if (videoId) {
          void live.loadURL(`https://www.youtube.com/watch?v=${videoId}`).catch(() => {})
          return
        }
        // Fallback: search in the deck and click the first result.
        const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`
        void live
          .loadURL(url)
          .then(() => {
            const click = `(()=>{var n=0;var t=setInterval(function(){
              var a=document.querySelector('ytd-video-renderer a#thumbnail, ytd-video-renderer a#video-title, a#video-title');
              if(a){clearInterval(t);a.click();}
              if(++n>40)clearInterval(t);
            },250);})()`
            return live.executeJavaScript(click)
          })
          .catch(() => {})
      })
      .catch(() => {})
  }

  /**
   * Resolve a search query to the top YouTube video id WITHOUT the user's
   * cookies (main-process `fetch` has no session cookie jar), so the search is
   * not recorded to their account. Returns null on any failure.
   */
  private async resolveYouTubeVideoId(query: string): Promise<string | null> {
    try {
      const res = await fetch(
        `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
        { headers: { 'User-Agent': CHROME_UA, 'Accept-Language': 'en-US,en;q=0.9' } }
      )
      const html = await res.text()
      const m = html.match(/"videoId":"([\w-]{11})"/)
      return m ? m[1] : null
    } catch {
      return null
    }
  }

  /**
   * Click a transport button in the page (Spotify), returning whether one was
   * found. More reliable than keyboard shortcuts (which need the player focused).
   * ⚠️ FRAGILE: depends on the site's button selectors. (YouTube next/prev is
   * handled by `youTubeNext`/`miniPrevious`, which follow YouTube's OWN autoplay
   * up-next queue rather than a player button that's disabled off-playlist.)
   */
  private clickTransport(dir: 'next' | 'prev'): Promise<boolean> {
    const wc = this.miniWc()
    if (!wc) return Promise.resolve(false)
    const sel =
      dir === 'next'
        ? ['[data-testid="control-button-skip-forward"]', 'button[aria-label*="Next" i]']
        : ['[data-testid="control-button-skip-back"]', 'button[aria-label*="Previous" i]']
    const js = `(()=>{var s=${JSON.stringify(sel)};for(var i=0;i<s.length;i++){var b=document.querySelector(s[i]);if(b){b.click();return true;}}return false;})()`
    return wc.executeJavaScript(js).catch(() => false) as Promise<boolean>
  }

  /**
   * Advance YouTube using its OWN autoplay / up-next queue (the "mix" it builds
   * from related videos after a search), NOT a fresh search. Order of attempts,
   * each tried in-page so it follows whatever YouTube actually exposes:
   *   1. Click the player's Next button when it's ENABLED — on a watch page this
   *      is wired to YouTube's autoplay up-next (the related mix).
   *   2. Otherwise navigate to the up-next video YouTube advertises: the autoplay
   *      endpoint / "Up next" entry, then the first related/recommended video.
   * Returns whether it advanced. Driving the watch page like this means even a
   * single video opened with no playlist context flows into YouTube's related mix.
   */
  private youTubeNext(): Promise<boolean> {
    const wc = this.miniWc()
    if (!wc) return Promise.resolve(false)
    const js = `(() => {
      // 1) Player Next button, but only if YouTube has ENABLED it (it disables
      //    the button when there's genuinely nowhere to go).
      var nb = document.querySelector('.ytp-next-button');
      if (nb && nb.getAttribute('aria-disabled') !== 'true' && !nb.classList.contains('ytp-button-disabled')) {
        var href = nb.getAttribute('href');
        if (href) { location.href = href; return true; }
        nb.click();
        return true;
      }
      // 2) Navigate to the up-next video YouTube exposes in the sidebar. Prefer
      //    the explicit autoplay/"Up next" renderer, then the first related video.
      var sels = [
        'ytd-compact-autoplay-renderer a#thumbnail',
        'ytd-compact-autoplay-renderer a.yt-simple-endpoint',
        'ytd-watch-next-secondary-results-renderer ytd-compact-video-renderer a#thumbnail',
        '#related ytd-compact-video-renderer a#thumbnail',
        'ytd-compact-video-renderer a#thumbnail'
      ];
      for (var i = 0; i < sels.length; i++) {
        var a = document.querySelector(sels[i]);
        if (a && a.href && /[?&]v=/.test(a.href)) { location.href = a.href; return true; }
      }
      return false;
    })()`
    return wc.executeJavaScript(js).catch(() => false) as Promise<boolean>
  }

  /** Skip to the next track. YouTube follows its OWN autoplay up-next queue (the
   *  related mix it builds after a search); Spotify uses its transport button.
   *  Falls back to YouTube's Shift+N shortcut only if neither path advanced. */
  miniNext(): void {
    const entry = this.miniPanelId ? this.panels.get(this.miniPanelId) : null
    if (entry && isYouTube(entry.url)) {
      void this.youTubeNext().then((ok) => {
        if (ok) return
        // Last resort: the keyboard shortcut (needs the player focused).
        const wc = this.miniWc()
        if (!wc) return
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'N', modifiers: ['shift'] })
        wc.sendInputEvent({ type: 'char', keyCode: 'N', modifiers: ['shift'] })
        wc.sendInputEvent({ type: 'keyUp', keyCode: 'N', modifiers: ['shift'] })
      })
      return
    }
    // Non-YouTube (Spotify): use its transport button.
    void this.clickTransport('next')
  }

  /** "Back": like a normal media player — if we're more than 3s in, restart the
   *  current track. Otherwise go to the PREVIOUS song in the same up-next queue:
   *  for YouTube that's the deck's navigation history (each Next navigated us to
   *  the up-next video, so Back is a history goBack); for Spotify it's the Prev
   *  button. Always does something — a standalone video with no history restarts. */
  miniPrevious(): void {
    const wc = this.miniWc()
    if (!wc) return
    const t = this.miniPanelId ? this.panels.get(this.miniPanelId)?.meta?.currentTime ?? 0 : 0
    if (t > 3) {
      this.miniSeek(0)
      return
    }
    const entry = this.miniPanelId ? this.panels.get(this.miniPanelId) : null
    if (entry && isYouTube(entry.url)) {
      // Go back through the queue we built by navigating forward into up-next
      // videos. If there's nowhere back, restart the current track.
      if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
      else this.miniSeek(0)
      return
    }
    void this.clickTransport('prev').then((ok) => {
      if (ok) return
      // No previous available → restart the current track.
      this.miniSeek(0)
    })
  }

  /** The panelId of the active mini-player (for the close→focus glue), or null. */
  get miniPlayerPanelId(): PanelId | null {
    return this.miniPanelId
  }

  /** Detach/hide every panel so pure-renderer UI is fully visible. */
  hideAll(): void {
    const now = Date.now()
    // Detach everything (a mini-player deck stays hidden but keeps its audio +
    // bar). Without refreshing the mini here, going Home / to a native-only
    // workspace / opening the palette used to silently drop the bar.
    for (const entry of this.panels.values()) {
      this.detach(entry)
      if (entry.hiddenSince == null) entry.hiddenSince = now
    }
    this.refreshMini(new Set())
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
      // Keep-alive panels are pinned by the user — never discard them.
      if (this.keepAlive.has(id)) continue
      // The active mini-player's deck must stay alive (its bar drives it).
      if (id === this.miniPanelId) continue
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
