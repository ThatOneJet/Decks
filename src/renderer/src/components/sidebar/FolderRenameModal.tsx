/**
 * FolderRenameModal — small focused editor for renaming a rail folder (group),
 * opened from the custom folder context menu. Hides web views only while editing
 * (mirrors WorkspaceEditModal). On save it calls the store's renameGroup.
 */
import { useState } from 'react'
import { useStore } from '../../store'
import { useHideViewsWhile } from '../../lib/useOverlay'

export default function FolderRenameModal({
  name,
  onClose
}: {
  name: string
  onClose: () => void
}): JSX.Element {
  useHideViewsWhile(true)
  const renameGroup = useStore((s) => s.renameGroup)
  const [draft, setDraft] = useState(name)

  const save = (): void => {
    const next = draft.trim()
    if (next && next !== name) renameGroup(name, next)
    onClose()
  }

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="modal glass" onClick={(e) => e.stopPropagation()}>
        <h3>Rename folder</h3>
        <label className="field">
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save()
              if (e.key === 'Escape') onClose()
            }}
          />
        </label>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" onClick={save}>
            Save
          </button>
        </div>
      </div>
    </>
  )
}
