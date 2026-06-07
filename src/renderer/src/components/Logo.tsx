/**
 * Decks logo — a fanned stack of cards (a "deck"). Pure vector (SVG).
 * The same artwork is rasterized to the app/taskbar icon (see build/icon.svg).
 */
export default function Logo({
  size = 28,
  className,
  tint = '#5b8cff'
}: {
  size?: number
  className?: string
  /** Brand color — blue for JetCore Decks, orange for JetCore Operations. */
  tint?: string
}): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" className={className} aria-label="Logo">
      {/* fanned deck of cards, tinted per mode (opacity gives the stacked depth) */}
      <rect x="14" y="9" width="20" height="30" rx="4.5" fill={tint} opacity="0.35" transform="rotate(-14 24 24)" />
      <rect x="14" y="9" width="20" height="30" rx="4.5" fill={tint} opacity="0.6" transform="rotate(-7 24 24)" />
      <rect x="14" y="9" width="20" height="30" rx="4.5" fill={tint} />
      <circle cx="24" cy="24" r="3.4" fill="#fff" opacity="0.92" />
    </svg>
  )
}
