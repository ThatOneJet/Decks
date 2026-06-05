/**
 * MastodonDeck — native deck renderer for the Mastodon provider.
 *
 * Renders the connected account's home timeline. Holds NO tokens: it asks main
 * via `window.decks.provider.fetch/status` and renders the sanitized JSON.
 *
 * Mastodon status `content` is HTML. We strip tags to plain text for display
 * (no dangerouslySetInnerHTML) so untrusted markup is never injected.
 * States: loading, not-connected empty state, error, and the scrollable feed.
 */
import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { NativeDeckProps } from '../types'

interface Account {
  acct: string
  displayName: string
  avatar: string
}

interface Reblog {
  account: Account
  content: string
  createdAt: string
  url: string
}

interface MastodonStatus {
  id: string
  account: Account
  content: string
  createdAt: string
  url: string
  reblog?: Reblog
  favouritesCount: number
  reblogsCount: number
  mediaPreview?: string
}

/**
 * Strip HTML to readable plain text WITHOUT rendering markup. Mastodon emits
 * <p>, <br>, and <a> tags; we turn block/line boundaries into newlines, drop the
 * rest, and decode the handful of entities the API uses.
 */
function htmlToText(html: string): string {
  if (!html) return ''
  const withBreaks = html
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
  const stripped = withBreaks.replace(/<[^>]*>/g, '')
  const decoded = stripped
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
  return decoded.replace(/\n{3,}/g, '\n\n').trim()
}

/** Compact relative time, e.g. "3m", "5h", "2d", or a short date. */
function relativeTime(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const diff = Date.now() - t
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return `${Math.max(sec, 0)}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}d`
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function Avatar({ account }: { account: Account }): JSX.Element {
  const initial = (account.displayName || account.acct || '?').charAt(0).toUpperCase()
  if (account.avatar) {
    return (
      <img
        src={account.avatar}
        alt=""
        className="h-9 w-9 shrink-0 rounded-full object-cover"
        loading="lazy"
      />
    )
  }
  return (
    <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-bg-elevated text-sm font-semibold text-txt-2">
      {initial}
    </div>
  )
}

function StatusCard({ status }: { status: MastodonStatus }): JSX.Element {
  // A boost: show the booster line, then render the boosted status' content.
  const boosted = status.reblog
  const display: { account: Account; content: string; createdAt: string } = boosted
    ? { account: boosted.account, content: boosted.content, createdAt: boosted.createdAt }
    : { account: status.account, content: status.content, createdAt: status.createdAt }
  const text = htmlToText(display.content)

  return (
    <article className="border-b border-line px-4 py-3">
      {boosted && (
        <div className="mb-1.5 flex items-center gap-1.5 pl-12 text-xs text-txt-3">
          <svg
            viewBox="0 0 24 24"
            className="h-3.5 w-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M17 1l4 4-4 4" />
            <path d="M3 11V9a4 4 0 0 1 4-4h14" />
            <path d="M7 23l-4-4 4-4" />
            <path d="M21 13v2a4 4 0 0 1-4 4H3" />
          </svg>
          <span className="truncate">
            {status.account.displayName || status.account.acct} boosted
          </span>
        </div>
      )}
      <div className="flex gap-3">
        <Avatar account={display.account} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <span className="truncate text-sm font-semibold text-txt-1">
              {display.account.displayName || display.account.acct}
            </span>
            <span className="truncate text-xs text-txt-3">@{display.account.acct}</span>
            <span className="ml-auto shrink-0 text-xs text-txt-3">
              {relativeTime(display.createdAt)}
            </span>
          </div>
          {text && (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-txt-1">
              {text}
            </p>
          )}
          {status.mediaPreview && (
            <img
              src={status.mediaPreview}
              alt=""
              className="mt-2 max-h-72 w-full rounded-xl2 border border-line object-cover"
              loading="lazy"
            />
          )}
          <div className="mt-2 flex items-center gap-5 text-xs text-txt-3">
            <span className="flex items-center gap-1 tabular-nums">
              <svg
                viewBox="0 0 24 24"
                className="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M17 1l4 4-4 4" />
                <path d="M3 11V9a4 4 0 0 1 4-4h14" />
                <path d="M7 23l-4-4 4-4" />
                <path d="M21 13v2a4 4 0 0 1-4 4H3" />
              </svg>
              {status.reblogsCount}
            </span>
            <span className="flex items-center gap-1 tabular-nums">
              <svg
                viewBox="0 0 24 24"
                className="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 1 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z" />
              </svg>
              {status.favouritesCount}
            </span>
          </div>
        </div>
      </div>
    </article>
  )
}

function MastodonDeck({ provider, accountId }: NativeDeckProps): JSX.Element {
  const [connected, setConnected] = useState<boolean | null>(null)
  const [account, setAccount] = useState<string | undefined>(undefined)
  const [statuses, setStatuses] = useState<MastodonStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const status = await window.decks.provider.status(provider, accountId)
      setConnected(status.connected)
      setAccount(status.account)
      if (!status.connected) {
        setStatuses([])
        return
      }
      const data = (await window.decks.provider.fetch({
        provider,
        accountId,
        resource: 'home'
      })) as MastodonStatus[]
      setStatuses(Array.isArray(data) ? data : [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your timeline.')
    } finally {
      setLoading(false)
    }
  }, [provider, accountId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <div className="flex h-full w-full flex-col bg-bg">
      <header className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <span className="text-sm font-semibold text-txt-1">Mastodon</span>
        {account && <span className="truncate text-xs text-txt-3">{account}</span>}
        <button
          onClick={() => void refresh()}
          disabled={loading}
          className="ml-auto grid h-7 w-7 place-items-center rounded-lg border border-line bg-bg-elevated text-txt-2 transition-colors hover:text-txt-1 disabled:opacity-40"
          aria-label="Refresh"
          title="Refresh"
        >
          <svg
            viewBox="0 0 24 24"
            className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M23 4v6h-6M1 20v-6h6" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && statuses.length === 0 ? (
          <div className="grid h-full place-items-center text-sm text-txt-3">Loading…</div>
        ) : error ? (
          <div className="grid h-full place-items-center p-6 text-center">
            <div className="max-w-xs">
              <p className="text-sm text-err">{error}</p>
              <button
                onClick={() => void refresh()}
                className="mt-3 rounded-lg border border-line bg-bg-elevated px-3 py-1.5 text-xs text-txt-2 transition-colors hover:text-txt-1"
              >
                Try again
              </button>
            </div>
          </div>
        ) : connected === false ? (
          <div className="grid h-full place-items-center p-6 text-center">
            <div className="max-w-xs">
              <div className="text-sm font-medium text-txt-1">Not connected</div>
              <p className="mt-1 text-xs leading-relaxed text-txt-3">
                Connect Mastodon with your instance URL and an access token to see your home
                timeline here.
              </p>
            </div>
          </div>
        ) : statuses.length === 0 ? (
          <div className="grid h-full place-items-center p-6 text-center text-sm text-txt-3">
            Your timeline is empty.
          </div>
        ) : (
          statuses.map((s) => <StatusCard key={s.id} status={s} />)
        )}
      </div>
    </div>
  )
}

export default MastodonDeck
