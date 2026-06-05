/**
 * Decks logo — a fanned stack of cards (a "deck"). Pure vector (SVG).
 * The same artwork is rasterized to the app/taskbar icon (see build/icon.svg).
 */
export default function Logo({
  size = 28,
  className
}: {
  size?: number
  className?: string
}): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" className={className} aria-label="Decks">
      <defs>
        <linearGradient id="deckg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#9b86ff" />
          <stop offset="1" stopColor="#6a4cff" />
        </linearGradient>
      </defs>
      {/* back card */}
      <rect x="14" y="9" width="20" height="30" rx="4.5" fill="#6a4cff" opacity="0.35" transform="rotate(-14 24 24)" />
      {/* middle card */}
      <rect x="14" y="9" width="20" height="30" rx="4.5" fill="#7c5cff" opacity="0.6" transform="rotate(-7 24 24)" />
      {/* front card */}
      <rect x="14" y="9" width="20" height="30" rx="4.5" fill="url(#deckg)" />
      {/* glyph accent on the front card */}
      <circle cx="24" cy="24" r="3.4" fill="#fff" opacity="0.92" />
    </svg>
  )
}
