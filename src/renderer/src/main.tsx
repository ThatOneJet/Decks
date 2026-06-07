import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import OverlayApp from './overlay/OverlayApp'
import './index.css'

// The same renderer bundle is loaded twice: once as the main app, and once (by
// the always-on-top overlay window) with a `#overlay` hash. In overlay mode we
// render ONLY the floating hover card on a fully transparent surface — no app
// chrome — so the empty area shows through and stays click-through.
const isOverlay = window.location.hash === '#overlay'

if (isOverlay) {
  // Let the transparent window show through behind the card.
  document.documentElement.classList.add('overlay-mode')
  // The overlay is a SEPARATE window that loads the same bundle, so it does NOT
  // inherit the main window's accent/theme. Hydrate them from persisted state so
  // the mini-player (and any overlay UI) matches the app instead of the raw
  // defaults. Re-apply on every render/mini-player push so live theme/accent
  // changes the user makes in Settings are reflected without a restart.
  const applyOverlayTheme = async (): Promise<void> => {
    const persisted = await window.decks?.state.load().catch(() => null)
    const root = document.documentElement
    if (persisted?.theme === 'light') root.setAttribute('data-theme', 'light')
    else root.removeAttribute('data-theme')
    if (persisted?.settings?.accent) root.style.setProperty('--accent', persisted.settings.accent)
  }
  void applyOverlayTheme()
  window.decks?.onMiniPlayer(() => void applyOverlayTheme())
  window.decks?.onOverlayRender(() => void applyOverlayTheme())
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>{isOverlay ? <OverlayApp /> : <App />}</React.StrictMode>
)
