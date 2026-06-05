/**
 * WorkspaceEditModal — small focused editor for Rename / Add-note, opened from
 * the native workspace context menu. Hides web views only while editing.
 */
import { useState } from 'react'
import { useStore } from '../../store'
import { useHideViewsWhile } from '../../lib/useOverlay'
import type { Workspace } from '@shared/types'

export default function WorkspaceEditModal({
  workspace,
  mode,
  onClose
}: {
  workspace: Workspace
  mode: 'rename' | 'note'
  onClose: () => void
}): JSX.Element {
  useHideViewsWhile(true)
  const renameWorkspace = useStore((s) => s.renameWorkspace)
  const setNotes = useStore((s) => s.setNotes)
  const [name, setName] = useState(workspace.name)
  const [note, setNote] = useState(workspace.notes ?? '')

  const save = (): void => {
    if (mode === 'rename') renameWorkspace(workspace.id, name.trim() || workspace.name)
    else setNotes(workspace.id, note.trim())
    onClose()
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-black/50 pt-32 backdrop-blur-sm" onClick={onClose}>
      <div className="w-[min(420px,90vw)] overflow-hidden rounded-xl2 border border-line bg-bg-elevated shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="border-b border-line px-4 py-3 text-sm font-semibold text-txt-1">
          {mode === 'rename' ? 'Rename workspace' : 'Note'}
        </div>
        <div className="p-4">
          {mode === 'rename' ? (
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') onClose() }}
              className="w-full rounded-lg border border-line bg-bg-panel px-3 py-2 text-sm text-txt-1 outline-none focus:border-accent-ring"
            />
          ) : (
            <textarea
              autoFocus
              rows={4}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}
              placeholder="leave a note for this workspace…"
              className="w-full resize-none rounded-lg border border-line bg-bg-panel px-3 py-2 text-sm text-txt-1 outline-none placeholder:text-txt-4 focus:border-accent-ring"
            />
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-line px-4 py-3">
          <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm text-txt-3 hover:text-txt-1">Cancel</button>
          <button onClick={save} className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-white hover:opacity-90">Save</button>
        </div>
      </div>
    </div>
  )
}
