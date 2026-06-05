/**
 * Decks — main process entry.
 *
 * Owns: the frameless window, native WebContentsView panels (via PanelManager),
 * every IPC handler declared in @shared/ipc, JSON persistence, and the
 * process-lifecycle registry + safe cleanup.
 */
import { app, shell, BrowserWindow, ipcMain } from 'electron'
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
  MenuPickPayload
} from '@shared/ipc'
import type { PanelId, PersistedState } from '@shared/types'
import { PanelManager } from './panels'
import { loadState, saveState } from './persistence'
import { killTrackedChildren } from './lifecycle'
import { createOverlay, type OverlayController } from './overlay'

/**
 * Cap the number of Chromium renderer processes the app will spin up. With one
 * renderer per visible WebContentsView this bounds RAM hard, and the discard
 * manager keeps hidden panels from holding processes. Tradeoff: fewer processes
 * means less site isolation — panels sharing a process aren't memory-isolated,
 * and a heavy or crashing site can affect others in its process. 4 balances RAM
 * against isolation for a handful of simultaneously-visible decks.
 */
const RENDERER_PROCESS_LIMIT = 4
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
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.decks.app')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

  // NOTE: do NOT free the renderer dev port here. By the time main runs,
  // electron-vite has already started the dev server ON that port — freeing it
  // would kill our own live dev server and tear the app down on launch. Stale-
  // port recovery belongs BEFORE electron-vite starts (see launcher.py).

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
