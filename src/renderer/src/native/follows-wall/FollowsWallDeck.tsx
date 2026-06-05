/**
 * FollowsWallDeck — native deck for the 'follows-wall' provider (renderer).
 *
 * Renders a unified, strictly CHRONOLOGICAL timeline of "new from who I follow",
 * aggregated in main from Bluesky timeline + Mastodon home + RSS items (RSS also
 * covers YouTube via per-channel feeds). No algorithm, nothing ranked.
 *
 * It owns no tokens and talks to no service — it asks the main process via
 * `window.decks.provider.fetch({ provider, accountId, resource:'wall' })` (the
 * provider/account identity comes from the host props) and gets back the
 * sanitized, normalized WallItem[] shape.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { NativeDeckProps } from '../types'

/** Mirror of the normalized item shape returned by FollowsWallClient.fetch('wall'). */
interface WallItem {
  source: 'bluesky' | 'mastodon' | 'rss'
  id: string
  author: string
  avatar?: string
  title?: string
  text?: string
  link?: string
  timestamp: string
}

type LoadState = 'loading' | 'ready' | 'error'

/** Per-source badge label + color classes (color-coded, theme-consistent). */
const SOURCE_META: Record<WallItem['source'], { label: string; cls: string }> = {
  bluesky: { label: 'Bluesky', cls: 'bg-[#1185fe]/15 text-[#4aa6ff] ring-[#1185fe]/30' },
  mastodon: { label: 'Mastodon', cls: 'bg-[#6364ff]/15 text-[#9b9cff] ring-[#6364ff]/30' },
  rss: { label: 'RSS', cls: 'bg-warn/15 text-warn ring-warn/30' }
}

/** Compact relative time, e.g. "3m", "5h", "2d", or a date for older items. */
function relTime(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const diff = Date.now() - t
  if (diff < 0) return 'now'
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d`
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** Initials fallback for items without an avatar. */
function initials(name: string): string {
  const parts = name.replace(/^@/, '').trim().split(/[\s.]+/).filter(Boolean)
  if (parts.length === 0) return '?'
  return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase()
}

function SourceBadge({ source }: { source: WallItem['source'] }): JSX.Element {
  const meta = SOURCE_META[source]
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ring-inset ${meta.cls}`}
    >
      {meta.label}
    </span>
  )
}

function Avatar({ item }: { item: WallItem }): JSX.Element {
  if (item.avatar) {
    return (
      <img
        src={item.avatar}
        alt=""
        loading="lazy"
        className="h-8 w-8 shrink-0 rounded-full object-cover ring-1 ring-inset ring-white/10"
      />
    )
  }
  return (
    <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-bg-elevated text-[11px] font-semibold text-txt-3 ring-1 ring-inset ring-white/10">
      {initials(item.author)}
    </div>
  )
}

function Row({ item }: { item: WallItem }): JSX.Element {
  const body = item.title && item.text ? `${item.title} — ${item.text}` : item.title ?? item.text
  return (
    <li className="flex gap-3 border-b border-line px-4 py-3 last:border-b-0 hover:bg-bg-elevated/50">
      <Avatar item={item} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-txt-1">{item.author}</span>
          <SourceBadge source={item.source} />
          <span className="ml-auto shrink-0 text-xs tabular-nums text-txt-3">
            {relTime(item.timestamp)}
          </span>
        </div>
        {body && (
          <p className="mt-0.5 line-clamp-4 whitespace-pre-wrap break-words text-sm leading-relaxed text-txt-2">
            {body}
          </p>
        )}
        {item.source === 'rss' && item.link && (
          <a
            href={item.link}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-block text-xs font-medium text-accent hover:underline"
          >
            Open link ↗
          </a>
        )}
      </div>
    </li>
  )
}

function FollowsWallDeck({ provider, accountId }: NativeDeckProps): JSX.Element {
  const [items, setItems] = useState<WallItem[]>([])
  const [state, setState] = useState<LoadState>('loading')
  const [error, setError] = useState<string>('')
  const alive = useRef(true)

  const load = useCallback(
    async (initial = false): Promise<void> => {
      if (initial) setState('loading')
      try {
        const raw = await window.decks?.provider.fetch({
          provider,
          accountId,
          resource: 'wall'
        })
        const next = Array.isArray(raw) ? (raw as WallItem[]) : []
        if (!alive.current) return
        setItems(next)
        setState('ready')
        setError('')
      } catch (e) {
        if (!alive.current) return
        setError(e instanceof Error ? e.message : 'Failed to load the wall.')
        setState('error')
      }
    },
    [provider, accountId]
  )

  useEffect(() => {
    alive.current = true
    void load(true)
    return () => {
      alive.current = false
    }
  }, [load])

  return (
    <div className="flex h-full w-full flex-col bg-bg">
      {/* Header — ethos + refresh */}
      <header className="flex items-center gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-txt-1">Follows Wall</h2>
          <p className="truncate text-xs text-txt-3">
            Chronological — newest from accounts you follow. No algorithm.
          </p>
        </div>
        <button
          onClick={() => void load(false)}
          disabled={state === 'loading'}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-line bg-bg-elevated text-txt-2 transition-colors hover:text-txt-1 disabled:opacity-40"
          aria-label="Refresh"
          title="Refresh"
        >
          <svg
            viewBox="0 0 24 24"
            className={`h-4 w-4 ${state === 'loading' ? 'animate-spin' : ''}`}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" />
          </svg>
        </button>
      </header>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {state === 'loading' && (
          <div className="grid h-full place-items-center p-6 text-sm text-txt-3">Loading wall…</div>
        )}

        {state === 'error' && (
          <div className="grid h-full place-items-center p-6 text-center">
            <div className="max-w-xs">
              <p className="text-sm font-medium text-err">Couldn’t load the wall</p>
              <p className="mt-1 text-xs leading-relaxed text-txt-3">{error}</p>
              <button
                onClick={() => void load(true)}
                className="mt-3 rounded-lg border border-line bg-bg-elevated px-3 py-1.5 text-xs font-medium text-txt-1 hover:bg-bg-panel"
              >
                Try again
              </button>
            </div>
          </div>
        )}

        {state === 'ready' && items.length === 0 && (
          <div className="grid h-full place-items-center p-6 text-center">
            <div className="max-w-sm">
              <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-xl2 bg-bg-elevated text-txt-3">
                <svg
                  viewBox="0 0 24 24"
                  className="h-6 w-6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16" />
                  <circle cx="5" cy="19" r="1.5" />
                </svg>
              </div>
              <p className="text-sm font-medium text-txt-1">Your wall is empty</p>
              <p className="mt-1 text-xs leading-relaxed text-txt-3">
                Connect Bluesky, Mastodon, or RSS in Settings to see a unified,
                chronological feed of new posts from accounts you follow.
              </p>
            </div>
          </div>
        )}

        {state === 'ready' && items.length > 0 && (
          <ul>
            {items.map((item) => (
              <Row key={item.id} item={item} />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

export default FollowsWallDeck
