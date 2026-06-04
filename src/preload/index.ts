/**
 * Decks — preload.
 *
 * Implements the `DecksApi` contract (see @shared/ipc) and exposes it on
 * `window.decks` via contextBridge. This is a thin, dumb forwarder: it owns no
 * logic, only marshals calls to the main process and relays events back.
 */
import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { IPC } from '@shared/ipc'
import type {
  DecksApi,
  PanelCreatePayload,
  PanelNavigatePayload,
  PanelSetBoundsPayload,
  PanelShowOnlyPayload,
  PanelUpdateEvent
} from '@shared/ipc'
import type { PanelId, PersistedState } from '@shared/types'

const api: DecksApi = {
  panel: {
    create: (p: PanelCreatePayload) => ipcRenderer.invoke(IPC.PanelCreate, p),
    destroy: (panelId: PanelId) => ipcRenderer.invoke(IPC.PanelDestroy, panelId),
    navigate: (p: PanelNavigatePayload) => ipcRenderer.invoke(IPC.PanelNavigate, p),
    reload: (panelId: PanelId) => ipcRenderer.invoke(IPC.PanelReload, panelId),
    goBack: (panelId: PanelId) => ipcRenderer.invoke(IPC.PanelGoBack, panelId),
    goForward: (panelId: PanelId) => ipcRenderer.invoke(IPC.PanelGoForward, panelId),
    setBounds: (p: PanelSetBoundsPayload) => ipcRenderer.invoke(IPC.PanelSetBounds, p),
    showOnly: (p: PanelShowOnlyPayload) => ipcRenderer.invoke(IPC.PanelShowOnly, p),
    hideAll: () => ipcRenderer.invoke(IPC.PanelHideAll)
  },
  state: {
    load: () => ipcRenderer.invoke(IPC.StateLoad),
    save: (state: PersistedState) => ipcRenderer.invoke(IPC.StateSave, state)
  },
  window: {
    minimize: () => ipcRenderer.send(IPC.WindowMinimize),
    maximize: () => ipcRenderer.send(IPC.WindowMaximize),
    close: () => ipcRenderer.send(IPC.WindowClose)
  },
  onPanelUpdate: (cb: (e: PanelUpdateEvent) => void) => {
    const listener = (_: unknown, e: PanelUpdateEvent): void => cb(e)
    ipcRenderer.on(IPC.PanelUpdate, listener)
    return () => ipcRenderer.removeListener(IPC.PanelUpdate, listener)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('decks', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (no contextIsolation)
  window.electron = electronAPI
  // @ts-ignore
  window.decks = api
}
