/**
 * Decks — Operations (JetCore) view preload.
 *
 * A SEPARATE, tiny preload loaded ONLY into the Operations WebContentsView (the
 * embedded JetCore Flask page). It exposes a single shell bridge the JetCore UI
 * can call to ask the host to switch back to Decks. Deliberately minimal — no
 * access to the full DecksApi.
 */
import { contextBridge, ipcRenderer } from 'electron'

/** The shell bridge available to the JetCore page as `window.jetcoreShell`. */
const jetcoreShell = {
  /** Ask the Decks host to leave Operations and return to the Decks UI. */
  switchToDecks: (): void => ipcRenderer.send('operations:request-decks')
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('jetcoreShell', jetcoreShell)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (no contextIsolation)
  window.jetcoreShell = jetcoreShell
}
