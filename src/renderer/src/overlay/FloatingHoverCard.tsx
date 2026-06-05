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
    <div className="overlay-pop pointer-events-none absolute left-0 top-0 w-56 overflow-hidden rounded-xl border border-line bg-bg-elevated px-3 py-2 shadow-2xl">
      <div className="truncate text-sm font-semibold text-txt-1">{name}</div>
      <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-txt-3">
        <span>
          {deckCount} deck{deckCount === 1 ? '' : 's'}
        </span>
        {unread > 0 && <span className="text-err">· {unread} unread</span>}
        {playing && <span className="text-ok">· ▶ playing</span>}
      </div>
      {notes && <div className="mt-1.5 border-t border-line pt-1.5 text-xs italic text-txt-3">“{notes}”</div>}
    </div>
  )
}
