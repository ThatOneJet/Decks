/**
 * MiniPlayerBar — the floating now-playing CARD for an audible YouTube deck you've
 * switched away from. The deck itself stays hidden (audio keeps playing); this
 * card is the ONLY thing shown. Layout, top → bottom:
 *   1. artwork + song title + poster (channel)         ← doubles as the drag handle
 *   2. transport controls (prev / play-pause / next / loop / expand)
 *   3. a seek bar with the elapsed timer at its start (click/drag to scrub)
 *   4. a search box to play another song/video
 * It floats above live web views (the overlay window is always-on-top), can be
 * dragged anywhere on screen, and stays up even when the app window is minimized.
 *
 * Controls → main via `window.decks.miniPlayer.control(...)`:
 *  - play/pause/loop/seek → drive the <video> in place (web-standard).
 *  - prev/next            → YouTube's own Shift+P / Shift+N (FRAGILE, main-side).
 *  - search               → load YouTube results + auto-play the first (FRAGILE).
 *  - close                → EXPAND the deck back to full size (keep playing).
 */
import { useRef, useState } from 'react'
import type { MiniPlayerMeta, MiniPlayerControlEvent } from '@shared/ipc'

function send(e: MiniPlayerControlEvent): void {
  window.decks?.miniPlayer.control(e)
}

/** Seconds → m:ss (or h:mm:ss for long videos). */
function fmt(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0
  const total = Math.floor(s)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const sec = total % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return `${h > 0 ? h + ':' : ''}${mm}:${String(sec).padStart(2, '0')}`
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
  const duration = meta.duration ?? 0
  const currentTime = meta.currentTime ?? 0
  const pct = duration > 0 ? Math.min(100, Math.max(0, (currentTime / duration) * 100)) : 0

  const [query, setQuery] = useState('')

  // Drag the card by grabbing the artwork/title region. Track ABSOLUTE screen
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
      send({ action: 'move', ...lastDelta.current })
    })
  }

  const endDrag = (): void => {
    dragStart.current = null
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', endDrag)
    send({ action: 'move-end' })
  }

  const startDrag = (e: React.PointerEvent): void => {
    dragStart.current = { x: e.screenX, y: e.screenY }
    send({ action: 'move-start' })
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', endDrag)
  }

  // Click anywhere on the seek track to scrub there.
  const onSeek = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (duration <= 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    send({ action: 'seek', time: frac * duration })
  }

  const submitSearch = (e: React.FormEvent): void => {
    e.preventDefault()
    const q = query.trim()
    if (!q) return
    send({ action: 'search', query: q })
    setQuery('')
    ;(document.activeElement as HTMLElement | null)?.blur()
  }

  return (
    <div className="overlay-pop glass pointer-events-auto fixed inset-0 flex flex-col gap-2 rounded-xl2 p-2.5">
      {/* 1 — Artwork + title/poster (drag handle). */}
      <div
        onPointerDown={startDrag}
        title="Drag to move"
        className="flex min-w-0 cursor-grab items-center gap-2.5 active:cursor-grabbing"
      >
        <div className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-lg bg-bg">
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

      {/* 2 — Controls. */}
      <div className="flex items-center justify-center gap-1">
        <Ctrl title="Previous" onClick={() => send({ action: 'prev' })}>
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor"><path d="M6 6h2v12H6zM20 6v12l-8.5-6z" /></svg>
        </Ctrl>
        <Ctrl
          title={paused ? 'Play' : 'Pause'}
          onClick={() => send({ action: paused ? 'play' : 'pause' })}
        >
          {paused ? (
            <svg viewBox="0 0 24 24" className="h-4 w-4 text-txt-1" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
          ) : (
            <svg viewBox="0 0 24 24" className="h-4 w-4 text-txt-1" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg>
          )}
        </Ctrl>
        <Ctrl title="Next" onClick={() => send({ action: 'next' })}>
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor"><path d="M16 6h2v12h-2zM4 6l8.5 6L4 18z" /></svg>
        </Ctrl>
        <Ctrl title={loop ? 'Looping' : 'Loop'} onClick={() => send({ action: 'loop' })} active={loop}>
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 2l4 4-4 4" />
            <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
            <path d="M7 22l-4-4 4-4" />
            <path d="M21 13v1a4 4 0 0 1-4 4H3" />
          </svg>
        </Ctrl>
        <Ctrl title="Expand to full size" onClick={() => send({ action: 'close' })}>
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
          </svg>
        </Ctrl>
      </div>

      {/* 3 — Seek bar with elapsed timer at its start. */}
      <div className="flex items-center gap-2">
        <span className="w-9 shrink-0 text-right text-[10px] tabular-nums text-txt-3">{fmt(currentTime)}</span>
        <div
          onClick={onSeek}
          title={duration > 0 ? `${fmt(currentTime)} / ${fmt(duration)}` : 'No duration'}
          className={`group relative h-1.5 flex-1 rounded-full bg-bg ${duration > 0 ? 'cursor-pointer' : ''}`}
        >
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-accent"
            style={{ width: `${pct}%` }}
          />
          <div
            className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent opacity-0 transition-opacity group-hover:opacity-100"
            style={{ left: `${pct}%` }}
          />
        </div>
        <span className="w-9 shrink-0 text-[10px] tabular-nums text-txt-4">{duration > 0 ? fmt(duration) : '--:--'}</span>
      </div>

      {/* 4 — Search for another song/video. */}
      <form onSubmit={submitSearch} className="flex items-center gap-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg bg-bg px-2">
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0 text-txt-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Play another song…"
            className="min-w-0 flex-1 bg-transparent py-1.5 text-[11px] text-txt-1 placeholder:text-txt-4 focus:outline-none"
          />
        </div>
        <button
          type="submit"
          title="Search & play"
          className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-txt-2 transition-colors hover:bg-accent-soft hover:text-accent"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
        </button>
      </form>
    </div>
  )
}
