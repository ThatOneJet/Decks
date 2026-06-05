import { useEffect } from 'react'

/**
 * While `open` is true, detach all native web views so renderer overlays
 * (menus, modals, the palette) are actually visible — native WebContentsViews
 * render ABOVE the renderer DOM and would otherwise cover them. On close, nudge
 * a resize so SplitView re-measures and re-attaches the views over their cards.
 */
export function useHideViewsWhile(open: boolean): void {
  useEffect(() => {
    if (!open) return
    window.decks?.panel.hideAll()
    return () => {
      window.dispatchEvent(new Event('resize'))
    }
  }, [open])
}
