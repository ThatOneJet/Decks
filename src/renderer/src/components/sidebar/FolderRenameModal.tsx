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
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/50 pt-32 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-[min(420px,90vw)] overflow-hidden rounded-xl2 border border-line bg-bg-elevated shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-line px-4 py-3 text-sm font-semibold text-txt-1">
          Rename folder
        </div>
        <div className="p-4">
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save()
              if (e.key === 'Escape') onClose()
            }}
            className="w-full rounded-lg border border-line bg-bg-panel px-3 py-2 text-sm text-txt-1 outline-none focus:border-accent-ring"
          />
        </div>
        <div className="flex justify-end gap-2 border-t border-line px-4 py-3">
          <button
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-sm text-txt-3 hover:text-txt-1"
          >
            Cancel
          </button>
          <button
            onClick={save}
            className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-white hover:opacity-90"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
