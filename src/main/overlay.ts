/**
 * Decks — floating hover-card overlay window.
 *
 * The app embeds live pages as native WebContentsViews that draw ON TOP of the
 * renderer DOM, so a normal DOM hover card is covered. To float a card above
 * EVERYTHING we use a separate, always-on-top, transparent, click-through child
 * window that hosts the renderer in "overlay" mode (`#overlay` hash). It is kept
 * small (only big enough for the card) and positioned at screen coordinates so
 * the empty area stays fully click-through to the main window beneath it.
 */
import { BrowserWindow, screen } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { IPC } from '@shared/ipc'
import type {
  HoverShowPayload,
  MenuShowPayload,
  OverlayRenderEvent,
  OverlayMenuEvent,
  OverlayMiniPlayerEvent,
  MiniPlayerMeta
} from '@shared/ipc'
import type { PanelBounds } from '@shared/types'

/** Overlay window size — just enough to hold the hover card, nothing more. */
const OVERLAY_WIDTH = 300
const OVERLAY_HEIGHT = 200

/** Larger size used while a custom context menu is open. */
const MENU_WIDTH = 240
const MENU_HEIGHT = 320

export interface OverlayController {
  showHover(payload: HoverShowPayload): void
  hideHover(): void
  showMenu(payload: MenuShowPayload): void
  hideMenu(): void
  /** Show the mini-player at `rect` (full card, or the collapsed side tab). */
  showMiniPlayer(
    rect: PanelBounds,
    meta: MiniPlayerMeta,
    collapsed: boolean,
    edge: 'left' | 'right'
  ): void
  /** Update the now-playing metadata on an already-visible mini-player bar. */
  updateMiniPlayer(meta: MiniPlayerMeta): void
  /** Push live audio levels (0..1 per bar) to the visualizer. */
  updateMiniLevels(levels: number[]): void
  /** Hide the mini-player control bar. */
  hideMiniPlayer(): void
  destroy(): void
}

export function createOverlay(parent: BrowserWindow): OverlayController {
  // NOT a child of the main window: a child window pulls its owner to the front
  // when clicked and can hide when the owner isn't focused. A top-level
  // always-on-top window lets the mini-player bar float above OTHER apps and be
  // clicked from the background WITHOUT raising Decks. (Hover cards + menus only
  // ever show while the app is in use, so this is safe for them too.)
  const win = new BrowserWindow({
    width: OVERLAY_WIDTH,
    height: OVERLAY_HEIGHT,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    // Focusable so the custom context menu can take focus and dismiss on blur.
    // The hover card + mini-player use showInactive() and never steal focus.
    focusable: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false
    }
  })

  // Float above the live web views AND other apps; the transparent area stays
  // click-through. 'screen-saver' keeps the bar usable over fullscreen content.
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.setIgnoreMouseEvents(true)

  // Load the renderer in OVERLAY mode (hash-routed to <OverlayApp/>).
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#overlay`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'overlay' })
  }

  /** True while the window is alive and safe to talk to. */
  const alive = (): boolean => !win.isDestroyed()

  /**
   * Single-window mode machine. The overlay window is shared by the hover card,
   * the context menu, and the mini-player bar, so only one can own it at a time.
   * Priority: menu > miniplayer > hover. The mini-player is the RESTING mode
   * (stays up while a corner video plays); a menu temporarily takes the window
   * and restores the mini-player bar when it closes.
   */
  type Mode = 'hidden' | 'hover' | 'menu' | 'miniplayer'
  let mode: Mode = 'hidden'

  /** Remembered mini-player state so we can re-show the bar after a menu closes. */
  let miniRect: PanelBounds | null = null
  let miniMeta: MiniPlayerMeta | null = null
  let miniCollapsed = false
  let miniEdge: 'left' | 'right' = 'right'

  const send = (event: OverlayRenderEvent): void => {
    if (!alive()) return
    win.webContents.send(IPC.OverlayRender, event)
  }

  const sendMenu = (event: OverlayMenuEvent): void => {
    if (!alive()) return
    win.webContents.send(IPC.OverlayMenu, event)
  }

  const sendMini = (event: OverlayMiniPlayerEvent): void => {
    if (!alive()) return
    win.webContents.send(IPC.OverlayMiniPlayer, event)
  }

  /**
   * Position+size the window to the mini-player CARD rect. `miniRect` is already
   * in absolute SCREEN coordinates (main computes it against the display work
   * area — top-right by default, or wherever the user dragged it), so it floats
   * anywhere on screen and stays put even when the app window is minimized. Set
   * the window bounds exactly. Interactive but never steals focus.
   */
  const showMiniBar = (): void => {
    if (!alive() || !miniRect || !miniMeta) return
    win.setBounds({
      x: Math.round(miniRect.x),
      y: Math.round(miniRect.y),
      width: miniRect.width,
      height: miniRect.height
    })
    sendMini({ show: true, meta: miniMeta, collapsed: miniCollapsed, edge: miniEdge })
    win.setIgnoreMouseEvents(false)
    win.showInactive()
  }

  /** Tear the menu down and restore whatever resting mode should own the window. */
  const closeMenu = (): void => {
    if (!alive()) return
    sendMenu({ kind: 'workspace', targetId: '', hasNotes: false, hide: true })
    win.setSize(OVERLAY_WIDTH, OVERLAY_HEIGHT)
    // Restore the mini-player bar if one is active; otherwise go hidden.
    if (miniRect && miniMeta) {
      mode = 'miniplayer'
      showMiniBar()
    } else {
      mode = 'hidden'
      win.setIgnoreMouseEvents(true)
      win.hide()
    }
  }

  // Dismiss the menu when the overlay loses focus (click elsewhere, alt-tab…).
  win.on('blur', () => {
    if (mode === 'menu') closeMenu()
  })

  return {
    showHover(payload: HoverShowPayload): void {
      if (!alive() || parent.isDestroyed()) return
      // Menu and mini-player both outrank the hover card — suppress it then.
      if (mode === 'menu' || mode === 'miniplayer') return

      // p.x/p.y are MAIN-WINDOW-relative pixels. Convert to absolute screen
      // coordinates by offsetting from the parent's content origin, then clamp
      // the whole card to stay within the parent's visible content area.
      const content = parent.getContentBounds()
      const maxX = content.x + Math.max(0, content.width - OVERLAY_WIDTH)
      const maxY = content.y + Math.max(0, content.height - OVERLAY_HEIGHT)
      const screenX = Math.round(Math.min(Math.max(content.x + payload.x, content.x), maxX))
      const screenY = Math.round(Math.min(Math.max(content.y + payload.y, content.y), maxY))

      win.setSize(OVERLAY_WIDTH, OVERLAY_HEIGHT)
      win.setIgnoreMouseEvents(true)
      win.setPosition(screenX, screenY)
      send({ show: true, summary: payload.summary })
      mode = 'hover'
      // showInactive: become visible but NEVER steal focus from the main window.
      win.showInactive()
    },

    hideHover(): void {
      if (!alive()) return
      // Only the hover card may be hidden this way; menu/mini-player own the window.
      if (mode !== 'hover') return
      send({ show: false })
      mode = 'hidden'
      win.hide()
    },

    showMenu(payload: MenuShowPayload): void {
      if (!alive() || parent.isDestroyed()) return

      // Stop showing the hover card / mini-player bar; the window now hosts the
      // menu. The mini-player rect/meta are REMEMBERED so closeMenu can restore it.
      send({ show: false })
      sendMini({ show: false })

      // Grow the window so the menu fits, then position it at the cursor in
      // screen coords (parent content origin + window-relative x/y), clamped to
      // the work area of the display under the cursor.
      win.setSize(MENU_WIDTH, MENU_HEIGHT)
      const content = parent.getContentBounds()
      const rawX = content.x + payload.x
      const rawY = content.y + payload.y
      const area = screen.getDisplayNearestPoint({ x: rawX, y: rawY }).workArea
      const maxX = area.x + Math.max(0, area.width - MENU_WIDTH)
      const maxY = area.y + Math.max(0, area.height - MENU_HEIGHT)
      const screenX = Math.round(Math.min(Math.max(rawX, area.x), maxX))
      const screenY = Math.round(Math.min(Math.max(rawY, area.y), maxY))
      win.setPosition(screenX, screenY)

      mode = 'menu'
      win.setIgnoreMouseEvents(false)
      sendMenu({
        kind: payload.kind,
        targetId: payload.targetId,
        hasNotes: !!payload.hasNotes,
        keepAlive: !!payload.keepAlive,
        pinned: !!payload.pinned
      })
      win.show()
      win.focus()
    },

    hideMenu(): void {
      if (mode !== 'menu') return
      closeMenu()
    },

    showMiniPlayer(
      rect: PanelBounds,
      meta: MiniPlayerMeta,
      collapsed: boolean,
      edge: 'left' | 'right'
    ): void {
      if (!alive()) return
      miniRect = rect
      miniMeta = meta
      miniCollapsed = collapsed
      miniEdge = edge
      // A menu outranks the mini-player: remember state, let the menu finish; the
      // bar reappears on closeMenu. Otherwise take the window now.
      if (mode === 'menu') return
      mode = 'miniplayer'
      showMiniBar()
    },

    updateMiniPlayer(meta: MiniPlayerMeta): void {
      if (!alive()) return
      miniMeta = meta
      // Only push to the visible bar; if a menu is up the new meta is applied
      // when the bar is restored.
      if (mode === 'miniplayer')
        sendMini({ show: true, meta, collapsed: miniCollapsed, edge: miniEdge })
    },

    updateMiniLevels(levels: number[]): void {
      if (!alive() || mode !== 'miniplayer') return
      win.webContents.send(IPC.OverlayMiniLevels, levels)
    },

    hideMiniPlayer(): void {
      if (!alive()) return
      miniRect = null
      miniMeta = null
      sendMini({ show: false })
      // If the bar currently owns the window, drop to hidden. If a menu is up,
      // leave it alone — closeMenu will now go hidden since mini state is cleared.
      if (mode === 'miniplayer') {
        mode = 'hidden'
        win.setIgnoreMouseEvents(true)
        win.hide()
      }
    },

    destroy(): void {
      if (!alive()) return
      // Must never appear during cleanup/quit — close it outright.
      win.destroy()
    }
  }
}
