/**
 * AddDeckModal — add ANY site as a new deck by pasting a link. Opened by the
 * rail "+" button (and ⌘/Ctrl+N). Creates a new workspace whose tile shows the
 * site's favicon. No fixed list — any URL works.
 */
import { useState } from 'react'
import { useStore } from '../store'
import { hostOf } from '../lib/favicon'
import { useHideViewsWhile } from '../lib/useOverlay'
import type { Workspace } from '@shared/types'

const PALETTE = ['#7c5cff', '#ff3b3b', '#3ddc97', '#5b8def', '#e1306c', '#f5b342', '#d77a4b']

function normalizeUrl(input: string): string | null {
  let v = input.trim()
  if (!v) return null
  if (!/^https?:\/\//i.test(v)) v = 'https://' + v
  try {
    return new URL(v).toString()
  } catch {
    return null
  }
}

export default function AddDeckModal({ onClose }: { onClose: () => void }): JSX.Element {
  useHideViewsWhile(true)
  const addWorkspace = useStore((s) => s.addWorkspace)
  const activate = useStore((s) => s.activateWorkspace)
  const count = useStore((s) => s.workspaces.length)

  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [err, setErr] = useState('')

  const submit = (): void => {
    const normalized = normalizeUrl(url)
    if (!normalized) {
      setErr('Enter a valid link, e.g. notion.so')
      return
    }
    const id = `ws_${Date.now().toString(36)}`
    const title = name.trim() || hostOf(normalized) || 'New deck'
    const pid = `panel_${Date.now().toString(36)}`
    const ws: Workspace = {
      id,
      name: title,
      subtitle: '1 deck',
      color: PALETTE[count % PALETTE.length],
      glyph: title.charAt(0).toUpperCase(),
      partition: `persist:${id}`,
      live: { status: 'idle' },
      panels: [{ id: pid, title, url: normalized }],
      layout: { type: 'leaf', panelId: pid }
    }
    addWorkspace(ws)
    activate(id) // App's ensure-create builds the native view for the new deck
    onClose()
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-black/55 pt-32 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-[min(440px,90vw)] overflow-hidden rounded-xl2 border border-line bg-bg-elevated shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-line px-4 py-3 text-sm font-semibold text-txt-1">Add a deck</div>
        <div className="flex flex-col gap-3 p-4">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-txt-3">Link</span>
            <input
              autoFocus
              value={url}
              onChange={(e) => { setUrl(e.target.value); setErr('') }}
              onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
              placeholder="paste any URL — e.g. figma.com"
              className="rounded-lg border border-line bg-bg-panel px-3 py-2 text-sm text-txt-1 outline-none placeholder:text-txt-4 focus:border-accent-ring"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-txt-3">Name (optional)</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
              placeholder="defaults to the site name"
              className="rounded-lg border border-line bg-bg-panel px-3 py-2 text-sm text-txt-1 outline-none placeholder:text-txt-4 focus:border-accent-ring"
            />
          </label>
          {err && <span className="text-xs text-err">{err}</span>}
        </div>
        <div className="flex justify-end gap-2 border-t border-line px-4 py-3">
          <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm text-txt-3 hover:text-txt-1">Cancel</button>
          <button onClick={submit} className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-white hover:opacity-90">Add deck</button>
        </div>
      </div>
    </div>
  )
}
