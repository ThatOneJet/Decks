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
  PanelUpdateEvent,
  PanelDiscardStateEvent,
  WorkspaceContextMenuPayload,
  WorkspaceMenuActionEvent,
  HoverShowPayload,
  SettingsApplyPayload,
  OverlayRenderEvent
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
  metrics: {
    get: () => ipcRenderer.invoke(IPC.MetricsGet)
  },
  window: {
    minimize: () => ipcRenderer.send(IPC.WindowMinimize),
    maximize: () => ipcRenderer.send(IPC.WindowMaximize),
    close: () => ipcRenderer.send(IPC.WindowClose)
  },
  workspace: {
    contextMenu: (p: WorkspaceContextMenuPayload) => ipcRenderer.send(IPC.WorkspaceContextMenu, p)
  },
  hover: {
    show: (p: HoverShowPayload) => ipcRenderer.send(IPC.HoverShow, p),
    hide: () => ipcRenderer.send(IPC.HoverHide)
  },
  settings: {
    apply: (p: SettingsApplyPayload) => ipcRenderer.send(IPC.SettingsApply, p)
  },
  onPanelUpdate: (cb: (e: PanelUpdateEvent) => void) => {
    const listener = (_: unknown, e: PanelUpdateEvent): void => cb(e)
    ipcRenderer.on(IPC.PanelUpdate, listener)
    return () => ipcRenderer.removeListener(IPC.PanelUpdate, listener)
  },
  onWorkspaceMenuAction: (cb: (e: WorkspaceMenuActionEvent) => void) => {
    const listener = (_: unknown, e: WorkspaceMenuActionEvent): void => cb(e)
    ipcRenderer.on(IPC.WorkspaceMenuAction, listener)
    return () => ipcRenderer.removeListener(IPC.WorkspaceMenuAction, listener)
  },
  onPanelDiscardState: (cb: (e: PanelDiscardStateEvent) => void) => {
    const listener = (_: unknown, e: PanelDiscardStateEvent): void => cb(e)
    ipcRenderer.on(IPC.PanelDiscardState, listener)
    return () => ipcRenderer.removeListener(IPC.PanelDiscardState, listener)
  },
  onOverlayRender: (cb: (e: OverlayRenderEvent) => void) => {
    const listener = (_: unknown, e: OverlayRenderEvent): void => cb(e)
    ipcRenderer.on(IPC.OverlayRender, listener)
    return () => ipcRenderer.removeListener(IPC.OverlayRender, listener)
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
