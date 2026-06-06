/**
 * AddDeckModal — the "Add a deck" wizard. Opened by the rail "+" (and ⌘/Ctrl+N).
 *
 * Step 1: choose a deck INTEGRATION we support (native providers + common
 *   embedded sites) — or a custom URL.
 * Step 2: AUTH / config. Native integrations that need login (Canvas, GitHub,
 *   Spotify, Bluesky, Mastodon) require a connect step before the deck is added
 *   (no skip). RSS asks for a collection name; the follows-wall and web sites can
 *   be added straight away (you sign into web decks inside the deck).
 *
 * Each added deck lands in its OWN new workspace (rail tile). Steps slide in.
 */
import { useState } from 'react'
import { useStore } from '../store'
import { hostOf, faviconFor } from '../lib/favicon'
import { useHideViewsWhile } from '../lib/useOverlay'
import type { Workspace, ProviderId } from '@shared/types'
import {
  NATIVE_INTEGRATIONS,
  WEB_INTEGRATIONS,
  type Integration,
  type NativeIntegration,
  type WebIntegration
} from '../lib/integrations'

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

/** Create a NATIVE deck (no WebContentsView) bound to an account, in its own workspace. */
function addNativeDeck(provider: ProviderId, accountId: string, label: string, color: string, glyph: string): void {
  const { addWorkspace, activateWorkspace } = useStore.getState()
  const id = `ws_${crypto.randomUUID().slice(0, 8)}`
  const pid = crypto.randomUUID()
  const ws: Workspace = {
    id,
    name: label,
    subtitle: '1 deck',
    color,
    glyph,
    partition: `persist:${id}`,
    live: { status: 'idle' },
    panels: [{ id: pid, title: label, url: '', kind: 'native', provider, accountId }],
    layout: { type: 'leaf', panelId: pid }
  }
  addWorkspace(ws)
  activateWorkspace(id)
}

/** Create an embedded WEB deck in its own workspace. */
function addWebDeck(url: string, label: string, color: string, glyph?: string): void {
  const { addWorkspace, activateWorkspace } = useStore.getState()
  const id = `ws_${crypto.randomUUID().slice(0, 8)}`
  const pid = crypto.randomUUID()
  const ws: Workspace = {
    id,
    name: label,
    subtitle: '1 deck',
    color,
    glyph: glyph ?? label.charAt(0).toUpperCase(),
    partition: `persist:${id}`,
    live: { status: 'idle' },
    panels: [{ id: pid, title: label, url }],
    layout: { type: 'leaf', panelId: pid }
  }
  addWorkspace(ws)
  activateWorkspace(id) // App's ensure-create builds the view for the new deck
}

/** One selectable integration card in the picker grid. */
function IntegrationCard({ it, onPick }: { it: Integration; onPick: () => void }): JSX.Element {
  const fav = it.kind === 'web' ? faviconFor(it.url) : ''
  return (
    <button
      onClick={onPick}
      className="group flex items-center gap-2.5 rounded-xl2 border border-line bg-bg-elevated p-2.5 text-left transition-colors hover:border-accent-ring"
    >
      <span
        className="grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-lg text-base"
        style={{ backgroundColor: it.color + '22' }}
      >
        {fav ? <img src={fav} alt="" className="h-full w-full object-cover" draggable={false} /> : it.glyph}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-txt-1">{it.label}</span>
        <span className="block truncate text-[10.5px] text-txt-3">{it.blurb}</span>
      </span>
    </button>
  )
}

type Picked = { kind: 'integration'; it: Integration } | { kind: 'custom' }

export default function AddDeckModal({ onClose }: { onClose: () => void }): JSX.Element {
  useHideViewsWhile(true)
  const [picked, setPicked] = useState<Picked | null>(null)

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className={`modal glass ${picked ? '' : 'wide'}`} onClick={(e) => e.stopPropagation()}>
        {!picked ? (
          <PickStep onPick={setPicked} onClose={onClose} />
        ) : picked.kind === 'custom' ? (
          <CustomStep onBack={() => setPicked(null)} onClose={onClose} />
        ) : picked.it.kind === 'native' ? (
          <NativeStep it={picked.it} onBack={() => setPicked(null)} onClose={onClose} />
        ) : (
          <WebStep it={picked.it} onBack={() => setPicked(null)} onClose={onClose} />
        )}
      </div>
    </>
  )
}

function PickStep({ onPick, onClose }: { onPick: (p: Picked) => void; onClose: () => void }): JSX.Element {
  const [q, setQ] = useState('')
  const query = q.trim().toLowerCase()
  const match = (it: Integration): boolean =>
    !query || it.label.toLowerCase().includes(query) || it.blurb.toLowerCase().includes(query)
  const natives = NATIVE_INTEGRATIONS.filter(match)
  const webs = WEB_INTEGRATIONS.filter(match)

  return (
    <div className="step-in">
      {/* Fixed header — title + search always visible at the top. */}
      <h3>Add a deck</h3>
      <p className="sub">Choose an integration — or paste a custom link.</p>
      <label className="field" style={{ marginBottom: 14 }}>
        <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--txt-3)', flex: 'none' }}>
          <circle cx="11" cy="11" r="7" />
          <path d="m21 21-4.3-4.3" />
        </svg>
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search integrations…" />
      </label>

      {/* Scrollable body — the integration grids. */}
      <div className="modal-scroll">
        {natives.length > 0 && (
          <>
            <div className="mt-1 mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-txt-4">
              Native — our UI on their data
            </div>
            <div className="grid grid-cols-2 gap-2">
              {natives.map((it) => (
                <IntegrationCard key={it.id} it={it} onPick={() => onPick({ kind: 'integration', it })} />
              ))}
            </div>
          </>
        )}

        {webs.length > 0 && (
          <>
            <div className="mt-4 mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-txt-4">
              Web — embedded sites
            </div>
            <div className="grid grid-cols-3 gap-2">
              {webs.map((it) => (
                <IntegrationCard key={it.id} it={it} onPick={() => onPick({ kind: 'integration', it })} />
              ))}
            </div>
          </>
        )}

        {natives.length === 0 && webs.length === 0 && (
          <p className="py-6 text-center text-xs text-txt-4">
            No integration matches “{q}”. Try a custom URL below.
          </p>
        )}
      </div>

      {/* Fixed footer. */}
      <div className="mt-3 flex items-center justify-between" style={{ flex: 'none' }}>
        <button
          onClick={() => onPick({ kind: 'custom' })}
          className="rounded-lg border border-line bg-bg-elevated px-3 py-1.5 text-xs text-txt-2 transition-colors hover:border-accent-ring hover:text-txt-1"
        >
          + Custom URL
        </button>
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
      </div>
    </div>
  )
}

/** Header row with a back arrow + integration glyph + title. */
function StepHead({ it, onBack }: { it: Integration; onBack: () => void }): JSX.Element {
  const fav = it.kind === 'web' ? faviconFor(it.url) : ''
  return (
    <div className="mb-3 flex items-center gap-2.5">
      <button
        onClick={onBack}
        title="Back"
        className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-txt-3 transition-colors hover:bg-bg-elevated hover:text-txt-1"
      >
        <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
      </button>
      <span
        className="grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-lg text-base"
        style={{ backgroundColor: it.color + '22' }}
      >
        {fav ? <img src={fav} alt="" className="h-full w-full object-cover" draggable={false} /> : it.glyph}
      </span>
      <div>
        <h3 style={{ margin: 0 }}>{it.label}</h3>
        <p className="sub" style={{ margin: 0 }}>{it.blurb}</p>
      </div>
    </div>
  )
}

function NativeStep({ it, onBack, onClose }: { it: NativeIntegration; onBack: () => void; onClose: () => void }): JSX.Element {
  const [values, setValues] = useState<Record<string, string>>({})
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  // RSS / follows-wall don't require auth — add straight away.
  const add = async (): Promise<void> => {
    setBusy(true)
    setMsg(null)
    try {
      const accountId = crypto.randomUUID()
      if (it.requiresAuth || it.id === 'rss') {
        const result = await window.decks?.provider.connect({
          provider: it.id,
          accountId,
          mode: it.mode,
          token: it.tokenField ? token : undefined,
          fields: Object.keys(values).length ? values : undefined
        })
        if (!result?.connected) {
          setMsg(result?.error ?? 'Could not connect.')
          setBusy(false)
          return
        }
        const label = result.account ? `${it.label} · ${result.account}` : it.label
        addNativeDeck(it.id, accountId, label, it.color, it.glyph)
      } else {
        // follows-wall: single implicit account, no connect.
        addNativeDeck(it.id, 'default', it.label, it.color, it.glyph)
      }
      onClose()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not add the deck.')
      setBusy(false)
    }
  }

  const needsForm = it.fields.length > 0 || !!it.tokenField

  return (
    <div className="step-in">
      <StepHead it={it} onBack={onBack} />
      {needsForm && (
        <div className="flex flex-col gap-2">
          {it.fields.map((f) => (
            <label key={f.key} className="field" style={{ height: 'auto', padding: '8px 12px' }}>
              <input
                type={f.secret ? 'password' : 'text'}
                placeholder={`${f.label} — ${f.placeholder ?? ''}`}
                value={values[f.key] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              />
            </label>
          ))}
          {it.tokenField && (
            <label className="field">
              <input
                type="password"
                placeholder={`${it.tokenField.label} — ${it.tokenField.placeholder ?? ''}`}
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </label>
          )}
        </div>
      )}
      {it.mode === 'oauth' && (
        <p className="mt-2 text-[11px] leading-relaxed text-txt-3">
          Connecting opens a sign-in window. Register an app with the provider and set its redirect
          URI to the one above.
        </p>
      )}
      {!it.requiresAuth && it.id !== 'rss' && (
        <p className="mt-1 text-[11px] leading-relaxed text-txt-3">No login needed.</p>
      )}
      {msg && <p className="mt-2 text-[11px] text-err">{msg}</p>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
        <button className="btn-ghost" onClick={onBack}>Back</button>
        <button className="btn-primary" onClick={add} disabled={busy}>
          {busy ? 'Connecting…' : it.requiresAuth ? 'Connect & add' : 'Add deck'}
        </button>
      </div>
    </div>
  )
}

function WebStep({ it, onBack, onClose }: { it: WebIntegration; onBack: () => void; onClose: () => void }): JSX.Element {
  const [name, setName] = useState('')
  const add = (): void => {
    addWebDeck(it.url, name.trim() || it.label, it.color, it.glyph)
    onClose()
  }
  return (
    <div className="step-in">
      <StepHead it={it} onBack={onBack} />
      <p className="text-[12px] leading-relaxed text-txt-2">
        Adds <b className="text-txt-1">{it.label}</b> as an embedded deck. You’ll sign in inside the
        deck after adding.
      </p>
      <label className="field" style={{ marginTop: 12 }}>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') add() }}
          placeholder={`name (optional) — defaults to ${it.label}`}
        />
      </label>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
        <button className="btn-ghost" onClick={onBack}>Back</button>
        <button className="btn-primary" onClick={add}>Add deck</button>
      </div>
    </div>
  )
}

function CustomStep({ onBack, onClose }: { onBack: () => void; onClose: () => void }): JSX.Element {
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [err, setErr] = useState('')
  const add = (): void => {
    const normalized = normalizeUrl(url)
    if (!normalized) {
      setErr('Enter a valid link, e.g. notion.so')
      return
    }
    addWebDeck(normalized, name.trim() || hostOf(normalized) || 'New deck', '#35e3ff')
    onClose()
  }
  return (
    <div className="step-in">
      <div className="mb-3 flex items-center gap-2.5">
        <button
          onClick={onBack}
          title="Back"
          className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-txt-3 transition-colors hover:bg-bg-elevated hover:text-txt-1"
        >
          <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
        </button>
        <div>
          <h3 style={{ margin: 0 }}>Custom URL</h3>
          <p className="sub" style={{ margin: 0 }}>Embed any site as a deck.</p>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <label className="field">
          <input
            autoFocus
            value={url}
            onChange={(e) => { setUrl(e.target.value); setErr('') }}
            onKeyDown={(e) => { if (e.key === 'Enter') add() }}
            placeholder="paste any URL — e.g. figma.com"
          />
        </label>
        <label className="field">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') add() }}
            placeholder="name (optional) — defaults to the site name"
          />
        </label>
        {err && <span className="text-xs text-err">{err}</span>}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
        <button className="btn-ghost" onClick={onBack}>Back</button>
        <button className="btn-primary" onClick={add}>Add deck</button>
      </div>
    </div>
  )
}
