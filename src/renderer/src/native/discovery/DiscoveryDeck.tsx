/**
 * DiscoveryDeck — native deck for the 'discovery' provider (renderer).
 *
 * A cross-service "Discover" board: fresh / notable items pulled from EVERY
 * connected service, grouped into titled SECTIONS (Spotify "Listen again", RSS
 * "New to read & watch", Bluesky / Mastodon "From your network", GitHub repos,
 * Canvas "Don't forget"). It owns no tokens and talks to no service — it asks
 * main via `window.decks.provider.fetch({ provider, accountId, resource:'board' })`
 * and gets back the sanitized, normalized DiscoverBoard shape.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { NativeDeckProps } from '../types'

type DiscoverSource = 'spotify' | 'rss' | 'bluesky' | 'mastodon' | 'github' | 'canvas'

/** Mirror of the normalized item shape returned by DiscoveryClient.fetch('board'). */
interface DiscoverItem {
  id: string
  title: string
  subtitle?: string
  image?: string
  link?: string
  timestamp?: string
}

interface DiscoverSection {
  source: DiscoverSource
  title: string
  items: DiscoverItem[]
}

interface DiscoverBoard {
  sections: DiscoverSection[]
}

type LoadState = 'loading' | 'ready' | 'error'

/** Per-source badge label + color classes (color-coded, theme-consistent). */
const SOURCE_META: Record<DiscoverSource, { label: string; cls: string }> = {
  spotify: { label: 'Spotify', cls: 'bg-[#1db954]/15 text-[#3fdc78] ring-[#1db954]/30' },
  rss: { label: 'RSS', cls: 'bg-warn/15 text-warn ring-warn/30' },
  bluesky: { label: 'Bluesky', cls: 'bg-[#1185fe]/15 text-[#4aa6ff] ring-[#1185fe]/30' },
  mastodon: { label: 'Mastodon', cls: 'bg-[#6364ff]/15 text-[#9b9cff] ring-[#6364ff]/30' },
  github: { label: 'GitHub', cls: 'bg-white/10 text-txt-2 ring-white/15' },
  canvas: { label: 'Canvas', cls: 'bg-[#e2484d]/15 text-[#ff7a7e] ring-[#e2484d]/30' }
}

/** Compact relative time, e.g. "3m", "5h", "2d", or a date for older items. */
function relTime(iso: string | undefined): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const diff = Date.now() - t
  if (diff < 0) return 'soon'
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

function openLink(link: string | undefined): void {
  if (link) window.open(link, '_blank', 'noopener,noreferrer')
}

function SourceBadge({ source }: { source: DiscoverSource }): JSX.Element {
  const meta = SOURCE_META[source]
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ring-inset ${meta.cls}`}
    >
      {meta.label}
    </span>
  )
}

function Card({ item }: { item: DiscoverItem }): JSX.Element {
  const clickable = Boolean(item.link)
  const rel = relTime(item.timestamp)
  return (
    <button
      type="button"
      onClick={() => openLink(item.link)}
      disabled={!clickable}
      title={item.title}
      className={`flex w-44 shrink-0 flex-col overflow-hidden rounded-xl border border-line bg-bg-elevated text-left transition-colors ${
        clickable ? 'hover:border-accent' : 'cursor-default'
      }`}
    >
      {item.image ? (
        <img
          src={item.image}
          alt=""
          loading="lazy"
          className="h-28 w-full object-cover"
        />
      ) : (
        <div className="grid h-28 w-full place-items-center bg-bg-panel text-txt-4">
          <svg
            viewBox="0 0 24 24"
            className="h-7 w-7"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="9" />
            <path d="m15 9-3 6-3-3" />
          </svg>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1 p-2.5">
        <span className="line-clamp-2 text-xs font-medium leading-snug text-txt-1">
          {item.title}
        </span>
        {item.subtitle && (
          <span className="line-clamp-2 text-[11px] leading-snug text-txt-3">{item.subtitle}</span>
        )}
        {rel && <span className="mt-auto text-[10px] tabular-nums text-txt-4">{rel}</span>}
      </div>
    </button>
  )
}

function Section({ section }: { section: DiscoverSection }): JSX.Element {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2 px-4">
        <h3 className="text-sm font-semibold text-txt-1">{section.title}</h3>
        <SourceBadge source={section.source} />
      </div>
      <div className="flex gap-3 overflow-x-auto px-4 pb-1">
        {section.items.map((item) => (
          <Card key={item.id} item={item} />
        ))}
      </div>
    </section>
  )
}

function DiscoveryDeck({ provider, accountId }: NativeDeckProps): JSX.Element {
  const [sections, setSections] = useState<DiscoverSection[]>([])
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
          resource: 'board'
        })
        const board = (raw ?? {}) as Partial<DiscoverBoard>
        const next = Array.isArray(board.sections) ? board.sections : []
        if (!alive.current) return
        setSections(next)
        setState('ready')
        setError('')
      } catch (e) {
        if (!alive.current) return
        setError(e instanceof Error ? e.message : 'Failed to load Discover.')
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
          <h2 className="text-sm font-semibold text-txt-1">Discover</h2>
          <p className="truncate text-xs text-txt-3">
            What&apos;s new and notable across your connected services.
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
      <div className="min-h-0 flex-1 overflow-y-auto py-4">
        {state === 'loading' && (
          <div className="grid h-full place-items-center p-6 text-sm text-txt-3">
            Loading Discover…
          </div>
        )}

        {state === 'error' && (
          <div className="grid h-full place-items-center p-6 text-center">
            <div className="max-w-xs">
              <p className="text-sm font-medium text-err">Couldn&apos;t load Discover</p>
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

        {state === 'ready' && sections.length === 0 && (
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
                  <circle cx="11" cy="11" r="7" />
                  <path d="m21 21-4.3-4.3" />
                </svg>
              </div>
              <p className="text-sm font-medium text-txt-1">Nothing to discover yet</p>
              <p className="mt-1 text-xs leading-relaxed text-txt-3">
                Connect Spotify, RSS, Bluesky, Mastodon, GitHub, or Canvas in Settings, and
                Discover will surface fresh and notable items from across your services here.
              </p>
            </div>
          </div>
        )}

        {state === 'ready' && sections.length > 0 && (
          <div className="flex flex-col gap-6">
            {sections.map((section) => (
              <Section key={section.source} section={section} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default DiscoveryDeck
