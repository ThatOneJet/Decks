/**
 * Decks — GitHub native deck (renderer process).
 *
 * Renders OUR React UI over the GitHub provider inside a deck card body. It never
 * holds the token or talks to GitHub directly — it asks main via
 * `window.decks.provider.status(provider, accountId)` and
 * `window.decks.provider.fetch({ provider, accountId, resource: 'dashboard' })`
 * and renders the sanitized JSON it gets back.
 *
 * Two tabs: Notifications (inbox list with reason + repo) and Repositories
 * (recently-updated repos with a language dot + star count). Loading, not-
 * connected, and error states. Body is scrollable. Matches the dark theme tokens.
 */
import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { NativeDeckProps } from '../types'

/* ── Shapes mirrored from the main-process GithubClient.fetch('dashboard') ── */

interface GhNotification {
  id?: string
  reason?: string
  title?: string
  repo?: string
  type?: string
  updatedAt?: string
  url?: string
}

interface GhRepo {
  id?: number
  fullName?: string
  description?: string
  stars?: number
  language?: string
  htmlUrl?: string
  updatedAt?: string
  private?: boolean
}

interface GithubDashboard {
  notifications: GhNotification[]
  repos: GhRepo[]
}

type LoadState = 'loading' | 'disconnected' | 'ready' | 'error'
type Tab = 'notifications' | 'repos'

/* ── Helpers ── */

/** Format an ISO date as a short relative-ish label; '' when missing/invalid. */
function formatWhen(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** Humanize a notification reason (e.g. "review_requested" → "Review requested"). */
function formatReason(reason?: string): string {
  if (!reason) return ''
  const s = reason.replace(/_/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** A stable, lightly-varied color for a language dot, derived from its name. */
function languageColor(language?: string): string {
  if (!language) return '#6f6f80'
  let hash = 0
  for (let i = 0; i < language.length; i++) hash = (hash * 31 + language.charCodeAt(i)) >>> 0
  const hue = hash % 360
  return `hsl(${hue} 60% 55%)`
}

/* ── UI bits ── */

function Spinner(): JSX.Element {
  return (
    <svg className="h-5 w-5 animate-spin text-txt-3" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path
        className="opacity-90"
        d="M22 12a10 10 0 0 1-10 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  )
}

function CenterMessage({
  title,
  body,
  children
}: {
  title: string
  body?: string
  children?: React.ReactNode
}): JSX.Element {
  return (
    <div className="grid h-full w-full place-items-center bg-bg p-6 text-center">
      <div className="max-w-sm">
        <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-xl2 bg-bg-elevated text-txt-3">
          {children ?? (
            <svg viewBox="0 0 24 24" className="h-6 w-6" fill="currentColor">
              <path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.1.68-.22.68-.49 0-.24-.01-.88-.01-1.73-2.78.62-3.37-1.21-3.37-1.21-.46-1.18-1.11-1.49-1.11-1.49-.91-.64.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.89 1.56 2.34 1.11 2.91.85.09-.66.35-1.11.63-1.37-2.22-.26-4.55-1.14-4.55-5.06 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.7 0 0 .84-.28 2.75 1.05a9.3 9.3 0 0 1 5 0c1.91-1.33 2.75-1.05 2.75-1.05.55 1.4.2 2.44.1 2.7.64.72 1.03 1.63 1.03 2.75 0 3.93-2.34 4.79-4.57 5.05.36.32.68.94.68 1.9 0 1.37-.01 2.47-.01 2.81 0 .27.18.6.69.49A10.04 10.04 0 0 0 22 12.25C22 6.58 17.52 2 12 2z" />
            </svg>
          )}
        </div>
        <div className="text-sm font-medium text-txt-1">{title}</div>
        {body && <p className="mt-1 text-xs leading-relaxed text-txt-3">{body}</p>}
      </div>
    </div>
  )
}

function NotificationRow({ n }: { n: GhNotification }): JSX.Element {
  const when = formatWhen(n.updatedAt)
  const inner = (
    <div className="rounded-lg border border-line bg-bg-elevated px-3 py-2.5 transition-colors hover:border-accent-ring">
      <div className="truncate text-sm font-medium text-txt-1">{n.title || 'Notification'}</div>
      <div className="mt-0.5 flex items-center gap-2 text-xs">
        <span className="text-accent">{formatReason(n.reason)}</span>
        {n.repo && (
          <>
            <span className="text-txt-4">·</span>
            <span className="truncate text-txt-3">{n.repo}</span>
          </>
        )}
        {when && (
          <>
            <span className="text-txt-4">·</span>
            <span className="shrink-0 text-txt-4">{when}</span>
          </>
        )}
      </div>
    </div>
  )

  if (n.url) {
    return (
      <a href={n.url} target="_blank" rel="noreferrer" className="block">
        {inner}
      </a>
    )
  }
  return inner
}

function RepoRow({ r, onOpen }: { r: GhRepo; onOpen: (fullName: string) => void }): JSX.Element {
  return (
    <button
      type="button"
      onClick={() => r.fullName && onOpen(r.fullName)}
      className="block w-full rounded-lg border border-line bg-bg-elevated px-3 py-2.5 text-left transition-colors hover:border-accent-ring">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium text-txt-1">{r.fullName || 'Repository'}</span>
        {r.private && (
          <span className="shrink-0 rounded-full border border-line px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-txt-4">
            Private
          </span>
        )}
      </div>
      {r.description && (
        <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-txt-3">{r.description}</p>
      )}
      <div className="mt-1.5 flex items-center gap-3 text-xs text-txt-4">
        {r.language && (
          <span className="flex items-center gap-1.5">
            <span
              className="h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: languageColor(r.language) }}
            />
            <span className="text-txt-3">{r.language}</span>
          </span>
        )}
        {typeof r.stars === 'number' && r.stars > 0 && (
          <span className="flex items-center gap-1">
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor">
              <path d="M12 2.5l2.9 5.9 6.5.95-4.7 4.58 1.1 6.47L12 17.9l-5.8 3.05 1.1-6.47-4.7-4.58 6.5-.95z" />
            </svg>
            <span className="tabular-nums">{r.stars}</span>
          </span>
        )}
      </div>
    </button>
  )
}

/* ── Repo browser (in-app file tree + file viewer + README) ── */

interface DirEntry {
  name: string
  path: string
  type: 'dir' | 'file'
  size: number
}
type RepoContents =
  | { kind: 'dir'; path: string; entries: DirEntry[] }
  | { kind: 'file'; name: string; path: string; text?: string; tooBig?: boolean; htmlUrl?: string }

function FileIcon({ dir }: { dir: boolean }): JSX.Element {
  return dir ? (
    <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 text-accent" fill="currentColor">
      <path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 text-txt-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  )
}

function RepoView({
  provider,
  accountId,
  fullName,
  onBack
}: {
  provider: NativeDeckProps['provider']
  accountId: string
  fullName: string
  onBack: () => void
}): JSX.Element {
  const [path, setPath] = useState('')
  const [node, setNode] = useState<RepoContents | null>(null)
  const [readme, setReadme] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError('')
    void (async () => {
      try {
        const res = (await window.decks?.provider.fetch({
          provider,
          accountId,
          resource: 'repoContents',
          params: { fullName, path }
        })) as RepoContents | undefined
        if (!alive) return
        setNode(res ?? null)
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : 'Failed to load repository.')
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [provider, accountId, fullName, path])

  // README only for the repo root.
  useEffect(() => {
    if (path !== '') {
      setReadme('')
      return
    }
    let alive = true
    void (async () => {
      const r = (await window.decks?.provider
        .fetch({ provider, accountId, resource: 'repoReadme', params: { fullName } })
        .catch(() => null)) as { text?: string } | null
      if (alive) setReadme(r?.text ?? '')
    })()
    return () => {
      alive = false
    }
  }, [provider, accountId, fullName, path])

  const crumbs = path ? path.split('/') : []

  return (
    <div className="flex h-full w-full flex-col bg-bg">
      <header className="shrink-0 border-b border-line px-4 py-3">
        <div className="flex items-center gap-2">
          <button
            onClick={onBack}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-line bg-bg-elevated text-txt-3 transition-colors hover:text-txt-1"
            title="Back to repositories"
            aria-label="Back"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-txt-1">{fullName}</h2>
        </div>
        {/* Breadcrumb */}
        <div className="mt-2 flex flex-wrap items-center gap-1 text-xs">
          <button onClick={() => setPath('')} className="text-accent hover:underline">
            root
          </button>
          {crumbs.map((seg, i) => {
            const to = crumbs.slice(0, i + 1).join('/')
            return (
              <span key={to} className="flex items-center gap-1">
                <span className="text-txt-4">/</span>
                <button onClick={() => setPath(to)} className="text-txt-2 hover:text-accent">
                  {seg}
                </button>
              </span>
            )
          })}
        </div>
      </header>

      <div className="flex-1 overflow-auto px-4 py-4">
        {loading ? (
          <div className="grid place-items-center py-10">
            <Spinner />
          </div>
        ) : error ? (
          <p className="text-xs text-err">{error}</p>
        ) : node?.kind === 'file' ? (
          node.tooBig ? (
            <p className="text-xs text-txt-4">
              This file is binary or too large to preview here.{' '}
              {node.htmlUrl && (
                <a href={node.htmlUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                  Open on GitHub
                </a>
              )}
            </p>
          ) : (
            <pre className="overflow-auto rounded-lg border border-line bg-bg-elevated p-3 font-mono text-[11px] leading-relaxed text-txt-2">
              {node.text}
            </pre>
          )
        ) : node?.kind === 'dir' ? (
          <>
            <div className="flex flex-col gap-0.5">
              {node.entries.map((e) => (
                <button
                  key={e.path}
                  onClick={() => setPath(e.path)}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-bg-elevated"
                >
                  <FileIcon dir={e.type === 'dir'} />
                  <span className="min-w-0 flex-1 truncate text-xs text-txt-1">{e.name}</span>
                </button>
              ))}
            </div>
            {path === '' && readme && (
              <div className="mt-5">
                <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-txt-4">
                  README
                </div>
                <pre className="overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-bg-elevated p-3 text-[12px] leading-relaxed text-txt-2">
                  {readme}
                </pre>
              </div>
            )}
          </>
        ) : (
          <p className="text-xs text-txt-4">Nothing here.</p>
        )}
      </div>
    </div>
  )
}

export default function GithubDeck({ provider, accountId }: NativeDeckProps): JSX.Element {
  const [state, setState] = useState<LoadState>('loading')
  const [account, setAccount] = useState<string | undefined>(undefined)
  const [data, setData] = useState<GithubDashboard | null>(null)
  const [error, setError] = useState<string>('')
  const [tab, setTab] = useState<Tab>('repos')
  const [openRepo, setOpenRepo] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setState('loading')
    setError('')
    try {
      const status = await window.decks?.provider.status(provider, accountId)
      if (!status?.connected) {
        setState('disconnected')
        return
      }
      setAccount(status.account)

      const result = (await window.decks?.provider.fetch({
        provider,
        accountId,
        resource: 'dashboard'
      })) as GithubDashboard | undefined

      setData({
        notifications: Array.isArray(result?.notifications) ? result!.notifications : [],
        repos: Array.isArray(result?.repos) ? result!.repos : []
      })
      setState('ready')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load GitHub data')
      setState('error')
    }
  }, [provider, accountId])

  useEffect(() => {
    void load()
  }, [load])

  if (state === 'loading') {
    return (
      <div className="grid h-full w-full place-items-center bg-bg">
        <Spinner />
      </div>
    )
  }

  if (state === 'disconnected') {
    return (
      <CenterMessage
        title="Connect GitHub in Settings"
        body="Add a personal access token (or sign in with OAuth) to see your notifications and repositories here."
      />
    )
  }

  if (state === 'error') {
    return (
      <CenterMessage title="Couldn't load GitHub" body={error}>
        <svg
          viewBox="0 0 24 24"
          className="h-6 w-6 text-err"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 9v4M12 17h.01" />
          <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
        </svg>
      </CenterMessage>
    )
  }

  if (openRepo) {
    return (
      <RepoView
        provider={provider}
        accountId={accountId}
        fullName={openRepo}
        onBack={() => setOpenRepo(null)}
      />
    )
  }

  const dash = data ?? { notifications: [], repos: [] }

  return (
    <div className="flex h-full w-full flex-col bg-bg">
      {/* Header */}
      <header className="shrink-0 border-b border-line px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-txt-1">GitHub</h2>
            {account && <p className="truncate text-xs text-txt-3">{account}</p>}
          </div>
          <button
            onClick={() => void load()}
            className="grid h-7 w-7 place-items-center rounded-lg border border-line bg-bg-elevated text-txt-3 transition-colors hover:text-txt-1"
            aria-label="Refresh"
            title="Refresh"
          >
            <svg
              viewBox="0 0 24 24"
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6" />
            </svg>
          </button>
        </div>

        {/* Tabs */}
        <div className="mt-3 flex gap-1">
          {(
            [
              { id: 'notifications', label: `Notifications${dash.notifications.length ? ` (${dash.notifications.length})` : ''}` },
              { id: 'repos', label: 'Repositories' }
            ] as { id: Tab; label: string }[]
          ).map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                tab === t.id
                  ? 'bg-accent-soft text-txt-1'
                  : 'text-txt-3 hover:text-txt-1'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </header>

      {/* Scrollable body */}
      <div className="flex-1 overflow-auto px-4 py-4">
        {tab === 'notifications' ? (
          dash.notifications.length === 0 ? (
            <p className="text-xs text-txt-4">No notifications. You're all caught up.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {dash.notifications.map((n, i) => (
                <NotificationRow key={n.id ?? `${n.title ?? 'n'}-${i}`} n={n} />
              ))}
            </div>
          )
        ) : dash.repos.length === 0 ? (
          <p className="text-xs text-txt-4">No repositories found.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {dash.repos.map((r, i) => (
              <RepoRow key={r.id ?? `${r.fullName ?? 'r'}-${i}`} r={r} onOpen={setOpenRepo} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
