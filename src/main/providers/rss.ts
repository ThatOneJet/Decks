/**
 * Decks — RSS / Atom provider client (main process).
 *
 * Backs the native RSS deck. Unlike token providers, RSS has NO auth — and it is
 * ACCOUNT-AWARE: each "account" is a separate FEED COLLECTION (e.g. a "Tech"
 * deck and a "News" deck, each with its own feeds). For simplicity we reuse the
 * per-provider encrypted store (../tokens) to hold a small JSON blob
 * `{ feeds: string[] }` PER ACCOUNT, keyed by `accountKey(this.id, accountId)`
 * (see ../accounts) — it isn't a secret, but the store gives us atomic
 * persistence for free. The non-secret account index lives in ../accounts.
 *
 * All HTTP happens here with the global `fetch` (a real User-Agent + a ~10s
 * abort timeout). Feeds are parsed with a small, dependency-free regex parser
 * that tolerates real-world RSS 2.0 and Atom (including YouTube channel feeds).
 * The renderer only ever receives sanitized JSON.
 */
import { saveToken, getToken, removeToken } from '../tokens'
import {
  accountKey,
  listAccounts as listProviderAccounts,
  upsertAccount,
  removeAccount
} from '../accounts'
import type { ProviderClient } from './types'
import type { ProviderId, ProviderStatus, AccountSummary } from '@shared/types'

const ID: ProviderId = 'rss'

/** User-Agent sent on every feed request (some hosts 403 a blank UA). */
const USER_AGENT =
  'Mozilla/5.0 (compatible; Decks/0.1; +https://github.com/ThatOneJet/decks) RSS-Reader'

/** Per-request timeout for fetching a feed. */
const FETCH_TIMEOUT_MS = 10_000

/** Hard cap on merged items returned to the renderer. */
const MAX_ITEMS = 120

/** Approx. max length of a plain-text summary snippet. */
const SUMMARY_LEN = 280

/** Persisted (non-secret) blob: the user's feed URL list. */
interface RssStore {
  feeds: string[]
}

/** A normalized, sanitized feed item handed to the renderer. */
interface RssItem {
  feedTitle: string
  feedUrl: string
  title: string
  link: string
  /** ISO-8601, or '' when the feed gave no usable date. */
  published: string
  summary: string
}

/** Result of parsing one feed document. */
interface ParsedFeed {
  feedTitle: string
  items: Array<{
    title: string
    link: string
    published: string
    summary: string
  }>
}

export class RssClient implements ProviderClient {
  readonly id: ProviderId = ID

  // ── Store ──────────────────────────────────────────────────────────────

  /** Secure-store key for one account's feed collection. */
  private key(accountId: string): string {
    return accountKey(this.id, accountId)
  }

  /** Read + parse one account's feed collection, or a fresh empty store. */
  private readStore(accountId: string): RssStore {
    const raw = getToken(this.key(accountId))
    if (!raw) return { feeds: [] }
    try {
      const parsed = JSON.parse(raw) as Partial<RssStore>
      const feeds = Array.isArray(parsed?.feeds)
        ? parsed.feeds.filter((f): f is string => typeof f === 'string')
        : []
      return { feeds }
    } catch {
      return { feeds: [] }
    }
  }

  /** Persist one account's feed collection (dedup + trim handled by callers). */
  private writeStore(accountId: string, store: RssStore): void {
    saveToken(this.key(accountId), JSON.stringify(store))
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  async connect(opts: {
    accountId: string
    mode: 'token' | 'oauth'
    token?: string
    fields?: Record<string, string>
  }): Promise<ProviderStatus> {
    const { accountId } = opts
    const store = this.readStore(accountId)

    // Seed the feed list from a comma / newline separated string if provided.
    const seed = opts.fields?.feeds
    if (typeof seed === 'string' && seed.trim()) {
      const urls = this.splitFeedInput(seed)
      const merged = [...store.feeds]
      for (const url of urls) {
        if (!merged.includes(url)) merged.push(url)
      }
      this.writeStore(accountId, { feeds: merged })
    } else if (!getToken(this.key(accountId))) {
      // No blob yet — initialize an empty one so status()/list are well-defined.
      this.writeStore(accountId, { feeds: store.feeds })
    }

    // Label this feed collection (the deck's display name), default 'RSS'.
    const label = opts.fields?.label?.trim() || 'RSS'
    upsertAccount(this.id, { id: accountId, label })

    // RSS needs no auth — always "connected".
    return { provider: this.id, connected: true, account: label }
  }

  async disconnect(accountId: string): Promise<void> {
    removeToken(this.key(accountId))
    removeAccount(this.id, accountId)
  }

  async status(accountId: string): Promise<ProviderStatus> {
    const entry = listProviderAccounts(this.id).find((a) => a.id === accountId)
    const connected = !!entry || !!getToken(this.key(accountId))
    return {
      provider: this.id,
      connected,
      account: entry?.label ?? (connected ? 'RSS' : undefined)
    }
  }

  /** List this provider's connected feed collections (for the Settings UI). */
  async listAccounts(): Promise<AccountSummary[]> {
    return listProviderAccounts(this.id)
  }

  // ── Resources ──────────────────────────────────────────────────────────

  async fetch(
    accountId: string,
    resource: string,
    params?: Record<string, unknown>
  ): Promise<unknown> {
    switch (resource) {
      case 'feeds:list':
        return this.readStore(accountId).feeds

      case 'feeds:add':
        return this.addFeed(accountId, this.asUrl(params?.url))

      case 'feeds:remove':
        return this.removeFeed(accountId, this.asUrl(params?.url))

      case 'items':
      default:
        return this.fetchItems(accountId)
    }
  }

  /** Validate a URL fetches + parses, then add it to the list (deduped). */
  private async addFeed(accountId: string, url: string): Promise<string[]> {
    if (!url) throw new Error('No feed URL provided.')
    const normalized = this.normalizeUrl(url)

    const store = this.readStore(accountId)
    if (store.feeds.includes(normalized)) return store.feeds

    // Validate by actually fetching + parsing the document.
    let xml: string
    try {
      xml = await this.fetchText(normalized)
    } catch {
      throw new Error('Could not reach that feed. Check the URL and try again.')
    }
    const parsed = this.parseFeed(xml)
    if (parsed.items.length === 0 && !parsed.feedTitle) {
      throw new Error("That URL doesn't look like an RSS or Atom feed.")
    }

    const feeds = [...store.feeds, normalized]
    this.writeStore(accountId, { feeds })
    return feeds
  }

  /** Remove a feed from the list and persist. */
  private async removeFeed(accountId: string, url: string): Promise<string[]> {
    if (!url) throw new Error('No feed URL provided.')
    const normalized = this.normalizeUrl(url)
    const store = this.readStore(accountId)
    const feeds = store.feeds.filter((f) => f !== normalized && f !== url)
    this.writeStore(accountId, { feeds })
    return feeds
  }

  /** Fetch ALL stored feeds in parallel, merge, sort by date DESC, cap. */
  private async fetchItems(accountId: string): Promise<RssItem[]> {
    const { feeds } = this.readStore(accountId)
    if (feeds.length === 0) return []

    const results = await Promise.allSettled(feeds.map((url) => this.fetchOne(url)))

    const merged: RssItem[] = []
    for (const r of results) {
      if (r.status === 'fulfilled') merged.push(...r.value)
    }

    merged.sort((a, b) => this.timeOf(b.published) - this.timeOf(a.published))
    return merged.slice(0, MAX_ITEMS)
  }

  /** Fetch + parse a single feed into sanitized items. Throws on failure. */
  private async fetchOne(url: string): Promise<RssItem[]> {
    const xml = await this.fetchText(url)
    const parsed = this.parseFeed(xml)
    return parsed.items.map((it) => ({
      feedTitle: parsed.feedTitle || this.hostOf(url),
      feedUrl: url,
      title: it.title,
      link: it.link,
      published: it.published,
      summary: it.summary
    }))
  }

  // ── HTTP ───────────────────────────────────────────────────────────────

  /** GET text with a real UA + an abort timeout. Throws on non-2xx/timeout. */
  private async fetchText(url: string): Promise<string> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          'User-Agent': USER_AGENT,
          Accept:
            'application/rss+xml, application/atom+xml, application/xml, text/xml, */*'
        }
      })
      if (!res.ok) throw new Error(`Feed request failed (${res.status})`)
      return await res.text()
    } finally {
      clearTimeout(timer)
    }
  }

  // ── Parser (regex-based, dependency-free) ───────────────────────────────

  /** Parse an RSS 2.0 or Atom document into a feed title + items. */
  private parseFeed(xml: string): ParsedFeed {
    const isAtom = /<feed[\s>]/i.test(xml) && /<entry[\s>]/i.test(xml)
    const feedTitle = this.parseFeedTitle(xml, isAtom)
    const items = isAtom ? this.parseAtomEntries(xml) : this.parseRssItems(xml)
    return { feedTitle, items }
  }

  /** Channel/feed title: RSS `<channel><title>`, Atom top-level `<title>`. */
  private parseFeedTitle(xml: string, isAtom: boolean): string {
    if (isAtom) {
      // Strip entries so we don't grab an entry's title by accident.
      const head = xml.replace(/<entry[\s\S]*$/i, '')
      const m = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
      return m ? this.clean(m[1]) : ''
    }
    const channel = xml.match(/<channel[^>]*>([\s\S]*?)<item[\s>]/i)
    const scope = channel ? channel[1] : xml
    const m = scope.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
    return m ? this.clean(m[1]) : ''
  }

  /** RSS 2.0 `<item>` blocks. */
  private parseRssItems(xml: string): ParsedFeed['items'] {
    const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? []
    return blocks.map((block) => {
      const title = this.clean(this.tag(block, 'title'))
      const link = this.rssLink(block)
      const published = this.toIso(
        this.tag(block, 'pubDate') ||
          this.tag(block, 'dc:date') ||
          this.tag(block, 'published') ||
          this.tag(block, 'updated')
      )
      const summary = this.snippet(
        this.tag(block, 'description') ||
          this.tag(block, 'content:encoded') ||
          this.tag(block, 'summary')
      )
      return { title, link, published, summary }
    })
  }

  /** Atom `<entry>` blocks. */
  private parseAtomEntries(xml: string): ParsedFeed['items'] {
    const blocks = xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) ?? []
    return blocks.map((block) => {
      const title = this.clean(this.tag(block, 'title'))
      const link = this.atomLink(block)
      const published = this.toIso(
        this.tag(block, 'published') ||
          this.tag(block, 'updated') ||
          this.tag(block, 'issued')
      )
      const summary = this.snippet(
        this.tag(block, 'summary') ||
          this.tag(block, 'content') ||
          // YouTube feeds carry the blurb in media:description.
          this.tag(block, 'media:description')
      )
      return { title, link, published, summary }
    })
  }

  /** Inner text of the first `<name>…</name>` in a block (CDATA tolerated). */
  private tag(block: string, name: string): string {
    const re = new RegExp(`<${this.escapeTag(name)}[^>]*>([\\s\\S]*?)</${this.escapeTag(name)}>`, 'i')
    const m = block.match(re)
    return m ? m[1] : ''
  }

  /** RSS link: prefer `<link>text</link>`; fall back to an atom-style href. */
  private rssLink(block: string): string {
    const text = this.clean(this.tag(block, 'link'))
    if (text && /^https?:/i.test(text)) return text
    // Some RSS feeds embed an atom:link with an href.
    return this.atomLink(block)
  }

  /**
   * Atom link: prefer rel="alternate" (or no rel) with an href; otherwise the
   * first href we can find.
   */
  private atomLink(block: string): string {
    const links = block.match(/<link\b[^>]*>/gi) ?? []
    let fallback = ''
    for (const tag of links) {
      const href = tag.match(/href\s*=\s*["']([^"']+)["']/i)?.[1]
      if (!href) continue
      const rel = tag.match(/rel\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase()
      if (!rel || rel === 'alternate') return this.decode(href)
      if (!fallback) fallback = href
    }
    return this.decode(fallback)
  }

  // ── Text helpers ─────────────────────────────────────────────────────────

  /** Strip CDATA + tags, decode entities, collapse whitespace. */
  private clean(raw: string): string {
    if (!raw) return ''
    return this.decode(this.stripTags(this.stripCdata(raw))).replace(/\s+/g, ' ').trim()
  }

  /** clean() + truncate to a snippet with an ellipsis. */
  private snippet(raw: string): string {
    const text = this.clean(raw)
    if (text.length <= SUMMARY_LEN) return text
    return text.slice(0, SUMMARY_LEN).replace(/\s+\S*$/, '').trimEnd() + '…'
  }

  private stripCdata(s: string): string {
    return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  }

  private stripTags(s: string): string {
    return s.replace(/<[^>]+>/g, ' ')
  }

  /** Decode the common HTML/XML entities we expect in feeds. */
  private decode(s: string): string {
    return s
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/gi, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/&#(\d+);/g, (_m, d: string) => this.fromCodePoint(parseInt(d, 10)))
      .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => this.fromCodePoint(parseInt(h, 16)))
      .replace(/&amp;/g, '&') // ampersand last so the above aren't re-decoded
  }

  private fromCodePoint(code: number): string {
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return ''
    try {
      return String.fromCodePoint(code)
    } catch {
      return ''
    }
  }

  // ── Date / URL helpers ───────────────────────────────────────────────────

  /** Parse any feed date string to ISO-8601, or '' when unparseable. */
  private toIso(raw: string): string {
    const s = this.clean(raw)
    if (!s) return ''
    const t = Date.parse(s)
    return Number.isNaN(t) ? '' : new Date(t).toISOString()
  }

  /** Sort key: epoch ms for an ISO date, or 0 (oldest) when missing. */
  private timeOf(iso: string): number {
    if (!iso) return 0
    const t = Date.parse(iso)
    return Number.isNaN(t) ? 0 : t
  }

  /** Split a comma / newline separated feed input into trimmed URLs. */
  private splitFeedInput(input: string): string[] {
    return input
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => this.normalizeUrl(s))
  }

  /** Coerce an unknown param into a trimmed string URL. */
  private asUrl(v: unknown): string {
    return typeof v === 'string' ? v.trim() : ''
  }

  /** Add a scheme if the user pasted a bare host; otherwise pass through. */
  private normalizeUrl(url: string): string {
    const trimmed = url.trim()
    if (!trimmed) return ''
    if (/^https?:\/\//i.test(trimmed)) return trimmed
    return `https://${trimmed}`
  }

  /** Best-effort hostname for feeds that omit a title. */
  private hostOf(url: string): string {
    try {
      return new URL(url).hostname.replace(/^www\./, '')
    } catch {
      return url
    }
  }

  /** Escape a tag name (e.g. `content:encoded`) for use inside a RegExp. */
  private escapeTag(name: string): string {
    return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
}
