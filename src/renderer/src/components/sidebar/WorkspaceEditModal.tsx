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
    <>
      <div className="scrim" onClick={onClose} />
      <div className="modal glass" onClick={(e) => e.stopPropagation()}>
        <h3>{mode === 'rename' ? 'Rename workspace' : 'Note'}</h3>
        {mode === 'rename' ? (
          <label className="field">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') onClose() }}
            />
          </label>
        ) : (
          <label className="field" style={{ height: 'auto', padding: 12, alignItems: 'stretch' }}>
            <textarea
              autoFocus
              rows={4}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}
              placeholder="leave a note for this workspace…"
              style={{
                flex: 1,
                background: 'none',
                border: 'none',
                outline: 'none',
                resize: 'none',
                color: 'var(--txt-1)',
                fontSize: 14,
                fontFamily: 'var(--font-ui)'
              }}
            />
          </label>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={save}>Save</button>
        </div>
      </div>
    </>
  )
}
