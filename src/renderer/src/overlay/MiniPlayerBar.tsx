/**
 * MiniPlayerBar — the floating now-playing bar for an audible YouTube deck you've
 * switched away from. The deck itself stays hidden (audio keeps playing); this bar
 * is the ONLY thing shown: artwork + song title + poster (channel) + controls.
 * It floats above live web views (the overlay window is always-on-top) and is
 * INTERACTIVE (`pointer-events-auto`). Main sizes the overlay window to exactly
 * this fixed-size bar and positions it (top-right by default; drag to move).
 *
 * Controls → main via `window.decks.miniPlayer.control(...)`:
 *  - play/pause → drive the <video> in place (web-standard).
 *  - prev/next  → YouTube's own Shift+P / Shift+N shortcuts (FRAGILE, main-side).
 *  - loop       → toggle <video>.loop (web-standard).
 *  - close      → EXPAND the deck back to full size (keep playing).
 */
import { useRef } from 'react'
import type { MiniPlayerMeta } from '@shared/ipc'

type Action = 'play' | 'pause' | 'next' | 'prev' | 'loop' | 'close'
function send(action: Action): void {
  window.decks?.miniPlayer.control({ action })
}

function Ctrl({
  title,
  onClick,
  active,
  children
}: {
  title: string
  onClick: () => void
  active?: boolean
  children: React.ReactNode
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg transition-colors hover:bg-accent-soft hover:text-accent ${
        active ? 'text-accent' : 'text-txt-2'
      }`}
    >
      {children}
    </button>
  )
}

export default function MiniPlayerBar({ meta }: { meta: MiniPlayerMeta }): JSX.Element {
  const { title, artist, artwork, paused, loop } = meta
  // Drag the bar by grabbing the artwork/title region. Track ABSOLUTE screen
  // coords so deltas stay correct even as main repositions the window mid-drag.
  const dragStart = useRef<{ x: number; y: number } | null>(null)
  const rafPending = useRef(false)
  const lastDelta = useRef<{ dx: number; dy: number }>({ dx: 0, dy: 0 })

  const onPointerMove = (e: PointerEvent): void => {
    if (!dragStart.current) return
    lastDelta.current = { dx: e.screenX - dragStart.current.x, dy: e.screenY - dragStart.current.y }
    if (rafPending.current) return
    rafPending.current = true
    requestAnimationFrame(() => {
      rafPending.current = false
      window.decks?.miniPlayer.control({ action: 'move', ...lastDelta.current })
    })
  }

  const endDrag = (): void => {
    dragStart.current = null
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', endDrag)
    window.decks?.miniPlayer.control({ action: 'move-end' })
  }

  const startDrag = (e: React.PointerEvent): void => {
    dragStart.current = { x: e.screenX, y: e.screenY }
    window.decks?.miniPlayer.control({ action: 'move-start' })
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', endDrag)
  }

  return (
    <div className="overlay-pop glass pointer-events-auto fixed inset-0 flex items-center gap-2 rounded-xl2 px-2">
      {/* Artwork + title/poster double as the drag handle. */}
      <div
        onPointerDown={startDrag}
        title="Drag to move"
        className="flex min-w-0 flex-1 cursor-grab items-center gap-2.5 active:cursor-grabbing"
      >
        <div className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-lg bg-bg">
          {artwork ? (
            <img src={artwork} alt="" className="h-full w-full object-cover" draggable={false} />
          ) : (
            <svg viewBox="0 0 24 24" className="h-5 w-5 text-txt-4" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold text-txt-1">{title || 'Playing'}</div>
          {artist && <div className="truncate text-[10.5px] text-txt-3">{artist}</div>}
        </div>
      </div>

      {/* Controls. */}
      <div className="flex shrink-0 items-center gap-0.5">
        <Ctrl title="Previous" onClick={() => send('prev')}>
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor"><path d="M6 6h2v12H6zM20 6v12l-8.5-6z" /></svg>
        </Ctrl>
        <Ctrl title={paused ? 'Play' : 'Pause'} onClick={() => send(paused ? 'play' : 'pause')}>
          {paused ? (
            <svg viewBox="0 0 24 24" className="h-4 w-4 text-txt-1" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
          ) : (
            <svg viewBox="0 0 24 24" className="h-4 w-4 text-txt-1" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg>
          )}
        </Ctrl>
        <Ctrl title="Next" onClick={() => send('next')}>
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor"><path d="M16 6h2v12h-2zM4 6l8.5 6L4 18z" /></svg>
        </Ctrl>
        <Ctrl title={loop ? 'Looping' : 'Loop'} onClick={() => send('loop')} active={loop}>
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 2l4 4-4 4" />
            <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
            <path d="M7 22l-4-4 4-4" />
            <path d="M21 13v1a4 4 0 0 1-4 4H3" />
          </svg>
        </Ctrl>
        <Ctrl title="Expand to full size" onClick={() => send('close')}>
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
          </svg>
        </Ctrl>
      </div>
    </div>
  )
}
