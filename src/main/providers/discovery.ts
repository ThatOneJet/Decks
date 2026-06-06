/**
 * Decks — Discover provider (main process).
 *
 * A cross-service "what's new / notable" board. Like the Follows Wall it owns NO
 * token and imports NO sibling provider file — it aggregates ONLY at RUNTIME via
 * the registry (`getProvider`), across EVERY connected account of each source
 * provider (sources are account-aware). Where the wall is one flat chronological
 * river, Discover is FRAMED AS DISCOVERY: a set of titled SECTIONS surfacing
 * fresh/notable items per service, e.g.:
 *   - Spotify  → playlists / recently played   ("Listen again")
 *   - RSS      → newest items                   ("New to read & watch")
 *   - Bluesky  → notable recent posts           ("From your network · Bluesky")
 *   - Mastodon → notable recent posts           ("From your network · Mastodon")
 *   - GitHub   → recently-updated repos         ("Fresh in your repos")
 *   - Canvas   → due-soon assignments / to-dos  ("Don't forget")
 *
 * PARALLEL-SAFETY: every probe is isolated (Promise.allSettled + optional
 * chaining + defensive readers). A source that is absent, disconnected, or
 * failing is simply skipped — it never sinks the board. Sub-results are of
 * unknown shape and read defensively, so this stays compilable while the source
 * clients are written/changed concurrently.
 */
import type { ProviderClient } from './types'
import type { ProviderId, ProviderStatus, AccountSummary } from '@shared/types'
import { getProvider } from './registry'

/** The source providers Discover aggregates, in a stable display order. */
type DiscoverSource = 'spotify' | 'rss' | 'bluesky' | 'mastodon' | 'github' | 'canvas'

const SOURCES: DiscoverSource[] = ['spotify', 'rss', 'bluesky', 'mastodon', 'github', 'canvas']

/** One normalized card in a section. Sub-provider shapes never leak past here. */
export interface DiscoverItem {
  id: string
  title: string
  subtitle?: string
  image?: string
  link?: string
  /** ISO-8601 timestamp when meaningful (used for "fresh" sorting). */
  timestamp?: string
}

/** A titled group of cards from one source. */
export interface DiscoverSection {
  source: DiscoverSource
  title: string
  items: DiscoverItem[]
}

/** The board shape the renderer consumes. */
export interface DiscoverBoard {
  sections: DiscoverSection[]
}

/** Cap on items shown per section. */
const MAX_PER_SECTION = 12

/** The single implicit account this board exposes. */
const DEFAULT_ACCOUNT_ID = 'default'

/* ────────────────────────── defensive readers ────────────────────────── */

/** Coerce anything that might be an array (or a wrapper object) to an array. */
function asArray(x: unknown): unknown[] {
  if (Array.isArray(x)) return x
  if (x && typeof x === 'object') {
    const o = x as Record<string, unknown>
    for (const key of ['items', 'feed', 'posts', 'data', 'results', 'timeline', 'repos']) {
      if (Array.isArray(o[key])) return o[key] as unknown[]
    }
  }
  return []
}

/** Read the first present, non-empty string among dotted/plain keys of `obj`. */
function pick(obj: unknown, ...keys: string[]): string | undefined {
  if (!obj || typeof obj !== 'object') return undefined
  const o = obj as Record<string, unknown>
  for (const key of keys) {
    const v = key.includes('.') ? dig(o, key) : o[key]
    if (typeof v === 'string' && v.trim() !== '') return v
    if (typeof v === 'number') return String(v)
  }
  return undefined
}

/** Resolve a dotted path (e.g. 'author.handle') defensively. */
function dig(obj: Record<string, unknown>, path: string): unknown {
  let cur: unknown = obj
  for (const part of path.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

/** First non-empty string in an array-valued field (e.g. spotify `artists`). */
function firstStr(obj: unknown, key: string): string | undefined {
  if (!obj || typeof obj !== 'object') return undefined
  const v = (obj as Record<string, unknown>)[key]
  if (Array.isArray(v)) {
    const s = v.find((x) => typeof x === 'string' && x.trim() !== '')
    return typeof s === 'string' ? s : undefined
  }
  return undefined
}

/** Join an array-valued string field with commas (e.g. all artists). */
function joinStr(obj: unknown, key: string): string | undefined {
  if (!obj || typeof obj !== 'object') return undefined
  const v = (obj as Record<string, unknown>)[key]
  if (Array.isArray(v)) {
    const parts = v.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    return parts.length ? parts.join(', ') : undefined
  }
  return undefined
}

/** Strip HTML tags + collapse whitespace into a plain snippet. */
function plain(html: string | undefined): string | undefined {
  if (!html) return undefined
  const text = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
  return text === '' ? undefined : text
}

/** Coerce a value to an ISO timestamp, or undefined when unparseable/missing. */
function toIso(value: string | undefined): string | undefined {
  if (!value) return undefined
  const t = Date.parse(value)
  if (Number.isNaN(t)) return undefined
  return new Date(t).toISOString()
}

/** Sort key for "fresh first" — newer timestamps rank higher; undated sink. */
function freshKey(ts: string | undefined): number {
  if (!ts) return 0
  const t = Date.parse(ts)
  return Number.isNaN(t) ? 0 : t
}

/** Stable-ish id for an item, scoped by source so ids never collide. */
function itemId(source: DiscoverSource, raw: unknown, fallback: string): string {
  const id = pick(raw, 'id', 'uri', 'cid', 'guid', 'link', 'url', 'htmlUrl', 'fullName')
  return `${source}:${id ?? fallback}`
}

/** Coerce a sub-provider's listAccounts() result to a safe AccountSummary[]. */
function asAccounts(x: unknown): AccountSummary[] {
  if (!Array.isArray(x)) return []
  return x.filter(
    (a): a is AccountSummary =>
      Boolean(a) && typeof a === 'object' && typeof (a as AccountSummary).id === 'string'
  )
}

/* ────────────────────────── per-source builders ──────────────────────── */

/**
 * One builder per source: fetch a sensible "discovery" resource for one account
 * and normalize its rows into DiscoverItem[]. Builders never throw — the caller
 * isolates them — but they read fully defensively anyway.
 */
type Builder = (client: ProviderClient, accountId: string) => Promise<DiscoverItem[]>

const SECTION_TITLE: Record<DiscoverSource, string> = {
  spotify: 'Listen again',
  rss: 'New to read & watch',
  bluesky: 'From your network · Bluesky',
  mastodon: 'From your network · Mastodon',
  github: 'Fresh in your repos',
  canvas: "Don't forget"
}

const BUILDERS: Record<DiscoverSource, Builder> = {
  /** Spotify → recently played first, then playlists, as "listen again" cards. */
  spotify: async (client, accountId) => {
    const out: DiscoverItem[] = []

    const recent = asArray(await client.fetch(accountId, 'recently-played'))
    for (let i = 0; i < recent.length; i++) {
      const r = recent[i]
      const title = pick(r, 'track')
      if (!title) continue
      out.push({
        id: itemId('spotify', r, `recent-${i}`),
        title,
        subtitle: joinStr(r, 'artists') ?? firstStr(r, 'artists'),
        image: pick(r, 'artwork'),
        timestamp: toIso(pick(r, 'playedAt'))
      })
    }

    const playlists = asArray(await client.fetch(accountId, 'playlists'))
    for (let i = 0; i < playlists.length; i++) {
      const p = playlists[i]
      const title = pick(p, 'name')
      if (!title) continue
      const tracks = pick(p, 'tracks')
      out.push({
        id: itemId('spotify', p, `playlist-${i}`),
        title,
        subtitle: tracks ? `Playlist · ${tracks} tracks` : 'Playlist',
        image: pick(p, 'image')
      })
    }

    return out
  },

  /** RSS → newest items across the collection. */
  rss: async (client, accountId) => {
    const items = asArray(await client.fetch(accountId, 'items'))
    return items.map((raw, i) => ({
      id: itemId('rss', raw, `idx-${i}`),
      title: pick(raw, 'title') ?? pick(raw, 'feedTitle') ?? 'Untitled',
      subtitle: plain(pick(raw, 'feedTitle', 'summary', 'description')),
      link: pick(raw, 'link', 'url'),
      timestamp: toIso(pick(raw, 'published', 'pubDate', 'isoDate', 'updated', 'date'))
    }))
  },

  /** Bluesky → notable recent posts from the timeline. */
  bluesky: async (client, accountId) => {
    const items = asArray(await client.fetch(accountId, 'timeline'))
    return items.map((raw, i) => {
      const post =
        raw && typeof raw === 'object' && 'post' in (raw as object)
          ? (raw as Record<string, unknown>).post
          : raw
      const author =
        pick(post, 'author.displayName', 'author.handle') ??
        pick(raw, 'author.displayName', 'author.handle') ??
        'Bluesky'
      return {
        id: itemId('bluesky', post ?? raw, `idx-${i}`),
        title: author,
        subtitle: plain(pick(post, 'record.text', 'text') ?? pick(raw, 'record.text', 'text')),
        image: pick(post, 'author.avatar') ?? pick(raw, 'author.avatar'),
        timestamp: toIso(
          pick(post, 'record.createdAt', 'indexedAt', 'createdAt') ??
            pick(raw, 'record.createdAt', 'indexedAt', 'createdAt')
        )
      }
    })
  },

  /** Mastodon → notable recent posts from home. */
  mastodon: async (client, accountId) => {
    const items = asArray(await client.fetch(accountId, 'home'))
    return items.map((raw, i) => {
      const status =
        raw && typeof raw === 'object' && (raw as Record<string, unknown>).reblog
          ? (raw as Record<string, unknown>).reblog
          : raw
      const author =
        pick(
          status,
          'account.displayName',
          'account.display_name',
          'account.acct',
          'account.username'
        ) ?? 'Mastodon'
      return {
        id: itemId('mastodon', status ?? raw, `idx-${i}`),
        title: author,
        subtitle: plain(pick(status, 'content', 'text')),
        image: pick(status, 'account.avatar', 'account.avatar_static'),
        link: pick(status, 'url', 'uri'),
        timestamp: toIso(
          pick(status, 'createdAt', 'created_at') ?? pick(raw, 'createdAt', 'created_at')
        )
      }
    })
  },

  /** GitHub → recently-updated repos. */
  github: async (client, accountId) => {
    const repos = asArray(await client.fetch(accountId, 'repos'))
    return repos.map((raw, i) => ({
      id: itemId('github', raw, `idx-${i}`),
      title: pick(raw, 'fullName', 'full_name', 'name') ?? 'Repository',
      subtitle: pick(raw, 'description') ?? pick(raw, 'language'),
      link: pick(raw, 'htmlUrl', 'html_url', 'url'),
      timestamp: toIso(pick(raw, 'updatedAt', 'updated_at'))
    }))
  },

  /** Canvas → due-soon to-dos / upcoming, framed as "don't forget". */
  canvas: async (client, accountId) => {
    const out: DiscoverItem[] = []

    const todo = asArray(await client.fetch(accountId, 'todo'))
    for (let i = 0; i < todo.length; i++) {
      const t = todo[i]
      const title = pick(t, 'title')
      if (!title) continue
      const due = toIso(pick(t, 'dueAt', 'due_at'))
      out.push({
        id: itemId('canvas', t, `todo-${i}`),
        title,
        subtitle: due ? 'Due soon' : 'To do',
        link: pick(t, 'htmlUrl', 'html_url'),
        timestamp: due
      })
    }

    const upcoming = asArray(await client.fetch(accountId, 'upcoming'))
    for (let i = 0; i < upcoming.length; i++) {
      const e = upcoming[i]
      const title = pick(e, 'title')
      if (!title) continue
      out.push({
        id: itemId('canvas', e, `upcoming-${i}`),
        title,
        subtitle: 'Upcoming',
        link: pick(e, 'htmlUrl', 'html_url'),
        timestamp: toIso(pick(e, 'startAt', 'start_at'))
      })
    }

    return out
  }
}

/* ────────────────────────────── the client ───────────────────────────── */

export class DiscoveryClient implements ProviderClient {
  readonly id: ProviderId = 'discovery'

  /** No token of its own — connecting is a no-op success. */
  async connect(): Promise<ProviderStatus> {
    return { provider: 'discovery', connected: true, account: 'Discover' }
  }

  /** No token of its own — nothing to forget. */
  async disconnect(): Promise<void> {
    // intentionally empty
  }

  /**
   * Connected if ANY source provider exposes at least one account. Every probe
   * is isolated (allSettled + tolerate undefined / missing provider).
   */
  async status(): Promise<ProviderStatus> {
    const checks = await Promise.allSettled(
      SOURCES.map(async (id) => asAccounts(await getProvider(id)?.listAccounts()).length)
    )
    const sourceCount = checks.reduce(
      (n, c) => n + (c.status === 'fulfilled' && c.value > 0 ? 1 : 0),
      0
    )
    return {
      provider: 'discovery',
      connected: sourceCount > 0,
      account: `${sourceCount} source${sourceCount === 1 ? '' : 's'}`
    }
  }

  /** A single implicit account — Discover is always one logical board. */
  async listAccounts(): Promise<AccountSummary[]> {
    return [{ id: DEFAULT_ACCOUNT_ID, label: 'Discover' }]
  }

  /**
   * Build the board: for each source, fan out one isolated build per connected
   * account, merge that source's items into a single section, sort fresh-first,
   * cap, and drop empty sections. One account (or provider) failing never sinks
   * the board.
   */
  async fetch(_accountId: string, resource = 'board'): Promise<DiscoverBoard> {
    if (resource !== 'board') return { sections: [] }

    const sectionTasks = SOURCES.map((source) => this.buildSection(source))
    const settled = await Promise.allSettled(sectionTasks)

    const sections: DiscoverSection[] = []
    for (const result of settled) {
      if (result.status === 'fulfilled' && result.value) sections.push(result.value)
    }
    return { sections }
  }

  /**
   * Build one section for a source by aggregating every connected account.
   * Returns null when the source is absent, has no accounts, or yields nothing.
   */
  private async buildSection(source: DiscoverSource): Promise<DiscoverSection | null> {
    const client = getProvider(source)
    if (!client) return null

    const accounts = await this.safeListAccounts(client)
    if (accounts.length === 0) return null

    const builder = BUILDERS[source]
    const perAccount = await Promise.allSettled(
      accounts.map((acct) => this.safeBuild(builder, client, acct.id))
    )

    const items: DiscoverItem[] = []
    for (const r of perAccount) {
      if (r.status === 'fulfilled') items.push(...r.value)
    }
    if (items.length === 0) return null

    items.sort((a, b) => freshKey(b.timestamp) - freshKey(a.timestamp))
    return {
      source,
      title: SECTION_TITLE[source],
      items: items.slice(0, MAX_PER_SECTION)
    }
  }

  /** listAccounts() that never throws — a flaky provider yields no accounts. */
  private async safeListAccounts(client: ProviderClient): Promise<AccountSummary[]> {
    try {
      return asAccounts(await client.listAccounts())
    } catch {
      return []
    }
  }

  /** Run a builder in isolation — a single account's failure stays local. */
  private async safeBuild(
    builder: Builder,
    client: ProviderClient,
    accountId: string
  ): Promise<DiscoverItem[]> {
    try {
      return await builder(client, accountId)
    } catch {
      return []
    }
  }
}
