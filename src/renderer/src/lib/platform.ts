/**
 * OS detection for keyboard-hint display. Prefers the real platform from the
 * preload (window.electron.process.platform), falls back to the UA.
 */
function detectMac(): boolean {
  try {
    const p = window.electron?.process?.platform
    if (p) return p === 'darwin'
  } catch {
    /* ignore */
  }
  return /mac/i.test(navigator.userAgent)
}

export const isMac = detectMac()

/** The modifier label for this OS: ⌘ on macOS, Ctrl elsewhere. */
export const MOD = isMac ? '⌘' : 'Ctrl'

/** A combo label, e.g. modCombo('K') → "⌘K" (mac) or "Ctrl+K" (win/linux). */
export function modCombo(key: string): string {
  return isMac ? `${MOD}${key}` : `${MOD}+${key}`
}
