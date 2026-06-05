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
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>{isOverlay ? <OverlayApp /> : <App />}</React.StrictMode>
)
