/**
 * TileIcon — renders a workspace's app-style icon that FILLS its square
 * container. Walks a crisp source chain (see lib/favicon.iconCandidates) and
 * falls back to a colored initial. Owned by the logo-quality surface.
 */
import { useState } from 'react'
import { iconCandidates, initialOf } from '../../lib/favicon'

export default function TileIcon({
  url,
  favicon,
  color,
  glyph,
  name
}: {
  url?: string
  favicon?: string
  color: string
  glyph?: string
  name: string
}): JSX.Element {
  const candidates = url ? iconCandidates(url, favicon) : []
  const [idx, setIdx] = useState(0)
  const iconUrl = candidates[idx]
  const showImg = idx < candidates.length && !!iconUrl

  if (showImg) {
    return (
      <img
        key={iconUrl}
        src={iconUrl}
        alt={name}
        className="h-full w-full select-none object-cover"
        style={{ backfaceVisibility: 'hidden' }}
        loading="eager"
        decoding="async"
        onError={() => setIdx((i) => i + 1)}
        draggable={false}
      />
    )
  }
  return (
    <span
      className="grid h-full w-full place-items-center text-base font-semibold"
      style={{ color, background: color + '24' }}
    >
      {glyph || initialOf(name, url || '')}
    </span>
  )
}
