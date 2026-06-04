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
  PanelShowOnlyPayload
} from '@shared/ipc'
import type { PanelId, PersistedState } from '@shared/types'
import { PanelManager } from './panels'
import { loadState, saveState } from './persistence'
import { freeDevPort, killTrackedChildren, rendererDevPort } from './lifecycle'

let mainWindow: BrowserWindow | null = null
const panels = new PanelManager()

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 600,
    show: false,
    frame: false,
    backgroundColor: '#0e0e13',
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  panels.setWindow(mainWindow)

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
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.decks.app')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

  // If a previous crashed run left our own renderer dev port bound, free it.
  // Only ever targets THIS app's specific port — never a blanket kill.
  if (is.dev) {
    await freeDevPort(rendererDevPort(process.env['ELECTRON_RENDERER_URL']))
  }

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
