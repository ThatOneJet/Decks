/**
 * BlueskyDeck — native deck renderer for the Bluesky provider.
 *
 * Renders the connected account's home timeline. Holds NO tokens: it asks main
 * via `window.decks.provider.fetch/status` and renders the sanitized JSON.
 * States: loading, not-connected empty state, error, and the scrollable feed.
 */
import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { NativeDeckProps } from '../types'

interface Author {
  handle: string
  displayName: string
  avatar: string
}

interface BlueskyPost {
  uri: string
  author: Author
  text: string
  createdAt: string
  likeCount: number
  repostCount: number
  replyCount: number
  embedImage?: string
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

/** Inline icon set (stroke = currentColor) for the post action counters. */
function CountIcon({ kind }: { kind: 'reply' | 'repost' | 'like' }): JSX.Element {
  const common = {
    viewBox: '0 0 24 24',
    className: 'h-3.5 w-3.5',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const
  }
  if (kind === 'reply') {
    return (
      <svg {...common}>
        <path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7A8.38 8.38 0 0 1 4 11.5 8.5 8.5 0 0 1 12.5 3 8.38 8.38 0 0 1 21 11.5z" />
      </svg>
    )
  }
  if (kind === 'repost') {
    return (
      <svg {...common}>
        <path d="M17 1l4 4-4 4" />
        <path d="M3 11V9a4 4 0 0 1 4-4h14" />
        <path d="M7 23l-4-4 4-4" />
        <path d="M21 13v2a4 4 0 0 1-4 4H3" />
      </svg>
    )
  }
  return (
    <svg {...common}>
      <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 1 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z" />
    </svg>
  )
}

function Avatar({ author }: { author: Author }): JSX.Element {
  const initial = (author.displayName || author.handle || '?').charAt(0).toUpperCase()
  if (author.avatar) {
    return (
      <img
        src={author.avatar}
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

function PostCard({ post }: { post: BlueskyPost }): JSX.Element {
  return (
    <article className="flex gap-3 border-b border-line px-4 py-3">
      <Avatar author={post.author} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className="truncate text-sm font-semibold text-txt-1">
            {post.author.displayName || post.author.handle}
          </span>
          <span className="truncate text-xs text-txt-3">@{post.author.handle}</span>
          <span className="ml-auto shrink-0 text-xs text-txt-3">{relativeTime(post.createdAt)}</span>
        </div>
        {post.text && (
          <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-txt-1">
            {post.text}
          </p>
        )}
        {post.embedImage && (
          <img
            src={post.embedImage}
            alt=""
            className="mt-2 max-h-72 w-full rounded-xl2 border border-line object-cover"
            loading="lazy"
          />
        )}
        <div className="mt-2 flex items-center gap-5 text-xs text-txt-3">
          <span className="flex items-center gap-1 tabular-nums">
            <CountIcon kind="reply" />
            {post.replyCount}
          </span>
          <span className="flex items-center gap-1 tabular-nums">
            <CountIcon kind="repost" />
            {post.repostCount}
          </span>
          <span className="flex items-center gap-1 tabular-nums">
            <CountIcon kind="like" />
            {post.likeCount}
          </span>
        </div>
      </div>
    </article>
  )
}

function BlueskyDeck({ provider, accountId }: NativeDeckProps): JSX.Element {
  const [connected, setConnected] = useState<boolean | null>(null)
  const [account, setAccount] = useState<string | undefined>(undefined)
  const [posts, setPosts] = useState<BlueskyPost[]>([])
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
        setPosts([])
        return
      }
      const data = (await window.decks.provider.fetch({
        provider,
        accountId,
        resource: 'timeline'
      })) as BlueskyPost[]
      setPosts(Array.isArray(data) ? data : [])
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
        <span className="text-sm font-semibold text-txt-1">Bluesky</span>
        {account && <span className="truncate text-xs text-txt-3">@{account}</span>}
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
        {loading && posts.length === 0 ? (
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
                Connect Bluesky with your handle and an app password to see your timeline here.
              </p>
            </div>
          </div>
        ) : posts.length === 0 ? (
          <div className="grid h-full place-items-center p-6 text-center text-sm text-txt-3">
            Your timeline is empty.
          </div>
        ) : (
          posts.map((p) => <PostCard key={p.uri} post={p} />)
        )}
      </div>
    </div>
  )
}

export default BlueskyDeck
