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
    <>
      <div className="scrim" onClick={onClose} />
      <div className="modal glass" onClick={(e) => e.stopPropagation()}>
        <h3>Add a deck</h3>
        <p className="sub">Paste any link to spin up a new deck.</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label className="field">
            <input
              autoFocus
              value={url}
              onChange={(e) => { setUrl(e.target.value); setErr('') }}
              onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
              placeholder="paste any URL — e.g. figma.com"
            />
          </label>
          <label className="field">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
              placeholder="name (optional) — defaults to the site name"
            />
          </label>
          {err && <span className="text-xs text-err">{err}</span>}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={submit}>Add deck</button>
        </div>
      </div>
    </>
  )
}
