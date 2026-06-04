import type { ElectronAPI } from '@electron-toolkit/preload'
import type { DecksApi } from '@shared/ipc'

declare global {
  interface Window {
    electron: ElectronAPI
    decks: DecksApi
  }
}

export {}
