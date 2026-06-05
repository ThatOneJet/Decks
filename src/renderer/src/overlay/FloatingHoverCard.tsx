/**
 * FloatingHoverCard — a compact text flyout rendered inside the overlay window
 * so it floats ABOVE live web pages. No icon (the rail tile already shows it).
 * Anchored top-left of the overlay window (main positions it by the tile).
 * Pointer-events:none; animates in via `.overlay-pop`.
 */
import type { HoverSummary } from '@shared/ipc'

export default function FloatingHoverCard({ summary }: { summary: HoverSummary }): JSX.Element {
  const { name, deckCount, unread, playing, notes } = summary

  return (
    <div className="hovercard glass">
      <div className="hn">{name}</div>
      <div className="hmeta">
        <span className="chip">
          {deckCount} deck{deckCount === 1 ? '' : 's'}
        </span>
        {unread > 0 && <span className="chip acc">{unread} unread</span>}
        {playing && <span className="chip live">▶ playing</span>}
      </div>
      {notes && <div className="hrow">“{notes}”</div>}
    </div>
  )
}
