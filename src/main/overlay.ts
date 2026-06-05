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
  OverlayMenuEvent
} from '@shared/ipc'

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
  destroy(): void
}

export function createOverlay(parent: BrowserWindow): OverlayController {
  const win = new BrowserWindow({
    parent,
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
    // The hover card still uses showInactive() and never steals focus.
    focusable: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false
    }
  })

  // Float above the live web views and let every click/hover pass THROUGH the
  // transparent area to the main window underneath.
  win.setAlwaysOnTop(true, 'pop-up-menu')
  win.setIgnoreMouseEvents(true)

  // Load the renderer in OVERLAY mode (hash-routed to <OverlayApp/>).
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#overlay`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'overlay' })
  }

  /** True while the window is alive and safe to talk to. */
  const alive = (): boolean => !win.isDestroyed()

  /** True while a custom context menu is open (window is interactive). */
  let menuOpen = false

  const send = (event: OverlayRenderEvent): void => {
    if (!alive()) return
    win.webContents.send(IPC.OverlayRender, event)
  }

  const sendMenu = (event: OverlayMenuEvent): void => {
    if (!alive()) return
    win.webContents.send(IPC.OverlayMenu, event)
  }

  /** Tear the menu down: go back to small, click-through, hidden state. */
  const closeMenu = (): void => {
    if (!alive()) return
    menuOpen = false
    sendMenu({ kind: 'workspace', targetId: '', hasNotes: false, hide: true })
    win.setIgnoreMouseEvents(true)
    win.hide()
    // Restore the small hover size for the next hover.
    win.setSize(OVERLAY_WIDTH, OVERLAY_HEIGHT)
  }

  // Dismiss the menu when the overlay loses focus (click elsewhere, alt-tab…).
  win.on('blur', () => {
    if (menuOpen) closeMenu()
  })

  return {
    showHover(payload: HoverShowPayload): void {
      if (!alive() || parent.isDestroyed()) return

      // p.x/p.y are MAIN-WINDOW-relative pixels. Convert to absolute screen
      // coordinates by offsetting from the parent's content origin, then clamp
      // the whole card to stay within the parent's visible content area.
      const content = parent.getContentBounds()
      const maxX = content.x + Math.max(0, content.width - OVERLAY_WIDTH)
      const maxY = content.y + Math.max(0, content.height - OVERLAY_HEIGHT)
      const screenX = Math.round(Math.min(Math.max(content.x + payload.x, content.x), maxX))
      const screenY = Math.round(Math.min(Math.max(content.y + payload.y, content.y), maxY))

      win.setPosition(screenX, screenY)
      send({ show: true, summary: payload.summary })
      // showInactive: become visible but NEVER steal focus from the main window.
      win.showInactive()
    },

    hideHover(): void {
      if (!alive()) return
      // A menu owns the window while open — don't let a stray hover-hide kill it.
      if (menuOpen) return
      send({ show: false })
      win.hide()
    },

    showMenu(payload: MenuShowPayload): void {
      if (!alive() || parent.isDestroyed()) return

      // Stop showing the hover card; the window now hosts the menu.
      send({ show: false })

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

      menuOpen = true
      win.setIgnoreMouseEvents(false)
      sendMenu({
        kind: payload.kind,
        targetId: payload.targetId,
        hasNotes: !!payload.hasNotes
      })
      win.show()
      win.focus()
    },

    hideMenu(): void {
      closeMenu()
    },

    destroy(): void {
      if (!alive()) return
      // Must never appear during cleanup/quit — close it outright.
      win.destroy()
    }
  }
}
