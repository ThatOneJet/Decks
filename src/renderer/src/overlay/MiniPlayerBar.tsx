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
import { useEffect, useRef, useState } from 'react'
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
      className={`mp-ctrl grid h-7 w-7 shrink-0 place-items-center rounded-lg transition-colors ${
        active ? 'is-active' : 'text-txt-2'
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

  // Marquee the title back and forth when it's too long to fit. Measure the text
  // overflow against its box; `boxRef` width is stable regardless of the span's
  // mode, so this recomputes correctly even when a marquee is already running.
  const titleBoxRef = useRef<HTMLDivElement>(null)
  const titleTextRef = useRef<HTMLSpanElement>(null)
  const [marquee, setMarquee] = useState<{ shift: number; dur: number } | null>(null)
  useEffect(() => {
    const box = titleBoxRef.current
    const text = titleTextRef.current
    if (!box || !text) return
    const overflow = text.scrollWidth - box.clientWidth
    if (overflow > 4) {
      setMarquee({ shift: -(overflow + 6), dur: Math.max(6, Math.round((overflow + 60) / 22)) })
    } else {
      setMarquee(null)
    }
  }, [title])

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

  // Click OR drag along the seek track to scrub. We track the bar's rect at
  // pointer-down and seek continuously while dragging.
  const seekRect = useRef<DOMRect | null>(null)
  const seekAt = (clientX: number): void => {
    const rect = seekRect.current
    if (!rect || duration <= 0) return
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    send({ action: 'seek', time: frac * duration })
  }
  const onSeekMove = (e: PointerEvent): void => seekAt(e.clientX)
  const onSeekUp = (): void => {
    window.removeEventListener('pointermove', onSeekMove)
    window.removeEventListener('pointerup', onSeekUp)
    seekRect.current = null
  }
  const onSeekDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (duration <= 0) return
    seekRect.current = e.currentTarget.getBoundingClientRect()
    seekAt(e.clientX) // jump immediately on press
    window.addEventListener('pointermove', onSeekMove)
    window.addEventListener('pointerup', onSeekUp)
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
    <div className="overlay-pop glass pointer-events-auto fixed inset-x-0 top-0 flex flex-col gap-2 rounded-xl2 p-2.5">
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
          <div ref={titleBoxRef} className="overflow-hidden">
            <span
              ref={titleTextRef}
              className={`text-xs font-semibold text-txt-1 ${marquee ? 'mp-marquee' : 'block truncate'}`}
              style={
                marquee
                  ? ({ '--mp-shift': `${marquee.shift}px`, '--mp-dur': `${marquee.dur}s` } as React.CSSProperties)
                  : undefined
              }
            >
              {title || 'Playing'}
            </span>
          </div>
          {artist && <div className="truncate text-[10.5px] text-txt-3">{artist}</div>}
        </div>
      </div>

      {/* 2 — Controls. Minimize + loop on the left, transport centered, refresh +
          expand on the right. */}
      <div className="flex items-center justify-between gap-1">
        <div className="flex items-center gap-1">
          <Ctrl title="Tuck to the side" onClick={() => send({ action: 'collapse' })}>
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 5v14" />
              <path d="M21 12H8" />
              <path d="M13 7l-5 5 5 5" />
            </svg>
          </Ctrl>
          <Ctrl title={loop ? 'Looping' : 'Loop'} onClick={() => send({ action: 'loop' })} active={loop}>
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 2l4 4-4 4" />
              <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
              <path d="M7 22l-4-4 4-4" />
              <path d="M21 13v1a4 4 0 0 1-4 4H3" />
            </svg>
          </Ctrl>
        </div>
        <div className="flex items-center gap-1">
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
        </div>
        <div className="flex items-center gap-1">
          <Ctrl title="Refresh" onClick={() => send({ action: 'reload' })}>
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
              <path d="M21 3v5h-5" />
              <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
              <path d="M3 21v-5h5" />
            </svg>
          </Ctrl>
          <Ctrl title="Expand to full size" onClick={() => send({ action: 'close' })}>
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
            </svg>
          </Ctrl>
        </div>
      </div>

      {/* 3 — Seek bar with elapsed timer at its start. */}
      <div className="flex items-center gap-2">
        <span className="w-9 shrink-0 text-right text-[10px] tabular-nums text-txt-3">{fmt(currentTime)}</span>
        <div
          onPointerDown={onSeekDown}
          title={duration > 0 ? `${fmt(currentTime)} / ${fmt(duration)}` : 'No duration'}
          className={`group relative flex-1 py-2 ${duration > 0 ? 'cursor-pointer' : ''}`}
        >
          {/* taller invisible hit area (the py-2 above) makes the thin bar easy to grab.
              Fill uses the app's theme accent (var --accent); turns yellow during a
              YouTube ad so you can tell it's an ad, not the song. */}
          <div className="relative h-1.5 rounded-full bg-bg">
            <div
              className="absolute inset-y-0 left-0 rounded-full"
              style={{ width: `${pct}%`, backgroundColor: meta.adShowing ? 'var(--warn)' : 'var(--accent)' }}
            />
            <div
              className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full opacity-0 shadow transition-opacity group-hover:opacity-100"
              style={{ left: `${pct}%`, backgroundColor: meta.adShowing ? 'var(--warn)' : 'var(--accent)' }}
            />
          </div>
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
          className="mp-ctrl grid h-7 w-7 shrink-0 place-items-center rounded-lg text-txt-2 transition-colors"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
        </button>
      </form>
    </div>
  )
}

/**
 * MiniTab — the collapsed mini-player: a slim translucent handle docked at a
 * screen edge with an arrow pointing inward. Click to pull the full player back
 * out; drag the handle to move it (snaps stay where you leave it). The window is
 * already sized/positioned to the tab by main; this just fills it.
 */
export function MiniTab({ edge }: { edge: 'left' | 'right' }): JSX.Element {
  const start = useRef<{ x: number; y: number } | null>(null)
  const moved = useRef(false)

  const onMove = (e: PointerEvent): void => {
    if (!start.current) return
    const dx = e.screenX - start.current.x
    const dy = e.screenY - start.current.y
    if (Math.abs(dx) + Math.abs(dy) > 4) moved.current = true
    send({ action: 'move', dx, dy })
  }
  const onUp = (): void => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    send({ action: 'move-end' })
    if (!moved.current) send({ action: 'expand' }) // a tap (not a drag) pulls it out
    start.current = null
  }
  const onDown = (e: React.PointerEvent): void => {
    start.current = { x: e.screenX, y: e.screenY }
    moved.current = false
    send({ action: 'move-start' })
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // Arrow points away from the docked edge (toward screen center).
  const arrow = edge === 'left' ? 'M9 6l6 6-6 6' : 'M15 6l-6 6 6 6'
  return (
    <div
      onPointerDown={onDown}
      title="Drag to move · click to open the player"
      className={`overlay-pop pointer-events-auto fixed inset-0 flex cursor-grab items-center justify-center border border-line bg-bg-elevated/70 text-txt-2 backdrop-blur transition-colors hover:text-accent active:cursor-grabbing ${
        edge === 'left' ? 'rounded-r-xl rounded-l-sm' : 'rounded-l-xl rounded-r-sm'
      }`}
    >
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d={arrow} />
      </svg>
    </div>
  )
}
