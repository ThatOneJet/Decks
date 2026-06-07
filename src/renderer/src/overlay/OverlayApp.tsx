/**
 * OverlayApp — the root rendered inside the transparent, always-on-top overlay
 * window (loaded with `#overlay`). It hosts two mutually-exclusive modes:
 *  - the floating hover card (via `onOverlayRender`), and
 *  - the custom context menu (via `onOverlayMenu`).
 * Both float ABOVE live web pages. The surface is transparent; the empty area is
 * click-through (pointer-events:none) for the hover card, while the menu turns
 * pointer-events back on so its backdrop can catch outside clicks.
 */
import { useEffect, useState } from 'react'
import type { HoverSummary, MenuKind, MiniPlayerMeta } from '@shared/ipc'
import FloatingHoverCard from './FloatingHoverCard'
import OverlayMenu from './OverlayMenu'
import MiniPlayerBar, { MiniTab } from './MiniPlayerBar'

type MenuState = {
  kind: MenuKind
  targetId: string
  hasNotes: boolean
  keepAlive: boolean
  pinned: boolean
}

export default function OverlayApp(): JSX.Element | null {
  const [summary, setSummary] = useState<HoverSummary | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [mini, setMini] = useState<{
    meta: MiniPlayerMeta
    collapsed: boolean
    edge: 'left' | 'right'
  } | null>(null)

  useEffect(() => {
    return window.decks?.onOverlayRender((e) => {
      setSummary(e.show && e.summary ? e.summary : null)
    })
  }, [])

  useEffect(() => {
    return window.decks?.onOverlayMenu((e) => {
      if (e.hide) setMenu(null)
      else
        setMenu({
          kind: e.kind,
          targetId: e.targetId,
          hasNotes: e.hasNotes,
          keepAlive: !!e.keepAlive,
          pinned: !!e.pinned
        })
    })
  }, [])

  useEffect(() => {
    return window.decks?.onMiniPlayer((e) => {
      if (e.show && e.meta) {
        setMini({ meta: e.meta, collapsed: !!e.collapsed, edge: e.edge ?? 'right' })
      } else {
        setMini(null)
      }
    })
  }, [])

  // Menu wins: it owns the interactive window while open. (Main hides the
  // mini-player bar before showing a menu, so they never overlap.)
  if (menu) {
    return (
      <div className="fixed inset-0">
        <OverlayMenu
          kind={menu.kind}
          targetId={menu.targetId}
          hasNotes={menu.hasNotes}
          keepAlive={menu.keepAlive}
          pinned={menu.pinned}
        />
      </div>
    )
  }

  // Mini-player bar: interactive control strip under the corner video.
  if (mini) {
    return (
      <div className="fixed inset-0">
        {mini.collapsed ? (
          <MiniTab edge={mini.edge} />
        ) : (
          <MiniPlayerBar meta={mini.meta} />
        )}
      </div>
    )
  }

  if (!summary) return null

  return (
    <div className="pointer-events-none fixed inset-0">
      {/* keyed so re-showing for a different tile replays the entrance animation */}
      <FloatingHoverCard key={summary.name} summary={summary} />
    </div>
  )
}
