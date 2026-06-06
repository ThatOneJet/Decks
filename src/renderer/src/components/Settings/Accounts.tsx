/**
 * Accounts — connect native-deck providers (multiple accounts each) and drop
 * their decks into their own workspace.
 *
 * A provider can hold SEVERAL connected accounts (two Canvas schools, two
 * GitHubs, several RSS collections). Each account is connected with a stable
 * `accountId` (a uuid generated here) + a human label the client derives. Tokens
 * live only in the main process (OS-keychain encrypted); this UI never stores or
 * echoes them. "Add deck" creates a NATIVE deck in its OWN new workspace bound to
 * that account — native decks have no WebContentsView, so they cost no extra
 * renderer process.
 *
 * code-server is integrated, not reskinned: "Open a folder" spawns local VS Code
 * and opens it as a normal web deck in its own workspace.
 */
import { useCallback, useEffect, useState } from 'react'
import type { ProviderId, AccountSummary, Workspace } from '@shared/types'
import { useStore } from '../../store'

interface FieldDef {
  key: string
  label: string
  placeholder?: string
  secret?: boolean
}

interface ProviderDef {
  id: ProviderId
  label: string
  glyph: string
  color: string
  blurb: string
  /** 'login' = credentials; 'collection' = RSS feed sets; 'aggregate' = no connect. */
  kind: 'login' | 'collection' | 'aggregate'
  mode: 'token' | 'oauth'
  /** Primary pasted token input (PAT / access token), when the flow uses one. */
  tokenField?: { label: string; placeholder?: string }
  /** Extra connect fields passed in `fields`. */
  fields: FieldDef[]
}

const PROVIDERS: ProviderDef[] = [
  {
    id: 'canvas',
    label: 'Canvas',
    glyph: '🎓',
    color: '#e2484d',
    blurb: 'Courses, to-dos and upcoming assignments.',
    kind: 'login',
    mode: 'token',
    tokenField: { label: 'Access token', placeholder: 'Account → Settings → New access token' },
    fields: [{ key: 'instanceUrl', label: 'Canvas URL', placeholder: 'https://school.instructure.com' }]
  },
  {
    id: 'github',
    label: 'GitHub',
    glyph: '🐙',
    color: '#6e7681',
    blurb: 'Your notifications and recently-updated repos.',
    kind: 'login',
    mode: 'token',
    tokenField: { label: 'Personal access token', placeholder: 'ghp_… (repo, notifications, read:user)' },
    fields: []
  },
  {
    id: 'spotify',
    label: 'Spotify',
    glyph: '🎧',
    color: '#1db954',
    blurb: 'Now playing, playlists, recently played. Playback needs Premium.',
    kind: 'login',
    mode: 'oauth',
    fields: [
      { key: 'clientId', label: 'Client ID', placeholder: 'from your Spotify app' },
      { key: 'clientSecret', label: 'Client secret', placeholder: 'from your Spotify app', secret: true },
      { key: 'redirectUri', label: 'Redirect URI', placeholder: 'http://127.0.0.1:8888/callback' }
    ]
  },
  {
    id: 'bluesky',
    label: 'Bluesky',
    glyph: '🦋',
    color: '#1185fe',
    blurb: 'Your chronological following timeline.',
    kind: 'login',
    mode: 'token',
    fields: [
      { key: 'handle', label: 'Handle', placeholder: 'you.bsky.social' },
      { key: 'appPassword', label: 'App password', placeholder: 'Settings → App passwords', secret: true }
    ]
  },
  {
    id: 'mastodon',
    label: 'Mastodon',
    glyph: '🐘',
    color: '#6364ff',
    blurb: 'Your home timeline.',
    kind: 'login',
    mode: 'token',
    tokenField: { label: 'Access token', placeholder: 'Preferences → Development → New application' },
    fields: [{ key: 'instanceUrl', label: 'Instance URL', placeholder: 'https://mastodon.social' }]
  },
  {
    id: 'rss',
    label: 'RSS',
    glyph: '📡',
    color: '#f5b342',
    blurb: 'Feed collections — blogs, news, even YouTube channels. No account needed.',
    kind: 'collection',
    mode: 'token',
    fields: [{ key: 'label', label: 'Collection name', placeholder: 'e.g. Tech, News' }]
  },
  {
    id: 'follows-wall',
    label: 'Follows wall',
    glyph: '🧱',
    color: '#7c5cff',
    blurb: 'One chronological river of Bluesky + Mastodon + RSS. No algorithm.',
    kind: 'aggregate',
    mode: 'token',
    fields: []
  },
  {
    id: 'discovery',
    label: 'Dashboard',
    glyph: '📊',
    color: '#22d3ee',
    blurb: "Your home dashboard — what's new across all your connected decks.",
    kind: 'aggregate',
    mode: 'token',
    fields: []
  },
  {
    id: 'notes',
    label: 'Notes',
    glyph: '📝',
    color: '#f5b342',
    blurb: 'A fast, Notion-style workspace — pages, to-dos, and blocks. Local & private.',
    kind: 'aggregate',
    mode: 'token',
    fields: []
  },
  {
    id: 'calendar',
    label: 'Calendar',
    glyph: '📅',
    color: '#4ade80',
    blurb: 'Your own calendar — events, national holidays, and a Canvas classwork overlay.',
    kind: 'aggregate',
    mode: 'token',
    fields: []
  }
]

/** Create a NATIVE deck (no WebContentsView) in its OWN new workspace. */
function addNativeDeck(def: ProviderDef, accountId: string, label: string): void {
  const { addWorkspace, activateWorkspace } = useStore.getState()
  const id = `ws_${crypto.randomUUID().slice(0, 8)}`
  const pid = crypto.randomUUID()
  const ws: Workspace = {
    id,
    name: label,
    subtitle: '1 deck',
    color: def.color,
    glyph: def.glyph,
    partition: `persist:${id}`,
    live: { status: 'idle' },
    panels: [{ id: pid, title: label, url: '', kind: 'native', provider: def.id, accountId }],
    layout: { type: 'leaf', panelId: pid }
  }
  addWorkspace(ws)
  activateWorkspace(id)
}

/** Create a normal embedded web deck (used for code-server) in its own workspace. */
function addWebDeck(url: string, title: string, color: string, glyph: string): void {
  const { addWorkspace, activateWorkspace } = useStore.getState()
  const id = `ws_${crypto.randomUUID().slice(0, 8)}`
  const pid = crypto.randomUUID()
  const ws: Workspace = {
    id,
    name: title,
    subtitle: '1 deck',
    color,
    glyph,
    partition: `persist:${id}`,
    live: { status: 'idle' },
    panels: [{ id: pid, title, url }],
    layout: { type: 'leaf', panelId: pid }
  }
  addWorkspace(ws)
  activateWorkspace(id) // App's ensure-create builds the web view for the new deck
}

function ProviderCard({ def }: { def: ProviderDef }): JSX.Element {
  const [accounts, setAccounts] = useState<AccountSummary[]>([])
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [values, setValues] = useState<Record<string, string>>({})
  const [token, setToken] = useState('')
  const [msg, setMsg] = useState<string | null>(null)

  const refresh = useCallback((): void => {
    if (def.kind === 'aggregate') return
    void window.decks?.provider
      .accounts(def.id)
      .then((a) => setAccounts(a))
      .catch(() => setAccounts([]))
  }, [def.id, def.kind])

  useEffect(refresh, [refresh])

  const connect = async (): Promise<void> => {
    setBusy(true)
    setMsg(null)
    try {
      const accountId = crypto.randomUUID()
      const result = await window.decks?.provider.connect({
        provider: def.id,
        accountId,
        mode: def.mode,
        token: def.tokenField ? token : undefined,
        fields: Object.keys(values).length ? values : undefined
      })
      if (result?.connected) {
        setOpen(false)
        setToken('')
        setValues({})
        refresh()
      } else {
        setMsg(result?.error ?? 'Could not connect.')
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not connect.')
    } finally {
      setBusy(false)
    }
  }

  const disconnect = async (accountId: string): Promise<void> => {
    try {
      await window.decks?.provider.disconnect(def.id, accountId)
    } catch {
      /* ignore */
    }
    refresh()
  }

  const addLabel = def.kind === 'collection' ? 'Add collection' : 'Add account'

  return (
    <div className="rounded-xl2 border border-line bg-bg-elevated p-4">
      <div className="flex items-start gap-3">
        <span
          className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-lg"
          style={{ backgroundColor: def.color + '22' }}
        >
          {def.glyph}
        </span>
        <div className="min-w-0 flex-1">
          <span className="text-sm font-medium text-txt-1">{def.label}</span>
          <p className="mt-0.5 text-xs leading-relaxed text-txt-3">{def.blurb}</p>
        </div>
        {def.kind === 'aggregate' ? (
          <button
            onClick={() => addNativeDeck(def, 'default', def.label)}
            className="shrink-0 rounded-lg bg-accent px-2.5 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90"
          >
            Add deck
          </button>
        ) : (
          <button
            onClick={() => setOpen((v) => !v)}
            className="shrink-0 rounded-lg border border-line bg-bg-panel px-2.5 py-1.5 text-xs text-txt-1 transition-colors hover:border-accent"
          >
            {open ? 'Cancel' : addLabel}
          </button>
        )}
      </div>

      {/* Connected accounts (or feed collections). */}
      {accounts.length > 0 && (
        <div className="mt-3 flex flex-col gap-1.5 border-t border-line pt-3">
          {accounts.map((a) => (
            <div key={a.id} className="flex items-center gap-2">
              <span className="grid h-1.5 w-1.5 shrink-0 place-items-center rounded-full bg-ok" />
              <span className="min-w-0 flex-1 truncate text-xs text-txt-2">{a.label}</span>
              <button
                onClick={() => addNativeDeck(def, a.id, a.label)}
                className="shrink-0 rounded-lg bg-accent px-2.5 py-1 text-xs font-medium text-white transition-opacity hover:opacity-90"
              >
                Add deck
              </button>
              <button
                onClick={() => void disconnect(a.id)}
                className="shrink-0 rounded-lg border border-line bg-bg-panel px-2 py-1 text-xs text-txt-3 transition-colors hover:text-err"
              >
                Disconnect
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Connect / add-collection form. */}
      {open && def.kind !== 'aggregate' && (
        <div className="mt-3 flex flex-col gap-2 border-t border-line pt-3">
          {def.fields.map((f) => (
            <label key={f.key} className="flex flex-col gap-1">
              <span className="text-[11px] font-medium text-txt-2">{f.label}</span>
              <input
                type={f.secret ? 'password' : 'text'}
                placeholder={f.placeholder}
                value={values[f.key] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                className="rounded-lg border border-line bg-bg px-3 py-2 text-sm text-txt-1 outline-none placeholder:text-txt-4 focus:border-accent"
              />
            </label>
          ))}
          {def.tokenField && (
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-medium text-txt-2">{def.tokenField.label}</span>
              <input
                type="password"
                placeholder={def.tokenField.placeholder}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                className="rounded-lg border border-line bg-bg px-3 py-2 text-sm text-txt-1 outline-none placeholder:text-txt-4 focus:border-accent"
              />
            </label>
          )}
          {def.mode === 'oauth' && (
            <p className="text-[11px] leading-relaxed text-txt-3">
              Connecting opens a sign-in window. Register an app with the provider and set its
              redirect URI to the one above.
            </p>
          )}
          {msg && <p className="text-[11px] text-err">{msg}</p>}
          <button
            onClick={connect}
            disabled={busy}
            className="mt-1 self-start rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? 'Connecting…' : def.kind === 'collection' ? 'Create' : 'Connect'}
          </button>
        </div>
      )}
    </div>
  )
}

function CodeServerRow(): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const open = async (): Promise<void> => {
    setBusy(true)
    setMsg(null)
    try {
      const r = await window.decks?.codeserver.start()
      if (r?.url) {
        addWebDeck(r.url, 'VS Code', '#3ddc97', '🧑‍💻')
      } else if (r?.cancelled) {
        // user backed out — say nothing
      } else if (r?.notInstalled) {
        setMsg('code-server isn’t installed. Install it (npm i -g code-server) and try again.')
      } else if (r?.error) {
        setMsg(r.error)
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not start code-server.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-xl2 border border-line bg-bg-elevated p-4">
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-bg-panel text-lg">
          🧑‍💻
        </span>
        <div className="min-w-0 flex-1">
          <span className="text-sm font-medium text-txt-1">code-server (VS Code)</span>
          <p className="mt-0.5 text-xs leading-relaxed text-txt-3">
            Open a local folder in real VS Code, running on 127.0.0.1 as a deck.
          </p>
          {msg && <p className="mt-1.5 text-[11px] text-err">{msg}</p>}
        </div>
        <button
          onClick={open}
          disabled={busy}
          className="shrink-0 rounded-lg bg-accent px-2.5 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {busy ? 'Starting…' : 'Open a folder…'}
        </button>
      </div>
    </div>
  )
}

export default function Accounts(): JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      {PROVIDERS.map((def) => (
        <ProviderCard key={def.id} def={def} />
      ))}
      <CodeServerRow />
    </div>
  )
}
