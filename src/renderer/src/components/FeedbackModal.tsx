/**
 * FeedbackModal — send a Suggestion or Bug report straight to the dev from inside
 * the app. Pick a type, write a title + description, optionally attach a
 * screenshot (file-picker / paste / drag-drop), and submit. Main files it as a
 * GitHub issue on ThatOneJet/Decks (or queues it offline); the always-on Claude
 * session picks it up and builds it.
 */
import { useRef, useState } from 'react'
import { useHideViewsWhile } from '../lib/useOverlay'
import type { FeedbackPayload } from '@shared/ipc'

type Kind = 'suggestion' | 'bug'

export default function FeedbackModal({ onClose }: { onClose: () => void }): JSX.Element {
  useHideViewsWhile(true)
  const [kind, setKind] = useState<Kind>('suggestion')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [image, setImage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const readImage = (file: File | null | undefined): void => {
    if (!file || !file.type.startsWith('image/')) return
    const reader = new FileReader()
    reader.onload = () => setImage(typeof reader.result === 'string' ? reader.result : null)
    reader.readAsDataURL(file)
  }

  const onPaste = (e: React.ClipboardEvent): void => {
    for (const item of e.clipboardData?.items ?? []) {
      if (item.type.startsWith('image/')) {
        readImage(item.getAsFile())
        break
      }
    }
  }
  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    readImage(e.dataTransfer.files?.[0])
  }

  const submit = async (): Promise<void> => {
    if (!title.trim() || busy) return
    setBusy(true)
    setMsg(null)
    const payload: FeedbackPayload = {
      type: kind,
      title: title.trim(),
      description: description.trim(),
      imageDataUrl: image ?? undefined
    }
    const res = await window.decks?.feedback.submit(payload).catch(() => null)
    setBusy(false)
    if (res?.ok) {
      setMsg({ ok: true, text: `Sent ✓ — issue #${res.number}. Claude will build it.` })
      setTimeout(onClose, 1100)
    } else if (res?.queued) {
      setMsg({ ok: true, text: 'Queued — it’ll send automatically once online.' })
      setTimeout(onClose, 1300)
    } else {
      setMsg({ ok: false, text: res?.error || 'Could not send. Try again.' })
    }
  }

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div
        className="modal glass"
        onClick={(e) => e.stopPropagation()}
        onPaste={onPaste}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit()
        }}
      >
        <h3>Send feedback</h3>
        <p className="sub">Suggest a feature or report a bug — it goes straight to the dev.</p>

        {/* Type toggle */}
        <div className="mb-3 inline-flex gap-1 rounded-lg bg-bg p-1">
          {(['suggestion', 'bug'] as Kind[]).map((k) => (
            <button
              key={k}
              onClick={() => setKind(k)}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold capitalize transition-colors ${
                kind === k ? 'bg-accent text-black' : 'text-txt-3 hover:text-txt-1'
              }`}
            >
              {k === 'bug' ? '🐞 Bug' : '💡 Suggestion'}
            </button>
          ))}
        </div>

        <label className="field mb-2">
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={kind === 'bug' ? 'What broke?' : 'What should we add?'}
          />
        </label>

        <label className="field mb-2" style={{ height: 'auto', padding: 12, alignItems: 'stretch' }}>
          <textarea
            rows={4}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Details — steps, context, what you expected…"
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

        {/* Image: pick / paste / drag */}
        {image ? (
          <div className="relative mb-2 overflow-hidden rounded-lg border border-line">
            <img src={image} alt="attachment" className="max-h-44 w-full object-contain bg-bg" />
            <button
              onClick={() => setImage(null)}
              className="absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-lg bg-bg/80 text-txt-2 backdrop-blur hover:text-err"
              title="Remove image"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          </div>
        ) : (
          <div
            onDrop={onDrop}
            onDragOver={(e) => e.preventDefault()}
            onClick={() => fileRef.current?.click()}
            className="mb-2 grid cursor-pointer place-items-center gap-1 rounded-lg border border-dashed border-line py-4 text-xs text-txt-4 transition-colors hover:border-accent-ring hover:text-txt-3"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="9" cy="9" r="2" />
              <path d="M21 15l-5-5L5 21" />
            </svg>
            Attach a screenshot — click, paste, or drop
          </div>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => readImage(e.target.files?.[0])}
        />

        {msg && (
          <div className={`mb-1 text-xs ${msg.ok ? 'text-ok' : 'text-err'}`}>{msg.text}</div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={() => void submit()} disabled={!title.trim() || busy}>
            {busy ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
    </>
  )
}
