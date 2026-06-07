/**
 * RailTile — one workspace tile in the icon rail (redesign look).
 *
 * A 48px squircle that morphs rounder + grows an accent pill on hover/active,
 * the site logo filling it, a Native/Web kind dot, and unread / ▶ playing badges
 * from real signals. Hover floats an always-on-top hover card beside the tile;
 * right-click opens the custom overlay menu. Drag to reorder/group or onto the
 * page to split. (All behaviors preserved; only the styling is the redesign.)
 */
import { useRef, useState } from 'react'
import type { Workspace } from '@shared/types'
import { iconCandidates } from '../../lib/favicon'
import { useStore } from '../../store'
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
  const setGlobalDragging = useStore((s) => s.setDragging)

  const color = workspace.color || '#35e3ff'
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

  const openMenu = (x: number, y: number): void =>
    window.decks?.menu.show({
      kind: 'workspace',
      targetId: workspace.id,
      hasNotes: !!workspace.notes,
      keepAlive: !!workspace.keepAlive,
      pinned: !!workspace.pinned,
      x,
      y
    })

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
      x: rect.right + 10,
      y: rect.top
    })
  }
  const hideHover = (): void => window.decks?.hover.hide()

  return (
    <div
      ref={ref}
      className={`tile-wrap ${active ? 'active' : ''} ${dropOver ? 'drop-target' : ''}`}
      onMouseEnter={showHover}
      onMouseLeave={hideHover}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DECKS_WS_DND, workspace.id)
        e.dataTransfer.effectAllowed = 'move'
        setDragging(true)
        hideHover()
        // Hide native web views so the renderer page area becomes a real DOM
        // drop target (views sit OVER the DOM and would otherwise eat events).
        setGlobalDragging(true)
        window.decks?.panel.hideAll()
      }}
      onDragEnd={() => {
        setDragging(false)
        setGlobalDragging(false)
        window.dispatchEvent(new Event('resize'))
      }}
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
      <span className="tile-pill" />
      <button
        onClick={onClick}
        onContextMenu={(e) => {
          e.preventDefault()
          hideHover()
          openMenu(e.clientX, e.clientY)
        }}
        title={hoverDetails}
        className={`tile ${dragging ? 'dragging' : ''}`}
      >
        <TileIcon
          url={primary?.url}
          favicon={primary?.favicon}
          color={color}
          glyph={workspace.glyph}
          name={workspace.name}
        />
      </button>

      {unread > 0 && <span className="tile-badge">{unread > 99 ? '99+' : unread}</span>}
      {playing && unread === 0 && (
        <span className="tile-playing" title="Playing">
          <svg viewBox="0 0 24 24" width={8} height={8} fill="#fff"><path d="M8 5v14l11-7z" /></svg>
        </span>
      )}
      {workspace.pinned && (
        <span className="tile-pin" title="Pinned to top">
          <svg viewBox="0 0 24 24" width={7} height={7} fill="#fff"><path d="M14 2l8 8-4 1-3 3-1 5-3-3-5 5-1-1 5-5-3-3 5-1 3-3z" /></svg>
        </span>
      )}
    </div>
  )
}
