/**
 * RailFolder — a Discord-style folder tile in the icon rail. Shows a rounded
 * square with a 2x2 mini-grid of up to 4 member icons. Clicking toggles the
 * folder OPEN (members render inline below). Right-click opens an inline rename
 * popover. Folders are a pure view over workspaces that share a `group` name.
 */
import { useEffect, useRef, useState } from 'react'
import type { Workspace } from '@shared/types'
import TileIcon from './TileIcon'
import { DECKS_WS_DND } from './WorkspaceItem'
import { useHideViewsWhile } from '../../lib/useOverlay'

export default function RailFolder({
  name,
  members,
  open,
  onToggle,
  onDropWorkspace,
  onRename
}: {
  name: string
  members: Workspace[]
  open: boolean
  onToggle: () => void
  /** A workspace tile was dropped onto this folder (id = dragged workspace). */
  onDropWorkspace: (draggedId: string) => void
  onRename: (newName: string) => void
}): JSX.Element {
  const [dropOver, setDropOver] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(name)
  const inputRef = useRef<HTMLInputElement>(null)

  // Keep native web views hidden while the rename popover is up so it's visible.
  useHideViewsWhile(renaming)

  useEffect(() => {
    if (renaming) {
      setDraft(name)
      // Focus after paint.
      const t = setTimeout(() => inputRef.current?.select(), 0)
      return () => clearTimeout(t)
    }
    return undefined
  }, [renaming, name])

  const commit = (): void => {
    const next = draft.trim()
    if (next && next !== name) onRename(next)
    setRenaming(false)
  }

  const preview = members.slice(0, 4)
  const accent = '#7c5cff'

  return (
    <div className="relative flex w-full flex-col items-center">
      <div className="group relative flex w-full items-center justify-center">
        <span
          className={`absolute left-0 w-1 rounded-r-full bg-accent transition-all ${
            open ? 'h-7 opacity-100' : 'h-2 opacity-0 group-hover:h-4 group-hover:opacity-60'
          }`}
        />

        <button
          onClick={onToggle}
          onContextMenu={(e) => {
            e.preventDefault()
            setRenaming(true)
          }}
          title={`${name} · ${members.length} workspace${members.length === 1 ? '' : 's'}`}
          className={`grid h-11 w-11 grid-cols-2 grid-rows-2 gap-0.5 overflow-hidden bg-bg-elevated p-1 transition-all duration-150 ${
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

        {renaming && (
          <div
            className="absolute left-[60px] top-0 z-50 w-44 rounded-lg border border-line bg-bg-panel p-2 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-txt-3">
              Folder name
            </label>
            <input
              ref={inputRef}
              value={draft}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit()
                else if (e.key === 'Escape') setRenaming(false)
              }}
              onBlur={commit}
              className="w-full rounded-md border border-line bg-bg-elevated px-2 py-1 text-sm text-txt-1 outline-none focus:border-accent focus:ring-1 focus:ring-accent-ring"
            />
          </div>
        )}
      </div>
    </div>
  )
}
