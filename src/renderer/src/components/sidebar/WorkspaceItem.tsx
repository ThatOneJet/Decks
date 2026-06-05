/**
 * RailTile — one workspace tile in the icon rail. The site logo fills the whole
 * squircle (high-res, with a crisp fallback chain). Active → squircle + accent
 * ring/pill. Unread/playing badges only from real signals. Hover asks main to
 * float an always-on-top hover card ABOVE the live web views (a DOM card would
 * be covered by them); a rich OS tooltip stays as a fallback.
 */
import { useRef, useState } from 'react'
import type { Workspace } from '@shared/types'
import { iconCandidates } from '../../lib/favicon'
import TileIcon from './TileIcon'

/** MIME-ish key carried by the drag payload (the dragged workspace id). */
export const DECKS_WS_DND = 'text/decks-ws'

export default function RailTile({
  workspace,
  active,
  onClick,
  onDropWorkspace
}: {
  workspace: Workspace
  active: boolean
  onClick: () => void
  /** A workspace tile was dropped onto THIS tile (id = dragged workspace). */
  onDropWorkspace?: (draggedId: string) => void
}): JSX.Element {
  const primary = workspace.panels[0]
  const [dragging, setDragging] = useState(false)
  const [dropOver, setDropOver] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const color = workspace.color || '#7c5cff'
  const unread = workspace.panels.reduce((sum, p) => sum + (p.badge || 0), 0)
  const playing = workspace.panels.some((p) => p.playing)
  const deckN = workspace.panels.filter((p) => p.id).length

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

  /** Ask main to float the always-on-top hover card next to this tile. */
  const showHover = (): void => {
    const rect = ref.current?.getBoundingClientRect()
    if (!rect) return
    window.decks?.hover.show({
      summary: {
        name: workspace.name,
        iconUrl: primary ? iconCandidates(primary.url, primary.favicon)[0] ?? '' : '',
        color,
        deckCount: deckN,
        unread,
        playing,
        notes: workspace.notes
      },
      x: rect.right + 8,
      y: rect.top
    })
  }

  const hideHover = (): void => window.decks?.hover.hide()

  return (
    <div
      ref={ref}
      className="group relative flex w-full items-center justify-center"
      onMouseEnter={showHover}
      onMouseLeave={hideHover}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DECKS_WS_DND, workspace.id)
        e.dataTransfer.effectAllowed = 'move'
        setDragging(true)
        hideHover()
      }}
      onDragEnd={() => setDragging(false)}
      onDragOver={(e) => {
        if (!onDropWorkspace) return
        if (!e.dataTransfer.types.includes(DECKS_WS_DND)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setDropOver(true)
      }}
      onDragLeave={() => setDropOver(false)}
      onDrop={(e) => {
        setDropOver(false)
        if (!onDropWorkspace) return
        const id = e.dataTransfer.getData(DECKS_WS_DND)
        if (!id || id === workspace.id) return
        e.preventDefault()
        onDropWorkspace(id)
      }}
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
        className={`relative grid h-9 w-9 place-items-center overflow-hidden bg-bg-elevated transition-all duration-200 ease-out group-hover:translate-x-1.5 ${
          active ? 'translate-x-1 rounded-xl' : 'rounded-2xl group-hover:rounded-xl'
        } ${dragging ? 'scale-90 opacity-40' : ''} ${dropOver ? 'rounded-xl' : ''}`}
        style={dropOver ? { outline: '2px solid #7c5cff', outlineOffset: '1px' } : undefined}
      >
        <TileIcon
          url={primary?.url}
          favicon={primary?.favicon}
          color={color}
          glyph={workspace.glyph}
          name={workspace.name}
        />
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
    </div>
  )
}
