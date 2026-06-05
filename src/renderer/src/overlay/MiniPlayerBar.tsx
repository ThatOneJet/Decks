/**
 * MiniPlayerBar — the compact now-playing control strip rendered inside the
 * overlay window, drawn just under the corner YouTube video. It floats ABOVE
 * the live web views (the overlay window is always-on-top). Unlike the hover
 * card, this strip is INTERACTIVE: its buttons must catch clicks, so it uses
 * `pointer-events-auto`. The overlay window itself is sized to exactly this strip
 * by the main process, so the whole surface is the bar.
 *
 * Controls forward to main via `window.decks.miniPlayer.control(...)`:
 *  - play/pause  → drive the corner <video> in place (web-standard).
 *  - prev/next   → YouTube's own Shift+P / Shift+N shortcuts (FRAGILE, main-side).
 *  - close       → EXPAND the deck back to full size (keep playing). This is the
 *                  "actually let me watch this" action, distinct from pause.
 */
import type { MiniPlayerMeta } from '@shared/ipc'

function send(action: 'play' | 'pause' | 'next' | 'prev' | 'close'): void {
  window.decks?.miniPlayer.control({ action })
}

export default function MiniPlayerBar({ meta }: { meta: MiniPlayerMeta }): JSX.Element {
  const { title, artist, artwork, paused } = meta

  return (
    <div className="overlay-pop pointer-events-auto fixed inset-0 flex items-center gap-2 rounded-lg border border-line bg-bg-elevated/95 px-2 shadow-2xl backdrop-blur">
      {/* Artwork thumbnail (mediaSession artwork; falls back to a placeholder). */}
      <div className="h-8 w-8 shrink-0 overflow-hidden rounded bg-bg">
        {artwork ? (
          <img src={artwork} alt="" className="h-full w-full object-cover" draggable={false} />
        ) : null}
      </div>

      {/* Title + artist. */}
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-semibold text-txt-1">{title || 'Playing'}</div>
        {artist && <div className="truncate text-[10px] text-txt-3">{artist}</div>}
      </div>

      {/* Previous. */}
      <button
        onClick={() => send('prev')}
        title="Previous"
        className="grid h-7 w-7 shrink-0 place-items-center rounded text-txt-2 transition-colors hover:bg-accent-soft hover:text-accent"
      >
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
          <path d="M6 6h2v12H6zM20 6v12l-8.5-6z" />
        </svg>
      </button>

      {/* Play / pause. */}
      <button
        onClick={() => send(paused ? 'play' : 'pause')}
        title={paused ? 'Play' : 'Pause'}
        className="grid h-7 w-7 shrink-0 place-items-center rounded text-txt-1 transition-colors hover:bg-accent-soft hover:text-accent"
      >
        {paused ? (
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
            <path d="M8 5v14l11-7z" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
            <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
          </svg>
        )}
      </button>

      {/* Next. */}
      <button
        onClick={() => send('next')}
        title="Next"
        className="grid h-7 w-7 shrink-0 place-items-center rounded text-txt-2 transition-colors hover:bg-accent-soft hover:text-accent"
      >
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
          <path d="M16 6h2v12h-2zM4 6l8.5 6L4 18z" />
        </svg>
      </button>

      {/* Close = expand the deck back to full size (keeps playing). */}
      <button
        onClick={() => send('close')}
        title="Expand to full size"
        className="grid h-7 w-7 shrink-0 place-items-center rounded text-txt-2 transition-colors hover:bg-accent-soft hover:text-accent"
      >
        <svg
          viewBox="0 0 24 24"
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
        </svg>
      </button>
    </div>
  )
}
