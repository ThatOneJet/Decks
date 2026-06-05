/**
 * RailTile — one workspace tile in the icon rail. The site logo fills the whole
 * squircle (high-res, with a crisp fallback chain). Active → squircle + accent
 * ring/pill. Unread/playing badges only from real signals. Hover shows a styled
 * HoverCard plus a rich OS tooltip (the one overlay reliable over web views).
 */
import { useRef, useState } from 'react'
import type { Workspace } from '@shared/types'
import { iconCandidates, initialOf } from '../../lib/favicon'
import HoverCard from './HoverCard'

export default function RailTile({
  workspace,
  active,
  onClick
}: {
  workspace: Workspace
  active: boolean
  onClick: () => void
}): JSX.Element {
  const primary = workspace.panels[0]
  const candidates = primary ? iconCandidates(primary.url, primary.favicon) : []
  const [idx, setIdx] = useState(0)
  const [hoverTop, setHoverTop] = useState<number | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  const color = workspace.color || '#7c5cff'
  const unread = workspace.panels.reduce((sum, p) => sum + (p.badge || 0), 0)
  const playing = workspace.panels.some((p) => p.playing)
  const deckN = workspace.panels.filter((p) => p.id).length
  const iconUrl = candidates[idx]
  const showImg = idx < candidates.length && !!iconUrl

  const hoverDetails = [
    workspace.name,
    `${deckN} deck${deckN === 1 ? '' : 's'}`,
    unread > 0 ? `${unread} unread` : null,
    playing ? '▶ playing' : null,
    workspace.notes ? `📝 ${workspace.notes}` : null
  ]
    .filter(Boolean)
    .join('\n')

  const openMenu = (): void =>
    window.decks?.workspace.contextMenu({ workspaceId: workspace.id, hasNotes: !!workspace.notes })

  return (
    <div
      ref={ref}
      className="group relative flex w-full items-center justify-center"
      onMouseEnter={() => setHoverTop(ref.current?.getBoundingClientRect().top ?? null)}
      onMouseLeave={() => setHoverTop(null)}
    >
      {/* Active / hover accent pill on the far left */}
      <span
        className={`absolute left-0 w-1 rounded-r-full bg-accent transition-all ${
          active ? 'h-7 opacity-100' : 'h-2 opacity-0 group-hover:h-4 group-hover:opacity-60'
        }`}
      />

      <button
        onClick={onClick}
        onContextMenu={(e) => {
          e.preventDefault()
          openMenu()
        }}
        title={hoverDetails}
        className={`relative grid h-11 w-11 place-items-center overflow-hidden bg-bg-elevated transition-all duration-150 ${
          active ? 'rounded-xl' : 'rounded-2xl hover:rounded-xl'
        }`}
        style={active ? { boxShadow: `0 0 0 2px ${color}, 0 4px 14px ${color}40` } : undefined}
      >
        {showImg ? (
          // Fill the entire tile with the logo (Discord-style), crisp via 128px sources.
          <img
            src={iconUrl}
            alt={workspace.name}
            className="h-full w-full object-cover"
            onError={() => setIdx((i) => i + 1)}
            draggable={false}
          />
        ) : (
          <span
            className="grid h-full w-full place-items-center text-base font-semibold"
            style={{ color, background: color + '24' }}
          >
            {workspace.glyph || initialOf(workspace.name, primary?.url || '')}
          </span>
        )}
      </button>

      {unread > 0 && (
        <span className="absolute -bottom-0.5 right-2 grid h-4 min-w-4 place-items-center rounded-full border-2 border-bg-rail bg-err px-1 text-[9px] font-bold text-white">
          {unread > 99 ? '99+' : unread}
        </span>
      )}

      {playing && unread === 0 && (
        <span
          className="absolute -bottom-0.5 right-2 grid h-3.5 w-3.5 place-items-center rounded-full border-2 border-bg-rail bg-ok"
          title="Playing"
        >
          <svg viewBox="0 0 24 24" className="h-2 w-2 text-bg" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
        </span>
      )}

      {hoverTop !== null && <HoverCard workspace={workspace} top={hoverTop} />}
    </div>
  )
}
