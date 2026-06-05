/**
 * RailFolder — a Discord-style folder tile in the icon rail. Shows a rounded
 * square with a 2x2 mini-grid of up to 4 member icons. Clicking toggles the
 * folder OPEN (members render inline below). Right-click opens the custom
 * floating context menu (rename / ungroup) in the overlay window, so it draws
 * ABOVE live web pages. Hovering floats a summary card (mirrors RailTile).
 * Folders are a pure view over workspaces that share a `group` name.
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
  const accent = '#7c5cff'

  const unread = members.reduce(
    (sum, w) => sum + w.panels.reduce((s, p) => s + (p.badge || 0), 0),
    0
  )
  const playing = members.some((w) => w.panels.some((p) => p.playing))

  /** Ask main to float the always-on-top hover card next to this folder. */
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
      x: rect.right + 8,
      y: rect.top
    })
  }
  const hideHover = (): void => window.decks?.hover.hide()

  const openMenu = (x: number, y: number): void =>
    window.decks?.menu.show({ kind: 'folder', targetId: name, x, y })

  return (
    <div className="relative flex w-full flex-col items-center">
      <div
        ref={ref}
        className="group relative flex w-full items-center justify-center"
        onMouseEnter={showHover}
        onMouseLeave={hideHover}
      >
        <span
          className={`absolute left-0 w-1 rounded-r-full bg-accent transition-all ${
            open ? 'h-7 opacity-100' : 'h-2 opacity-0 group-hover:h-4 group-hover:opacity-60'
          }`}
        />

        <button
          onClick={onToggle}
          onContextMenu={(e) => {
            e.preventDefault()
            hideHover()
            openMenu(e.clientX, e.clientY)
          }}
          title={`${name} · ${members.length} workspace${members.length === 1 ? '' : 's'}`}
          className={`grid h-9 w-9 grid-cols-2 grid-rows-2 gap-0.5 overflow-hidden bg-bg-elevated p-1 transition-all duration-150 ${
            open ? 'rounded-xl' : 'rounded-2xl hover:rounded-xl'
          } ${dropOver ? 'rounded-xl' : ''}`}
          style={
            dropOver
              ? { outline: `2px solid ${accent}`, outlineOffset: '1px' }
              : open
                ? { boxShadow: `0 0 0 2px ${accent}, 0 4px 14px ${accent}40` }
                : undefined
          }
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
          {preview.map((w) => (
            <span
              key={w.id}
              className="grid place-items-center overflow-hidden rounded bg-bg-rail"
            >
              <TileIcon
                url={w.panels[0]?.url}
                favicon={w.panels[0]?.favicon}
                color={w.color || accent}
                glyph={w.glyph}
                name={w.name}
              />
            </span>
          ))}
          {/* Pad the grid so it always reads as 2x2. */}
          {Array.from({ length: Math.max(0, 4 - preview.length) }).map((_, i) => (
            <span key={`pad-${i}`} className="rounded bg-bg-rail/40" />
          ))}
        </button>
      </div>
    </div>
  )
}
