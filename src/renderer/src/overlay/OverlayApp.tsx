/**
 * OverlayApp — the root rendered inside the transparent, always-on-top overlay
 * window (loaded with `#overlay`). It owns nothing but the floating hover card:
 * it subscribes to main's `onOverlayRender` events and shows/hides the card.
 * The surface is fully transparent and pointer-events:none so the empty area is
 * click-through to the app beneath.
 */
import { useEffect, useState } from 'react'
import type { HoverSummary } from '@shared/ipc'
import FloatingHoverCard from './FloatingHoverCard'

export default function OverlayApp(): JSX.Element | null {
  const [summary, setSummary] = useState<HoverSummary | null>(null)

  useEffect(() => {
    return window.decks?.onOverlayRender((e) => {
      setSummary(e.show && e.summary ? e.summary : null)
    })
  }, [])

  if (!summary) return null

  return (
    <div className="pointer-events-none fixed inset-0">
      {/* keyed so re-showing for a different tile replays the entrance animation */}
      <FloatingHoverCard key={summary.name} summary={summary} />
    </div>
  )
}
