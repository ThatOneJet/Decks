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

function RepoRow({ r }: { r: GhRepo }): JSX.Element {
  const inner = (
    <div className="rounded-lg border border-line bg-bg-elevated px-3 py-2.5 transition-colors hover:border-accent-ring">
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
    </div>
  )

  if (r.htmlUrl) {
    return (
      <a href={r.htmlUrl} target="_blank" rel="noreferrer" className="block">
        {inner}
      </a>
    )
  }
  return inner
}

export default function GithubDeck({ provider, accountId }: NativeDeckProps): JSX.Element {
  const [state, setState] = useState<LoadState>('loading')
  const [account, setAccount] = useState<string | undefined>(undefined)
  const [data, setData] = useState<GithubDashboard | null>(null)
  const [error, setError] = useState<string>('')
  const [tab, setTab] = useState<Tab>('notifications')

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
              <RepoRow key={r.id ?? `${r.fullName ?? 'r'}-${i}`} r={r} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
