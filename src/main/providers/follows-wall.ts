/**
 * Decks — Follows Wall provider (main process).
 *
 * A unified, strictly CHRONOLOGICAL "new from who I follow" feed. It aggregates
 * ONLY real, open API / RSS sources at RUNTIME, across EVERY connected account of
 * each sub-provider (sub-providers are account-aware now):
 *   - Bluesky timeline   (getProvider('bluesky').fetch(acct, 'timeline'))
 *   - Mastodon home      (getProvider('mastodon').fetch(acct, 'home'))
 *   - RSS items          (getProvider('rss').fetch(acct, 'items')) — also covers
 *                         YouTube via per-channel RSS feeds.
 *
 * Each sub-provider's accounts come from its `listAccounts()`; the wall fans out
 * one isolated fetch per (provider, account) pair and merges the results.
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
import type { ProviderId, ProviderStatus, AccountSummary } from '@shared/types'
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

/** The single implicit account this wall exposes. */
const DEFAULT_ACCOUNT_ID = 'default'

/** Coerce a sub-provider's listAccounts() result to a safe AccountSummary[]. */
function asAccounts(x: unknown): AccountSummary[] {
  if (!Array.isArray(x)) return []
  return x.filter(
    (a): a is AccountSummary =>
      Boolean(a) && typeof a === 'object' && typeof (a as AccountSummary).id === 'string'
  )
}

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

  /**
   * Connected if ANY aggregated sub-provider exposes at least one account.
   * Sub-providers are account-aware now, so we count their accounts rather than
   * a single boolean. Every probe is isolated (allSettled + tolerate undefined).
   */
  async status(): Promise<ProviderStatus> {
    const sources: WallSource[] = ['bluesky', 'mastodon', 'rss']
    const checks = await Promise.allSettled(
      sources.map(async (id) => asAccounts(await getProvider(id)?.listAccounts()).length)
    )
    const sourceCount = checks.reduce(
      (n, c) => n + (c.status === 'fulfilled' && c.value > 0 ? 1 : 0),
      0
    )
    return {
      provider: 'follows-wall',
      connected: sourceCount > 0,
      account: `${sourceCount} source${sourceCount === 1 ? '' : 's'}`
    }
  }

  /** A single implicit account — the wall is always one logical "Follows" feed. */
  async listAccounts(): Promise<AccountSummary[]> {
    return [{ id: DEFAULT_ACCOUNT_ID, label: 'Follows' }]
  }

  /**
   * Pull EVERY connected account across every sub-provider in parallel,
   * normalize, merge, sort newest-first, and cap. Each per-account call is
   * isolated so one account (or one provider) failing never sinks the wall.
   */
  async fetch(_accountId: string, resource = 'wall'): Promise<WallItem[]> {
    if (resource !== 'wall') return []

    const sources: WallSource[] = ['bluesky', 'mastodon', 'rss']

    // Build one isolated pull task per (source, account) pair.
    const tasks: Promise<WallItem[]>[] = []
    for (const id of sources) {
      const client = getProvider(id)
      if (!client) continue
      const accts = await this.safeListAccounts(client)
      for (const acct of accts) {
        tasks.push(this.pullAccount(id, client, acct.id))
      }
    }

    const settled = await Promise.allSettled(tasks)
    const merged: WallItem[] = []
    for (const result of settled) {
      if (result.status === 'fulfilled') merged.push(...result.value)
    }

    merged.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    return merged.slice(0, MAX_ITEMS)
  }

  /** listAccounts() that never throws — a flaky provider yields no accounts. */
  private async safeListAccounts(client: ProviderClient): Promise<AccountSummary[]> {
    try {
      return asAccounts(await client.listAccounts())
    } catch {
      return []
    }
  }

  /**
   * Fetch + normalize one account of one sub-provider. Isolated so a single
   * account's failure stays local (returns []) and never rejects the wall.
   */
  private async pullAccount(
    id: WallSource,
    client: ProviderClient,
    accountId: string
  ): Promise<WallItem[]> {
    try {
      const raw = await client.fetch(accountId, SOURCE_RESOURCE[id])
      const map = MAPPERS[id]
      return asArray(raw).map((item, idx) => map(item, idx))
    } catch {
      return []
    }
  }
}
