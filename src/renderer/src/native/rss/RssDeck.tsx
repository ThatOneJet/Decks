/**
 * Decks — RSS native deck (renderer process).
 *
 * Renders OUR React UI over the main-process 'rss' provider. RSS needs no auth,
 * so there's no connect flow here: the user pastes feed URLs, we persist them in
 * main (the provider owns the feed list), and we render a merged, date-sorted
 * river of items from every feed.
 *
 * RSS is ACCOUNT-AWARE: each account is a separate FEED COLLECTION, so this deck
 * is scoped to the `accountId` from its props. All I/O goes through
 * `window.decks.provider.fetch({ provider, accountId, … })`; this component never
 * touches the network directly. Styling mirrors the dark theme idiom (bg, txt,
 * line, accent tokens, rounded-xl2) used across the app.
 */
import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { NativeDeckProps } from '../types'

/** Sanitized item shape returned by the main-process RssClient. */
interface RssItem {
  feedTitle: string
  feedUrl: string
  title: string
  link: string
  published: string
  summary: string
}

/** Thin wrapper around the provider IPC, scoped to one account (feed collection). */
async function rssFetch<T>(
  provider: NativeDeckProps['provider'],
  accountId: string,
  resource: string,
  params?: Record<string, unknown>
): Promise<T> {
  const result = await window.decks?.provider.fetch({ provider, accountId, resource, params })
  return result as T
}

/** Compact relative time: "just now", "5m", "3h", "2d", or a short date. */
function relativeTime(iso: string): string {
  if (!iso) return ''
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''
  const diff = Date.now() - then
  if (diff < 0) return 'just now'
  const min = Math.floor(diff / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}d`
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** Short hostname label for a feed URL (used when a feed has no title). */
function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

function RssDeck({ provider, accountId }: NativeDeckProps): JSX.Element {
  const [feeds, setFeeds] = useState<string[]>([])
  const [items, setItems] = useState<RssItem[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /** Reload the merged item river (and surface load errors). */
  const reloadItems = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const next = await rssFetch<RssItem[]>(provider, accountId, 'items')
      setItems(Array.isArray(next) ? next : [])
    } catch {
      setError('Could not load feed items.')
    } finally {
      setLoading(false)
    }
  }, [provider, accountId])

  /** Load the feed list + items on mount. */
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const list = await rssFetch<string[]>(provider, accountId, 'feeds:list')
        if (alive) setFeeds(Array.isArray(list) ? list : [])
      } catch {
        /* feeds:list is non-fatal; items load below still runs */
      }
      await reloadItems()
    })()
    return () => {
      alive = false
    }
  }, [provider, accountId, reloadItems])

  /** Add the pasted feed URL, then refresh the list + items. */
  const addFeed = useCallback(async (): Promise<void> => {
    const url = input.trim()
    if (!url || adding) return
    setAdding(true)
    setError(null)
    try {
      const list = await rssFetch<string[]>(provider, accountId, 'feeds:add', { url })
      setFeeds(Array.isArray(list) ? list : [])
      setInput('')
      await reloadItems()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add that feed.')
    } finally {
      setAdding(false)
    }
  }, [provider, accountId, input, adding, reloadItems])

  /** Remove a feed, then refresh the list + items. */
  const removeFeed = useCallback(
    async (url: string): Promise<void> => {
      setError(null)
      try {
        const list = await rssFetch<string[]>(provider, accountId, 'feeds:remove', { url })
        setFeeds(Array.isArray(list) ? list : [])
        await reloadItems()
      } catch {
        setError('Could not remove that feed.')
      }
    },
    [provider, accountId, reloadItems]
  )

  const openLink = (link: string): void => {
    if (link) window.open(link, '_blank', 'noopener,noreferrer')
  }

  return (
    <div className="flex h-full w-full flex-col bg-bg text-txt-1">
      {/* ── Add-feed row ── */}
      <div className="shrink-0 border-b border-line p-3">
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void addFeed()
          }}
        >
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Paste a feed URL (RSS, Atom, or YouTube channel)…"
            spellCheck={false}
            className="min-w-0 flex-1 rounded-lg border border-line bg-bg-elevated px-3 py-1.5 text-sm text-txt-1 placeholder:text-txt-4 outline-none focus:border-accent focus:ring-1 focus:ring-accent-ring"
          />
          <button
            type="submit"
            disabled={adding || !input.trim()}
            className="shrink-0 rounded-lg border border-line bg-bg-elevated px-3 py-1.5 text-sm font-medium text-txt-1 transition-colors hover:border-accent hover:text-accent disabled:opacity-40 disabled:hover:border-line disabled:hover:text-txt-1"
          >
            {adding ? 'Adding…' : 'Add'}
          </button>
        </form>

        {/* Current feeds as removable chips. */}
        {feeds.length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {feeds.map((url) => (
              <span
                key={url}
                className="inline-flex items-center gap-1 rounded-full border border-line bg-bg-panel py-0.5 pl-2.5 pr-1 text-xs text-txt-2"
                title={url}
              >
                <span className="max-w-[160px] truncate">{hostLabel(url)}</span>
                <button
                  onClick={() => void removeFeed(url)}
                  aria-label={`Remove ${url}`}
                  className="grid h-4 w-4 place-items-center rounded-full text-txt-3 transition-colors hover:bg-bg-elevated hover:text-err"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* ── Error banner ── */}
      {error && (
        <div className="shrink-0 border-b border-line bg-err/10 px-3 py-2 text-xs text-err">
          {error}
        </div>
      )}

      {/* ── Item river ── */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="grid h-full place-items-center p-6 text-sm text-txt-3">Loading…</div>
        ) : items.length === 0 ? (
          <div className="grid h-full place-items-center p-6 text-center">
            <div className="max-w-xs">
              <p className="text-sm font-medium text-txt-1">No items yet</p>
              <p className="mt-1 text-xs leading-relaxed text-txt-3">
                {feeds.length === 0
                  ? 'Add a feed to get started.'
                  : 'These feeds returned nothing — try another one.'}
              </p>
            </div>
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {items.map((it, i) => (
              <li key={`${it.link || it.title}-${i}`} className="px-3 py-2.5 hover:bg-bg-panel">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="truncate text-[11px] font-medium uppercase tracking-wide text-txt-3">
                    {it.feedTitle || hostLabel(it.feedUrl)}
                  </span>
                  {it.published && (
                    <span className="shrink-0 text-[11px] tabular-nums text-txt-4">
                      {relativeTime(it.published)}
                    </span>
                  )}
                </div>

                <button
                  onClick={() => openLink(it.link)}
                  disabled={!it.link}
                  className="mt-0.5 block w-full text-left text-sm font-medium leading-snug text-txt-1 transition-colors hover:text-accent disabled:cursor-default disabled:hover:text-txt-1"
                >
                  {it.title || '(untitled)'}
                </button>

                {it.summary && (
                  <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-txt-2">
                    {it.summary}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

export default RssDeck
