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
  WorkspaceMenuActionEvent,
  FolderMenuActionEvent,
  MenuShowPayload,
  MenuPickPayload,
  OverlayMenuEvent,
  HoverShowPayload,
  SettingsApplyPayload,
  OverlayRenderEvent,
  OverlayMiniPlayerEvent,
  MiniPlayerControlEvent,
  FocusPanelEvent,
  ProviderConnectPayload,
  ProviderFetchPayload,
  FeedbackPayload
} from '@shared/ipc'
import type { PanelId, PersistedState, ProviderId } from '@shared/types'

const api: DecksApi = {
  panel: {
    create: (p: PanelCreatePayload) => ipcRenderer.invoke(IPC.PanelCreate, p),
    destroy: (panelId: PanelId) => ipcRenderer.invoke(IPC.PanelDestroy, panelId),
    navigate: (p: PanelNavigatePayload) => ipcRenderer.invoke(IPC.PanelNavigate, p),
    reload: (panelId: PanelId) => ipcRenderer.invoke(IPC.PanelReload, panelId),
    signIn: (panelId: PanelId) => ipcRenderer.invoke(IPC.PanelSignIn, panelId),
    goBack: (panelId: PanelId) => ipcRenderer.invoke(IPC.PanelGoBack, panelId),
    goForward: (panelId: PanelId) => ipcRenderer.invoke(IPC.PanelGoForward, panelId),
    setBounds: (p: PanelSetBoundsPayload) => ipcRenderer.invoke(IPC.PanelSetBounds, p),
    showOnly: (p: PanelShowOnlyPayload) => ipcRenderer.invoke(IPC.PanelShowOnly, p),
    hideAll: () => ipcRenderer.invoke(IPC.PanelHideAll),
    setKeepAlive: (panelId: PanelId, keepAlive: boolean) =>
      ipcRenderer.invoke(IPC.PanelSetKeepAlive, panelId, keepAlive)
  },
  provider: {
    connect: (p: ProviderConnectPayload) => ipcRenderer.invoke(IPC.ProviderConnect, p),
    fetch: (p: ProviderFetchPayload) => ipcRenderer.invoke(IPC.ProviderFetch, p),
    disconnect: (provider: ProviderId, accountId: string) =>
      ipcRenderer.invoke(IPC.ProviderDisconnect, provider, accountId),
    status: (provider: ProviderId, accountId: string) =>
      ipcRenderer.invoke(IPC.ProviderStatus, provider, accountId),
    accounts: (provider: ProviderId) => ipcRenderer.invoke(IPC.ProviderAccounts, provider)
  },
  codeserver: {
    start: () => ipcRenderer.invoke(IPC.CodeServerStart),
    stop: () => ipcRenderer.invoke(IPC.CodeServerStop)
  },
  state: {
    load: () => ipcRenderer.invoke(IPC.StateLoad),
    save: (state: PersistedState) => ipcRenderer.invoke(IPC.StateSave, state)
  },
  feedback: {
    submit: (p: FeedbackPayload) => ipcRenderer.invoke(IPC.FeedbackSubmit, p)
  },
  metrics: {
    get: () => ipcRenderer.invoke(IPC.MetricsGet),
    panels: () => ipcRenderer.invoke(IPC.PanelMetricsGet)
  },
  window: {
    minimize: () => ipcRenderer.send(IPC.WindowMinimize),
    maximize: () => ipcRenderer.send(IPC.WindowMaximize),
    close: () => ipcRenderer.send(IPC.WindowClose)
  },
  menu: {
    show: (p: MenuShowPayload) => ipcRenderer.send(IPC.MenuShow, p),
    pick: (p: MenuPickPayload) => ipcRenderer.send(IPC.MenuPick, p),
    dismiss: () => ipcRenderer.send(IPC.MenuDismiss)
  },
  hover: {
    show: (p: HoverShowPayload) => ipcRenderer.send(IPC.HoverShow, p),
    hide: () => ipcRenderer.send(IPC.HoverHide)
  },
  miniPlayer: {
    control: (e: MiniPlayerControlEvent) => ipcRenderer.send(IPC.MiniPlayerControl, e)
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
  onFolderMenuAction: (cb: (e: FolderMenuActionEvent) => void) => {
    const listener = (_: unknown, e: FolderMenuActionEvent): void => cb(e)
    ipcRenderer.on(IPC.FolderMenuAction, listener)
    return () => ipcRenderer.removeListener(IPC.FolderMenuAction, listener)
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
  },
  onOverlayMenu: (cb: (e: OverlayMenuEvent) => void) => {
    const listener = (_: unknown, e: OverlayMenuEvent): void => cb(e)
    ipcRenderer.on(IPC.OverlayMenu, listener)
    return () => ipcRenderer.removeListener(IPC.OverlayMenu, listener)
  },
  onMiniPlayer: (cb: (e: OverlayMiniPlayerEvent) => void) => {
    const listener = (_: unknown, e: OverlayMiniPlayerEvent): void => cb(e)
    ipcRenderer.on(IPC.OverlayMiniPlayer, listener)
    return () => ipcRenderer.removeListener(IPC.OverlayMiniPlayer, listener)
  },
  onMiniLevels: (cb: (levels: number[]) => void) => {
    const listener = (_: unknown, levels: number[]): void => cb(levels)
    ipcRenderer.on(IPC.OverlayMiniLevels, listener)
    return () => ipcRenderer.removeListener(IPC.OverlayMiniLevels, listener)
  },
  onFocusPanel: (cb: (e: FocusPanelEvent) => void) => {
    const listener = (_: unknown, e: FocusPanelEvent): void => cb(e)
    ipcRenderer.on(IPC.FocusPanel, listener)
    return () => ipcRenderer.removeListener(IPC.FocusPanel, listener)
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
