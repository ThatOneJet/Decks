/**
 * FloatingHoverCard — the same styled flyout as the DOM HoverCard, but rendered
 * inside the overlay window so it floats ABOVE live web pages. Anchored to the
 * top-left of the overlay window (which main has already positioned next to the
 * hovered rail tile). Pointer-events:none; animates in via `.overlay-pop`.
 */
import { useState } from 'react'
import type { HoverSummary } from '@shared/ipc'

export default function FloatingHoverCard({ summary }: { summary: HoverSummary }): JSX.Element {
  const [imgFailed, setImgFailed] = useState(false)
  const { name, iconUrl, color, deckCount, unread, playing, notes } = summary

  const initial = (name || '?').trim().charAt(0).toUpperCase()

  return (
    <div className="overlay-pop pointer-events-none absolute left-0 top-0 w-60 overflow-hidden rounded-xl border border-line bg-bg-elevated shadow-2xl">
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <span
          className="grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-lg"
          style={{ background: color + '22' }}
        >
          {iconUrl && !imgFailed ? (
            <img
              src={iconUrl}
              alt=""
              className="h-full w-full object-cover"
              decoding="async"
              onError={() => setImgFailed(true)}
              draggable={false}
            />
          ) : (
            <span className="text-sm font-semibold" style={{ color }}>
              {initial}
            </span>
          )}
        </span>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-txt-1">{name}</div>
          <div className="flex items-center gap-1.5 text-[11px] text-txt-3">
            <span>
              {deckCount} deck{deckCount === 1 ? '' : 's'}
            </span>
            {unread > 0 && <span className="text-err">· {unread} unread</span>}
            {playing && <span className="text-ok">· ▶ playing</span>}
          </div>
        </div>
      </div>
      {notes && (
        <div className="border-t border-line px-3 py-2 text-xs italic text-txt-3">“{notes}”</div>
      )}
    </div>
  )
}
