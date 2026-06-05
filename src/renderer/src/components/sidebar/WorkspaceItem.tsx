/**
 * RailTile — one workspace tile in the icon rail.
 *
 * Shows the favicon/logo of the workspace's primary deck (live favicon if known,
 * else resolved from the URL, else a colored initial). Active → squircle + left
 * accent pill + ring. Unread → count badge. Hover morphs the corner radius
 * (Discord-style) and reveals the name tooltip.
 */
import { useState } from 'react'
import type { Workspace } from '@shared/types'
import { faviconFor, initialOf } from '../../lib/favicon'

export default function RailTile({
  workspace,
  active,
  onClick
}: {
  workspace: Workspace
  active: boolean
  onClick: () => void
}): JSX.Element {
  const [imgFailed, setImgFailed] = useState(false)
  const primary = workspace.panels[0]
  const iconUrl = primary ? primary.favicon || faviconFor(primary.url) : ''
  const color = workspace.color || '#7c5cff'
  // REAL signals only: unread = sum of per-deck title badges; playing = any deck
  // has active media. No badge/indicator appears unless the site reports one.
  const unread = workspace.panels.reduce((sum, p) => sum + (p.badge || 0), 0)
  const playing = workspace.panels.some((p) => p.playing)
  const showImg = !!iconUrl && !imgFailed
  const deckN = workspace.panels.filter((p) => p.id).length

  // Rich hover details — the OS tooltip is the one overlay that reliably renders
  // ABOVE native web views, so it carries the name + live details.
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
    <div className="group relative flex w-full items-center justify-center">
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
          <img
            src={iconUrl}
            alt={workspace.name}
            className="h-6 w-6 object-contain"
            onError={() => setImgFailed(true)}
            draggable={false}
          />
        ) : (
          <span
            className="grid h-full w-full place-items-center text-sm font-semibold"
            style={{ color, background: color + '1f' }}
          >
            {workspace.glyph || initialOf(workspace.name, primary?.url || '')}
          </span>
        )}
      </button>

      {/* Unread badge — only when the site actually reports unread items */}
      {unread > 0 && (
        <span className="absolute -bottom-0.5 right-2 grid h-4 min-w-4 place-items-center rounded-full border-2 border-bg-rail bg-err px-1 text-[9px] font-bold text-white">
          {unread > 99 ? '99+' : unread}
        </span>
      )}

      {/* Playing indicator — only while a deck is actively playing media */}
      {playing && unread === 0 && (
        <span
          className="absolute -bottom-0.5 right-2 grid h-3.5 w-3.5 place-items-center rounded-full border-2 border-bg-rail bg-ok"
          title="Playing"
        >
          <svg viewBox="0 0 24 24" className="h-2 w-2 text-bg" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
        </span>
      )}

    </div>
  )
}
