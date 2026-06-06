/**
 * Decks — main process entry.
 *
 * Owns: the frameless window, native WebContentsView panels (via PanelManager),
 * every IPC handler declared in @shared/ipc, JSON persistence, and the
 * process-lifecycle registry + safe cleanup.
 */
import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import * as electron from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { IPC } from '@shared/ipc'
import type {
  PanelCreatePayload,
  PanelNavigatePayload,
  PanelSetBoundsPayload,
  PanelShowOnlyPayload,
  MetricsResult
} from '@shared/ipc'
import type {
  HoverShowPayload,
  SettingsApplyPayload,
  MenuShowPayload,
  MenuPickPayload,
  MiniPlayerControlEvent,
  FocusPanelEvent
} from '@shared/ipc'
import type { PanelId, PersistedState } from '@shared/types'
import { PanelManager, CHROME_UA } from './panels'
import { loadState, saveState } from './persistence'
import { killTrackedChildren } from './lifecycle'
import { createOverlay, type OverlayController } from './overlay'
import { registerProviderIpc } from './providers/registry'
import { registerAllProviders } from './providers'
import { startCodeServer, stopCodeServer } from './codeserver'
import type { CodeServerResult } from '@shared/ipc'

/**
 * Cap the number of Chromium renderer processes. NOTE this counts ALL renderers,
 * including the app's own main window + the overlay window. When this cap is hit,
 * Chromium SILENTLY refuses to spawn a renderer for a new WebContentsView, so the
 * deck never loads (this caused embedded decks to come up blank / ERR_ABORTED).
 * So the cap must stay well clear of the working set. The real RAM control is the
 * discard manager + PanelManager's own live-panel soft cap (which proactively
 * evicts the least-recently-used HIDDEN deck before creating a new one), so the
 * active deck always gets a renderer. Keep this ceiling generous.
 */
const RENDERER_PROCESS_LIMIT = 64
app.commandLine.appendSwitch('renderer-process-limit', String(RENDERER_PROCESS_LIMIT))

let mainWindow: BrowserWindow | null = null
let overlay: OverlayController | null = null
const panels = new PanelManager()

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 600,
    // Show immediately on the dark background — never depend solely on
    // ready-to-show (a missed event would leave the window hidden forever).
    show: true,
    frame: false,
    backgroundColor: '#0e0e13',
    icon: join(__dirname, '../../build/icon.png'),
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  panels.setWindow(mainWindow)
  overlay = createOverlay(mainWindow)

  // Bridge the corner mini-player (owned by PanelManager) to the overlay window's
  // control bar. PanelManager decides WHEN (corner/teardown); these hooks draw it.
  panels.setMiniPlayerHooks({
    onStart: (rect, meta) => overlay?.showMiniPlayer(rect, meta),
    onUpdate: (meta) => overlay?.updateMiniPlayer(meta),
    onEnd: () => overlay?.hideMiniPlayer()
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // The host renderer page itself never spawns windows; route any externally.
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // Belt-and-suspenders: guarantee the window is visible and focused even if
  // ready-to-show is missed or the renderer is slow to paint.
  mainWindow.show()
  mainWindow.focus()
}

/** Register every IPC handler from the contract. Call once on ready. */
function registerIpc(): void {
  // ── Window controls (renderer → main, send) ──
  ipcMain.on(IPC.WindowMinimize, () => mainWindow?.minimize())
  ipcMain.on(IPC.WindowMaximize, () => {
    if (!mainWindow) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  ipcMain.on(IPC.WindowClose, () => mainWindow?.close())

  // ── Panel lifecycle (renderer → main, invoke) ──
  ipcMain.handle(IPC.PanelCreate, (_e, p: PanelCreatePayload) => {
    panels.create(p)
  })
  ipcMain.handle(IPC.PanelDestroy, (_e, panelId: PanelId) => {
    panels.destroy(panelId)
  })
  ipcMain.handle(IPC.PanelNavigate, (_e, p: PanelNavigatePayload) => {
    panels.navigate(p)
  })
  ipcMain.handle(IPC.PanelReload, (_e, panelId: PanelId) => {
    panels.reload(panelId)
  })
  ipcMain.handle(IPC.PanelGoBack, (_e, panelId: PanelId) => {
    panels.goBack(panelId)
  })
  ipcMain.handle(IPC.PanelGoForward, (_e, panelId: PanelId) => {
    panels.goForward(panelId)
  })
  ipcMain.handle(IPC.PanelSetBounds, (_e, p: PanelSetBoundsPayload) => {
    panels.setBounds(p)
  })
  ipcMain.handle(IPC.PanelShowOnly, (_e, p: PanelShowOnlyPayload) => {
    panels.showOnly(p)
  })
  ipcMain.handle(IPC.PanelHideAll, () => {
    panels.hideAll()
  })
  ipcMain.handle(IPC.PanelSetKeepAlive, (_e, panelId: PanelId, keepAlive: boolean) => {
    panels.setKeepAlive(panelId, keepAlive)
  })

  // ── Native deck providers (renderer → main, invoke) ──
  // Wires provider:connect/fetch/disconnect/status to the provider registry.
  registerProviderIpc()

  // ── code-server (local VS Code in a web deck) — renderer → main (invoke) ──
  ipcMain.handle(IPC.CodeServerStart, async (): Promise<CodeServerResult> => {
    if (!mainWindow) return { error: 'No window' }
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: 'Open folder in code-server',
      properties: ['openDirectory']
    })
    if (picked.canceled || !picked.filePaths[0]) return { cancelled: true }
    try {
      const { url } = await startCodeServer(picked.filePaths[0])
      return { url }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { error: message, notInstalled: /not installed/i.test(message) }
    }
  })
  ipcMain.handle(IPC.CodeServerStop, () => {
    stopCodeServer()
  })

  // ── Persistence (renderer → main, invoke) ──
  ipcMain.handle(IPC.StateLoad, (): Promise<PersistedState | null> => loadState())
  ipcMain.handle(IPC.StateSave, (_e, state: PersistedState): Promise<void> => saveState(state))

  // ── Process metrics (renderer → main, invoke) ──
  ipcMain.handle(IPC.MetricsGet, (): MetricsResult => {
    // Sum workingSetSize (KB) across every app process → MB.
    let kb = 0
    for (const m of app.getAppMetrics()) kb += m.memory?.workingSetSize ?? 0
    return {
      ramMB: Math.round(kb / 1024),
      liveRenderers: panels.liveCount,
      discarded: panels.discardedCount
    }
  })
  // Real per-deck memory for the Memory panel's per-deck list.
  ipcMain.handle(IPC.PanelMetricsGet, () => panels.panelMetrics())

  // ── Floating hover card overlay (always-on-top, over live web pages) ──
  ipcMain.on(IPC.HoverShow, (_e, p: HoverShowPayload) => overlay?.showHover(p))
  ipcMain.on(IPC.HoverHide, () => overlay?.hideHover())

  // ── Settings that affect main (discard timeout) ──
  ipcMain.on(IPC.SettingsApply, (_e, p: SettingsApplyPayload) => {
    if (typeof p.discardMinutes === 'number' && p.discardMinutes > 0) {
      panels.setDiscardAfterMs(p.discardMinutes * 60_000)
    }
  })

  // ── Custom context menu (rendered in the overlay window, floats over pages) ──
  // Renderer asks to show the menu → overlay floats it at the cursor.
  ipcMain.on(IPC.MenuShow, (_e, p: MenuShowPayload) => overlay?.showMenu(p))
  // The overlay reports a chosen item → hide it, then route to the main renderer.
  ipcMain.on(IPC.MenuPick, (_e, p: MenuPickPayload) => {
    overlay?.hideMenu()
    if (!mainWindow) return
    if (p.kind === 'workspace') {
      mainWindow.webContents.send(IPC.WorkspaceMenuAction, {
        workspaceId: p.targetId,
        action: p.action
      })
    } else {
      mainWindow.webContents.send(IPC.FolderMenuAction, { name: p.targetId, action: p.action })
    }
  })
  // The overlay reports a click outside the menu → just hide it.
  ipcMain.on(IPC.MenuDismiss, () => overlay?.hideMenu())

  // ── Mini-player controls (overlay window → main) ──
  // play/pause/next/prev drive the corner video in place; close is special: it
  // EXPANDS the deck back to full size (keep playing) so the user can watch it.
  ipcMain.on(IPC.MiniPlayerControl, (_e, p: MiniPlayerControlEvent) => {
    switch (p.action) {
      case 'play':
        panels.miniPlay()
        break
      case 'pause':
        panels.miniPause()
        break
      case 'next':
        panels.miniNext()
        break
      case 'prev':
        panels.miniPrevious()
        break
      case 'loop':
        panels.miniToggleLoop()
        break
      case 'close': {
        // "Close" = this isn't a song, let me actually watch it. Tell the MAIN
        // renderer to focus the deck; it owns workspace state and will activate
        // the owning workspace, whose next showOnly brings the deck back full-size
        // (mini-player mode clears because the panel is now in the show-set).
        const panelId = panels.miniPlayerPanelId
        if (panelId && mainWindow && !mainWindow.isDestroyed()) {
          const event: FocusPanelEvent = { panelId }
          mainWindow.webContents.send(IPC.FocusPanel, event)
          // "Close" means "let me actually watch this" → bring Decks forward
          // (the other controls deliberately do NOT raise the app).
          if (mainWindow.isMinimized()) mainWindow.restore()
          mainWindow.show()
          mainWindow.focus()
        }
        break
      }
      case 'move-start':
        panels.miniMoveStart()
        break
      case 'move':
        panels.miniMove(p.dx ?? 0, p.dy ?? 0)
        break
      case 'move-end':
        panels.miniMoveEnd()
        break
    }
  })
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.decks.app')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

  // ── DRM / Widevine (Netflix, Disney+, Spotify, …) ──
  // Stock Electron ships NO Widevine CDM, so DRM streams won't play. The castLabs
  // "Electron for Content Security" build (a drop-in fork) adds Widevine + a
  // `components` API; gate startup on it so the CDM is loaded before any deck.
  // This is FEATURE-DETECTED: a no-op on stock Electron, active on the castLabs
  // build. See the README "DRM streaming" section for the dependency swap + VMP
  // signing the castLabs build needs (we don't bundle it because it requires an
  // EVS account + signing on your machine).
  const drm = (electron as { components?: { whenReady(): Promise<void> } }).components
  if (drm) {
    try {
      await drm.whenReady()
      console.log('[decks] Widevine components ready — DRM-capable build')
    } catch (err) {
      console.error('[decks] Widevine components failed to initialize:', err)
    }
  }

  // Present as plain Chrome to embedded sites: the default UA contains
  // "decks/x" and "Electron/x" tokens that some sites (Google sign-in, etc.)
  // reject outright ("disallowed_useragent" / "unsupported browser"). Use a
  // clean, fixed Chrome UA — shared with the per-view UA so every embedded deck
  // and OAuth popup looks like a normal browser.
  app.userAgentFallback = CHROME_UA

  // NOTE: do NOT free the renderer dev port here. By the time main runs,
  // electron-vite has already started the dev server ON that port — freeing it
  // would kill our own live dev server and tear the app down on launch. Stale-
  // port recovery belongs BEFORE electron-vite starts (see launcher.py).

  // Register concrete provider clients before any provider IPC can arrive.
  // Phase 0: this is a no-op seam; Phase 1 fills providers/index.ts.
  registerAllProviders()

  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

/** Tear down all panel views and any tracked child processes. Never throws. */
let cleanedUp = false
function cleanup(): void {
  if (cleanedUp) return
  cleanedUp = true
  try {
    panels.destroyAll()
  } catch {
    /* ignore */
  }
  try {
    overlay?.destroy()
  } catch {
    /* ignore */
  }
  try {
    stopCodeServer()
  } catch {
    /* ignore */
  }
  try {
    killTrackedChildren()
  } catch {
    /* ignore */
  }
}

app.on('before-quit', cleanup)
app.on('will-quit', cleanup)

app.on('window-all-closed', () => {
  cleanup()
  if (process.platform !== 'darwin') app.quit()
})

export { mainWindow }
