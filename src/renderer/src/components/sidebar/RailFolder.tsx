/**
 * RailFolder — a Discord-style folder tile in the icon rail (redesign look).
 * A 48px squircle holding a 2×2 mini-grid of up to 4 member logos. Click toggles
 * the folder open (members render inline below). Right-click opens the custom
 * overlay menu (rename / ungroup); hover floats a summary card. A workspace tile
 * dropped here joins the group. Pure view over workspaces sharing a `group`.
 */
import { useRef, useState } from 'react'
import type { Workspace } from '@shared/types'
import TileIcon from './TileIcon'
import { DECKS_WS_DND } from './WorkspaceItem'

export default function RailFolder({
  name,
  members,
  open,
  onToggle,
  onDropWorkspace
}: {
  name: string
  members: Workspace[]
  open: boolean
  onToggle: () => void
  /** A workspace tile was dropped onto this folder (id = dragged workspace). */
  onDropWorkspace: (draggedId: string) => void
}): JSX.Element {
  const [dropOver, setDropOver] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const preview = members.slice(0, 4)
  const accent = '#35e3ff'

  const unread = members.reduce(
    (sum, w) => sum + w.panels.reduce((s, p) => s + (p.badge || 0), 0),
    0
  )
  const playing = members.some((w) => w.panels.some((p) => p.playing))

  const showHover = (): void => {
    const rect = ref.current?.getBoundingClientRect()
    if (!rect) return
    window.decks?.hover.show({
      summary: {
        name,
        iconUrl: '',
        color: accent,
        deckCount: members.length,
        unread,
        playing,
        notes: undefined
      },
      x: rect.right + 10,
      y: rect.top
    })
  }
  const hideHover = (): void => window.decks?.hover.hide()

  const openMenu = (x: number, y: number): void =>
    window.decks?.menu.show({
      kind: 'folder',
      targetId: name,
      keepAlive: members.length > 0 && members.every((m) => m.keepAlive),
      x,
      y
    })

  return (
    <div
      ref={ref}
      className={`tile-wrap ${open ? 'active' : ''} ${dropOver ? 'drop-target' : ''}`}
      onMouseEnter={showHover}
      onMouseLeave={hideHover}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(DECKS_WS_DND)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setDropOver(true)
      }}
      onDragLeave={() => setDropOver(false)}
      onDrop={(e) => {
        setDropOver(false)
        const id = e.dataTransfer.getData(DECKS_WS_DND)
        if (!id) return
        e.preventDefault()
        onDropWorkspace(id)
      }}
    >
      <span className="tile-pill" />
      <button
        onClick={onToggle}
        onContextMenu={(e) => {
          e.preventDefault()
          hideHover()
          openMenu(e.clientX, e.clientY)
        }}
        title={`${name} · ${members.length} workspace${members.length === 1 ? '' : 's'}`}
        className="folder"
      >
        {preview.map((w) => (
          <span key={w.id}>
            <TileIcon
              url={w.panels[0]?.url}
              favicon={w.panels[0]?.favicon}
              color={w.color || accent}
              glyph={w.glyph}
              name={w.name}
            />
          </span>
        ))}
        {Array.from({ length: Math.max(0, 4 - preview.length) }).map((_, i) => (
          <span key={`pad-${i}`} />
        ))}
      </button>
    </div>
  )
}
