/**
 * Tour — the first-run guided spotlight.
 *
 * A lightweight, skippable 5-step overlay that points at the *real* Console
 * shell regions and explains the formerly-hidden features in plain language:
 *   1. the sectioned dock + live status,
 *   2. the always-on command bar (⌘K),
 *   3. the page-card tab strip + drag-to-split / open-beside,
 *   4. Native vs Web + the Memory pill,
 *   5. ⌘B collapse + Focus (⌘.).
 *
 * Targets are located by their stable class selectors (`.dock`, `.cmdbar`,
 * `.tabstrip`, `.mempill`) so no cross-component edits are needed; a step with
 * no on-screen target (e.g. the tab strip on Home) centers its card instead.
 *
 * State lives in the store: `tourOpen` + `openTour()`/`closeTour()`. The
 * "seen" flag is persisted (localStorage) so it shows once on first run, and
 * is replayable from the Help panel and Settings.
 */
import { useEffect, useLayoutEffect, useState } from 'react'
import { useStore } from '../store'
import { modCombo, MOD } from '../lib/platform'

type Side = 'right' | 'left' | 'bottom' | 'top' | 'center'

interface Step {
  /** CSS selector for the real shell region to spotlight (optional). */
  target?: string
  title: string
  body: React.ReactNode
  /** Preferred side for the card relative to the target. */
  side: Side
}

const dot = MOD === '⌘' ? '⌘.' : 'Ctrl+.'
const collapse = MOD === '⌘' ? '⌘B' : 'Ctrl+B'

const STEPS: Step[] = [
  {
    target: '.dock',
    side: 'right',
    title: 'Your decks live here',
    body: (
      <>
        The dock is a labeled, sectioned list of every deck — grouped into
        folders, with a live status dot showing what&apos;s loaded. Click a row
        to open it; nothing is hidden behind a gesture.
      </>
    )
  },
  {
    target: '.cmdbar',
    side: 'bottom',
    title: 'One bar for everything',
    body: (
      <>
        The command bar is always on. Click it — or press{' '}
        <span className="kbd">{modCombo('K')}</span> — to jump to any deck or run
        any command without lifting your hands off the keyboard.
      </>
    )
  },
  {
    target: '.page-card',
    side: 'left',
    title: 'Split the page',
    body: (
      <>
        Drag any dock tile onto the page card to view two decks at once — glowing
        drop zones show where they’ll land. Up to four panes (side-by-side on a
        wide screen, stacked on a tall one). Each pane has its own reload, focus,
        and pop-out.
      </>
    )
  },
  {
    target: '.mempill',
    side: 'bottom',
    title: 'Native vs Web',
    body: (
      <>
        Cyan <b>native</b> decks draw our own fast UI on real APIs and spawn no
        browser engine — near-zero memory. Grey <b>web</b> decks are sandboxed
        pages. The <b>Memory</b> pill shows exactly what&apos;s live and what got
        freed.
      </>
    )
  },
  {
    side: 'center',
    title: 'Make room when you need it',
    body: (
      <>
        Press <span className="kbd">{collapse}</span> to collapse the dock to a
        slim rail, or <span className="kbd">{dot}</span> for Focus mode — one
        deck, full width. Everything is a keystroke away, and always replayable
        from Settings.
      </>
    )
  }
]

/** Padding (px) of the highlight ring around the target rect. */
const PAD = 8
/** Gap (px) between the ring and the tooltip card. */
const GAP = 14
const CARD_W = 320

interface Rect {
  top: number
  left: number
  width: number
  height: number
}

function measure(selector?: string): Rect | null {
  if (!selector) return null
  const el = document.querySelector(selector)
  if (!el) return null
  const r = el.getBoundingClientRect()
  if (r.width === 0 && r.height === 0) return null
  return { top: r.top, left: r.left, width: r.width, height: r.height }
}

function Tour(): JSX.Element | null {
  const tourOpen = useStore((s) => s.tourOpen)
  const closeTour = useStore((s) => s.closeTour)
  const [i, setI] = useState(0)
  const [rect, setRect] = useState<Rect | null>(null)

  const step = STEPS[i]
  const last = i === STEPS.length - 1

  // Reset to the first step every time the tour (re)opens.
  useEffect(() => {
    if (tourOpen) setI(0)
  }, [tourOpen])

  // Measure the current target (and re-measure on resize) so the ring + card
  // track the real region. A step with no target centers its card.
  useLayoutEffect(() => {
    if (!tourOpen) return
    const update = (): void => setRect(measure(step?.target))
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [tourOpen, step?.target])

  // Keyboard: →/Enter advance, ← back, Esc skip.
  useEffect(() => {
    if (!tourOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        closeTour()
      } else if (e.key === 'ArrowRight' || e.key === 'Enter') {
        e.preventDefault()
        setI((v) => (v >= STEPS.length - 1 ? v : v + 1))
        if (last) closeTour()
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        setI((v) => Math.max(0, v - 1))
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [tourOpen, last, closeTour])

  if (!tourOpen || !step) return null

  const next = (): void => {
    if (last) closeTour()
    else setI((v) => v + 1)
  }
  const back = (): void => setI((v) => Math.max(0, v - 1))

  // Ring geometry (only when we have a real target).
  const ring = rect
    ? {
        top: rect.top - PAD,
        left: rect.left - PAD,
        width: rect.width + PAD * 2,
        height: rect.height + PAD * 2
      }
    : null

  // Place the card relative to the ring, clamped to the viewport.
  const vw = window.innerWidth
  const vh = window.innerHeight
  let cardStyle: React.CSSProperties
  if (!ring || step.side === 'center') {
    // Center via px (NOT translate) — the card's `pop` animation ends at
    // `transform: none`, which would otherwise wipe a centering transform.
    cardStyle = {
      left: Math.round((vw - CARD_W) / 2),
      top: Math.round(vh / 2 - 140)
    }
  } else {
    let left = ring.left
    let top = ring.top
    if (step.side === 'right') {
      left = ring.left + ring.width + GAP
      top = ring.top
    } else if (step.side === 'left') {
      left = ring.left - CARD_W - GAP
      top = ring.top
    } else if (step.side === 'bottom') {
      left = ring.left + ring.width / 2 - CARD_W / 2
      top = ring.top + ring.height + GAP
    } else if (step.side === 'top') {
      left = ring.left + ring.width / 2 - CARD_W / 2
      top = ring.top - GAP
    }
    left = Math.max(16, Math.min(left, vw - CARD_W - 16))
    top = Math.max(16, Math.min(top, vh - 220))
    cardStyle = { left, top }
  }

  return (
    <div className="tour-root">
      {/* Dimmed scrim. When a ring is shown, the ring's own box-shadow provides
          the dim (so it isn't doubled) — the scrim then just catches click-to-skip. */}
      <div
        className="tour-scrim"
        style={ring ? { background: 'transparent', backdropFilter: 'none' } : undefined}
        onClick={closeTour}
      />
      {ring && (
        <div
          className="tour-ring"
          style={{ top: ring.top, left: ring.left, width: ring.width, height: ring.height }}
        />
      )}

      <div className="tour-card glass" style={cardStyle}>
        <div className="tour-step-meta">
          Step {i + 1} of {STEPS.length}
        </div>
        <h3 className="tour-title">{step.title}</h3>
        <div className="tour-body">{step.body}</div>

        <div className="tour-dots" role="tablist" aria-label="Tour progress">
          {STEPS.map((_, k) => (
            <button
              key={k}
              className={`tour-dot ${k === i ? 'on' : ''}`}
              aria-label={`Go to step ${k + 1}`}
              aria-selected={k === i}
              onClick={() => setI(k)}
            />
          ))}
        </div>

        <div className="tour-actions">
          <button className="btn-ghost" onClick={closeTour}>
            Skip
          </button>
          <div className="tour-nav">
            {i > 0 && (
              <button className="btn-ghost" onClick={back}>
                Back
              </button>
            )}
            <button className="btn-primary" onClick={next}>
              {last ? 'Done' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default Tour
