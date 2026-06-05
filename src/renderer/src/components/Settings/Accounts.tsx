/**
 * Accounts — connect native-deck providers and drop their decks into a workspace.
 *
 * Each native provider (Canvas, GitHub, Spotify, Bluesky, Mastodon, RSS, the
 * Follows wall) is connected here: the form collects only the non-secret fields
 * + a token where needed, and hands them to `window.decks.provider.connect`.
 * Tokens live exclusively in the main process (OS-keychain encrypted) — this UI
 * never stores or echoes them back. "Add deck" creates a native panel in the
 * active workspace; native decks have no WebContentsView, so they cost no extra
 * renderer process (the RAM win over an embedded deck).
 *
 * code-server is integrated, not reskinned: "Open a folder" spawns local VS Code
 * and opens it as a normal web deck.
 */
import { useEffect, useState } from 'react'
import type { ProviderId, ProviderStatus } from '@shared/types'
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
  blurb: string
  mode: 'token' | 'oauth'
  /** Whether connecting requires credentials (RSS / follows-wall do not). */
  needsConnect: boolean
  /** When true, the connect form has a primary "token" input (PAT / access token). */
  tokenField?: { label: string; placeholder?: string }
  /** Extra non-secret (or app-credential) fields passed in `fields`. */
  fields: FieldDef[]
}

const PROVIDERS: ProviderDef[] = [
  {
    id: 'canvas',
    label: 'Canvas',
    glyph: '🎓',
    blurb: 'Courses, to-dos and upcoming assignments.',
    mode: 'token',
    needsConnect: true,
    tokenField: { label: 'Access token', placeholder: 'Canvas → Account → Settings → New access token' },
    fields: [{ key: 'instanceUrl', label: 'Canvas URL', placeholder: 'https://school.instructure.com' }]
  },
  {
    id: 'github',
    label: 'GitHub',
    glyph: '🐙',
    blurb: 'Your notifications and recently-updated repos.',
    mode: 'token',
    needsConnect: true,
    tokenField: { label: 'Personal access token', placeholder: 'ghp_… (repo, notifications, read:user)' },
    fields: []
  },
  {
    id: 'spotify',
    label: 'Spotify',
    glyph: '🎧',
    blurb: 'Now playing, playlists, recently played. Playback needs Premium.',
    mode: 'oauth',
    needsConnect: true,
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
    blurb: 'Your chronological following timeline.',
    mode: 'token',
    needsConnect: true,
    fields: [
      { key: 'handle', label: 'Handle', placeholder: 'you.bsky.social' },
      { key: 'appPassword', label: 'App password', placeholder: 'Settings → App passwords', secret: true }
    ]
  },
  {
    id: 'mastodon',
    label: 'Mastodon',
    glyph: '🐘',
    blurb: 'Your home timeline.',
    mode: 'token',
    needsConnect: true,
    tokenField: { label: 'Access token', placeholder: 'Preferences → Development → New application', },
    fields: [{ key: 'instanceUrl', label: 'Instance URL', placeholder: 'https://mastodon.social' }]
  },
  {
    id: 'rss',
    label: 'RSS',
    glyph: '📡',
    blurb: 'Any feed — blogs, news, even YouTube channels. No account needed.',
    mode: 'token',
    needsConnect: false,
    fields: []
  },
  {
    id: 'follows-wall',
    label: 'Follows wall',
    glyph: '🧱',
    blurb: 'One chronological river of Bluesky + Mastodon + RSS. No algorithm.',
    mode: 'token',
    needsConnect: false,
    fields: []
  }
]

/** Create a native deck (no WebContentsView) in the active/first workspace. */
function addNativeDeck(provider: ProviderId, title: string): void {
  const { activeWorkspaceId, workspaces, addPanel, activateWorkspace } = useStore.getState()
  const wsId = activeWorkspaceId ?? workspaces[0]?.id
  if (!wsId) return
  const id = crypto.randomUUID()
  addPanel(wsId, { id, title, url: '', kind: 'native', provider })
  activateWorkspace(wsId)
}

/** Create a normal embedded web deck (used for code-server's local URL). */
function addWebDeck(url: string, title: string): void {
  const { activeWorkspaceId, workspaces, addPanel, activateWorkspace } = useStore.getState()
  const wsId = activeWorkspaceId ?? workspaces[0]?.id
  if (!wsId) return
  const id = crypto.randomUUID()
  window.decks?.panel
    .create({
      panelId: id,
      workspaceId: wsId,
      partition: 'persist:' + wsId,
      url,
      bounds: { x: 0, y: 0, width: 800, height: 600 }
    })
    .catch(() => {})
  addPanel(wsId, { id, title, url })
  activateWorkspace(wsId)
}

function ProviderRow({ def }: { def: ProviderDef }): JSX.Element {
  const [status, setStatus] = useState<ProviderStatus | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [values, setValues] = useState<Record<string, string>>({})
  const [token, setToken] = useState('')
  const [msg, setMsg] = useState<string | null>(null)

  const refreshStatus = (): void => {
    void window.decks?.provider
      .status(def.id)
      .then((s) => setStatus(s))
      .catch(() => setStatus(null))
  }

  useEffect(refreshStatus, [def.id])

  const connected = !!status?.connected

  const connect = async (): Promise<void> => {
    setBusy(true)
    setMsg(null)
    try {
      const result = await window.decks?.provider.connect({
        provider: def.id,
        mode: def.mode,
        token: def.tokenField ? token : undefined,
        fields: Object.keys(values).length ? values : undefined
      })
      if (result?.connected) {
        setStatus(result)
        setOpen(false)
        setToken('')
        setMsg(null)
      } else {
        setMsg(result?.error ?? 'Could not connect.')
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not connect.')
    } finally {
      setBusy(false)
    }
  }

  const disconnect = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.decks?.provider.disconnect(def.id)
    } catch {
      /* ignore */
    } finally {
      setBusy(false)
      refreshStatus()
    }
  }

  return (
    <div className="rounded-xl2 border border-line bg-bg-elevated p-4">
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-bg-panel text-lg">
          {def.glyph}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-txt-1">{def.label}</span>
            {def.needsConnect &&
              (connected ? (
                <span className="rounded-full bg-ok/15 px-2 py-0.5 text-[10px] font-semibold text-ok">
                  {status?.account ? status.account : 'Connected'}
                </span>
              ) : (
                <span className="rounded-full bg-bg-panel px-2 py-0.5 text-[10px] font-medium text-txt-3">
                  Not connected
                </span>
              ))}
          </div>
          <p className="mt-0.5 text-xs leading-relaxed text-txt-3">{def.blurb}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {def.needsConnect &&
            (connected ? (
              <button
                onClick={disconnect}
                disabled={busy}
                className="rounded-lg border border-line bg-bg-panel px-2.5 py-1.5 text-xs text-txt-2 transition-colors hover:text-err disabled:opacity-40"
              >
                Disconnect
              </button>
            ) : (
              <button
                onClick={() => setOpen((v) => !v)}
                className="rounded-lg border border-line bg-bg-panel px-2.5 py-1.5 text-xs text-txt-1 transition-colors hover:border-accent"
              >
                {open ? 'Cancel' : 'Connect'}
              </button>
            ))}
          <button
            onClick={() => addNativeDeck(def.id, def.label)}
            className="rounded-lg bg-accent px-2.5 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90"
          >
            Add deck
          </button>
        </div>
      </div>

      {open && def.needsConnect && (
        <div className="mt-4 flex flex-col gap-2 border-t border-line pt-4">
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
            {busy ? 'Connecting…' : 'Connect'}
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
        addWebDeck(r.url, 'VS Code')
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
        <ProviderRow key={def.id} def={def} />
      ))}
      <CodeServerRow />
    </div>
  )
}
