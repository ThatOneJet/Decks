/**
 * Decks — Follows Wall provider (main process).
 *
 * A unified, strictly CHRONOLOGICAL "new from who I follow" feed. It aggregates
 * ONLY real, open API / RSS sources at RUNTIME:
 *   - Bluesky timeline   (getProvider('bluesky').fetch('timeline'))
 *   - Mastodon home      (getProvider('mastodon').fetch('home'))
 *   - RSS items          (getProvider('rss').fetch('items')) — also covers YouTube
 *                         via per-channel RSS feeds.
 *
 * It is the chronological antidote to algorithmic feeds: NO Instagram / TikTok /
 * X / Reddit / YouTube-Home, nothing ranked or closed.
 *
 * PARALLEL-SAFETY: this client owns NO token and imports NO sub-provider file.
 * It depends on bluesky/mastodon/rss ONLY at runtime through the registry, so it
 * stays compilable while those clients are written concurrently. Sub-results are
 * of unknown shape and read defensively (helpers + optional chaining); any sub-
 * provider may be absent, disconnected, or fail without sinking the wall.
 */
import type { ProviderClient } from './types'
import type { ProviderId, ProviderStatus } from '@shared/types'
import { getProvider } from './registry'

/** The sub-providers the wall aggregates, in a stable order. */
type WallSource = 'bluesky' | 'mastodon' | 'rss'

/** Resource each sub-provider exposes its chronological feed under. */
const SOURCE_RESOURCE: Record<WallSource, string> = {
  bluesky: 'timeline',
  mastodon: 'home',
  rss: 'items'
}

/**
 * The common, normalized shape every wall item is reduced to. The renderer
 * consumes exactly this — sub-provider shapes never leak through.
 */
export interface WallItem {
  source: WallSource
  id: string
  /** Display name / handle / feed title of the author. */
  author: string
  avatar?: string
  /** Title (rss) or post heading when present. */
  title?: string
  /** Body text / summary snippet. */
  text?: string
  /** Outbound link (rss; some posts). */
  link?: string
  /** ISO-8601 timestamp used for the chronological sort. */
  timestamp: string
}

const MAX_ITEMS = 150

/* ────────────────────────── defensive readers ────────────────────────── */

/** Coerce anything that might be an array (or `{items|feed|posts: []}`) to an array. */
function asArray(x: unknown): unknown[] {
  if (Array.isArray(x)) return x
  if (x && typeof x === 'object') {
    const o = x as Record<string, unknown>
    for (const key of ['items', 'feed', 'posts', 'data', 'results', 'timeline']) {
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

/** Coerce a value to an ISO timestamp; fall back to epoch 0 so it sorts last. */
function toIso(value: string | undefined): string {
  if (value) {
    const t = Date.parse(value)
    if (!Number.isNaN(t)) return new Date(t).toISOString()
  }
  return new Date(0).toISOString()
}

/** Stable-ish id for an item; falls back to a source-scoped composite. */
function itemId(source: WallSource, raw: unknown, fallback: string): string {
  const id = pick(raw, 'id', 'uri', 'cid', 'guid', 'link', 'url')
  return `${source}:${id ?? fallback}`
}

/* ────────────────────────── per-source mappers ───────────────────────── */

function mapBluesky(raw: unknown, idx: number): WallItem {
  // Bluesky feed items often nest the post under `.post`.
  const post = (raw && typeof raw === 'object' && 'post' in (raw as object)
    ? (raw as Record<string, unknown>).post
    : raw) as unknown
  const author =
    pick(post, 'author.displayName', 'author.handle') ??
    pick(raw, 'author.displayName', 'author.handle') ??
    'Bluesky'
  return {
    source: 'bluesky',
    id: itemId('bluesky', post ?? raw, `idx-${idx}`),
    author,
    avatar: pick(post, 'author.avatar') ?? pick(raw, 'author.avatar'),
    text:
      plain(pick(post, 'record.text', 'text')) ?? plain(pick(raw, 'record.text', 'text')),
    timestamp: toIso(
      pick(post, 'record.createdAt', 'indexedAt', 'createdAt') ??
        pick(raw, 'record.createdAt', 'indexedAt', 'createdAt')
    )
  }
}

function mapMastodon(raw: unknown, idx: number): WallItem {
  // Boosts wrap the original under `.reblog`.
  const status = (raw && typeof raw === 'object' && (raw as Record<string, unknown>).reblog
    ? (raw as Record<string, unknown>).reblog
    : raw) as unknown
  const author =
    pick(status, 'account.displayName', 'account.display_name', 'account.acct', 'account.username') ??
    'Mastodon'
  return {
    source: 'mastodon',
    id: itemId('mastodon', status ?? raw, `idx-${idx}`),
    author,
    avatar: pick(status, 'account.avatar', 'account.avatar_static'),
    text: plain(pick(status, 'content', 'text')),
    link: pick(status, 'url', 'uri'),
    timestamp: toIso(pick(status, 'createdAt', 'created_at') ?? pick(raw, 'createdAt', 'created_at'))
  }
}

function mapRss(raw: unknown, idx: number): WallItem {
  return {
    source: 'rss',
    id: itemId('rss', raw, `idx-${idx}`),
    author: pick(raw, 'feedTitle', 'feed.title', 'source', 'author') ?? 'RSS',
    title: pick(raw, 'title'),
    text: plain(pick(raw, 'summary', 'description', 'contentSnippet', 'content')),
    link: pick(raw, 'link', 'url'),
    timestamp: toIso(pick(raw, 'published', 'pubDate', 'isoDate', 'updated', 'date'))
  }
}

const MAPPERS: Record<WallSource, (raw: unknown, idx: number) => WallItem> = {
  bluesky: mapBluesky,
  mastodon: mapMastodon,
  rss: mapRss
}

/* ────────────────────────────── the client ───────────────────────────── */

export class FollowsWallClient implements ProviderClient {
  readonly id: ProviderId = 'follows-wall'

  /** No token of its own — connecting is a no-op success. */
  async connect(): Promise<ProviderStatus> {
    return { provider: 'follows-wall', connected: true, account: 'Follows' }
  }

  /** No token of its own — nothing to forget. */
  async disconnect(): Promise<void> {
    // intentionally empty
  }

  /** Connected if ANY aggregated sub-provider reports connected. */
  async status(): Promise<ProviderStatus> {
    const sources: WallSource[] = ['bluesky', 'mastodon', 'rss']
    const checks = await Promise.allSettled(
      sources.map(async (id) => {
        const sub = getProvider(id)
        if (!sub) return false
        const s = await sub.status()
        return Boolean(s?.connected)
      })
    )
    const connectedCount = checks.filter(
      (c) => c.status === 'fulfilled' && c.value === true
    ).length
    return {
      provider: 'follows-wall',
      connected: connectedCount > 0,
      account: `${connectedCount} source${connectedCount === 1 ? '' : 's'}`
    }
  }

  /**
   * Pull every connected sub-provider in parallel, normalize, merge,
   * sort newest-first, and cap. One source failing never sinks the wall.
   */
  async fetch(resource = 'wall'): Promise<WallItem[]> {
    if (resource !== 'wall') return []

    const sources: WallSource[] = ['bluesky', 'mastodon', 'rss']
    const settled = await Promise.allSettled(
      sources.map((id) => this.pullSource(id))
    )

    const merged: WallItem[] = []
    for (const result of settled) {
      if (result.status === 'fulfilled') merged.push(...result.value)
    }

    merged.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    return merged.slice(0, MAX_ITEMS)
  }

  /** Fetch + normalize a single sub-provider; isolated so failures stay local. */
  private async pullSource(id: WallSource): Promise<WallItem[]> {
    const sub = getProvider(id)
    if (!sub) return []
    const raw = await sub.fetch(SOURCE_RESOURCE[id])
    const map = MAPPERS[id]
    return asArray(raw).map((item, idx) => map(item, idx))
  }
}
