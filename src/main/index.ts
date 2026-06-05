/**
 * Decks — main process entry.
 *
 * Owns: the frameless window, native WebContentsView panels (via PanelManager),
 * every IPC handler declared in @shared/ipc, JSON persistence, and the
 * process-lifecycle registry + safe cleanup.
 */
import { app, shell, BrowserWindow, ipcMain, Menu } from 'electron'
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
import { killTrackedChildren } from './lifecycle'

let mainWindow: BrowserWindow | null = null
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

  // ── Native workspace context menu (renders ABOVE web views; page stays put) ──
  ipcMain.on(IPC.WorkspaceContextMenu, (_e, p: { workspaceId: string; hasNotes: boolean }) => {
    if (!mainWindow) return
    const sendAction = (action: string): void =>
      mainWindow?.webContents.send(IPC.WorkspaceMenuAction, { workspaceId: p.workspaceId, action })
    const menu = Menu.buildFromTemplate([
      { label: 'Rename', click: () => sendAction('rename') },
      { label: 'Reset decks', click: () => sendAction('reset') },
      { label: p.hasNotes ? 'Edit note' : 'Add note', click: () => sendAction('note') },
      { type: 'separator' },
      { label: 'Delete workspace', click: () => sendAction('delete') }
    ])
    menu.popup({ window: mainWindow })
  })
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
