/**
 * HoverCard — a styled flyout shown when hovering a rail tile: the site logo,
 * the name you chose, and live details (deck count, unread, ▶ playing, note).
 *
 * Note: native web views render above the renderer, so this card is fully
 * visible over the Home screen and the rail; over a live page the rich OS
 * tooltip (set on the tile) carries the same info. The card is anchored just
 * right of the rail.
 */
import type { Workspace } from '@shared/types'
import { faviconFor, initialOf } from '../../lib/favicon'

export default function HoverCard({
  workspace,
  top
}: {
  workspace: Workspace
  top: number
}): JSX.Element {
  const primary = workspace.panels[0]
  const icon = primary ? primary.favicon || faviconFor(primary.url) : ''
  const color = workspace.color || '#7c5cff'
  const deckN = workspace.panels.filter((p) => p.id).length
  const unread = workspace.panels.reduce((s, p) => s + (p.badge || 0), 0)
  const playing = workspace.panels.some((p) => p.playing)

  const clampedTop = Math.min(top, window.innerHeight - 120)

  return (
    <div
      className="pointer-events-none fixed z-[80] w-60 overflow-hidden rounded-xl border border-line bg-bg-elevated shadow-2xl"
      style={{ left: 78, top: clampedTop }}
    >
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <span
          className="grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-lg"
          style={{ background: color + '22' }}
        >
          {icon ? (
            <img src={icon} alt="" className="h-5 w-5 object-contain" draggable={false} />
          ) : (
            <span className="text-sm font-semibold" style={{ color }}>
              {initialOf(workspace.name, primary?.url || '')}
            </span>
          )}
        </span>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-txt-1">{workspace.name}</div>
          <div className="flex items-center gap-1.5 text-[11px] text-txt-3">
            <span>{deckN} deck{deckN === 1 ? '' : 's'}</span>
            {unread > 0 && <span className="text-err">· {unread} unread</span>}
            {playing && <span className="text-ok">· ▶ playing</span>}
          </div>
        </div>
      </div>
      {workspace.notes && (
        <div className="border-t border-line px-3 py-2 text-xs italic text-txt-3">“{workspace.notes}”</div>
      )}
    </div>
  )
}
