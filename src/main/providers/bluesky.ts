/**
 * Decks — Bluesky provider client (main process).
 *
 * Talks to the Bluesky / AT Protocol XRPC API (bsky.social) using an APP
 * PASSWORD (created under Bluesky Settings → App Passwords — NOT the account's
 * main password). connect() creates a session and stores the resulting JWTs;
 * fetch() returns SANITIZED feed/notification JSON to the renderer.
 *
 * Security: the access/refresh JWTs live only in this process (encrypted via
 * tokens.ts). They are never logged and never returned to the renderer.
 */
import type { ProviderClient } from './types'
import type { ProviderId, ProviderStatus, AccountSummary } from '@shared/types'
import { saveToken, getToken, removeToken } from '../tokens'
import {
  accountKey,
  listAccounts as listProviderAccounts,
  upsertAccount,
  removeAccount
} from '../accounts'

const SERVICE_DEFAULT = 'https://bsky.social'

/** Persisted credential blob (encrypted at rest, main-only). */
interface BlueskyCreds {
  service: string
  handle: string
  did: string
  accessJwt: string
  refreshJwt: string
}

/** A short, user-safe error string — never carries a token. */
function safeError(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message
  if (typeof err === 'string' && err) return err
  return fallback
}

/** Minimal shapes of the XRPC responses we consume. */
interface SessionResponse {
  accessJwt: string
  refreshJwt: string
  handle: string
  did: string
}

interface BskyAuthor {
  handle?: string
  displayName?: string
  avatar?: string
}

interface BskyPost {
  uri?: string
  author?: BskyAuthor
  record?: { text?: string; createdAt?: string }
  likeCount?: number
  repostCount?: number
  replyCount?: number
  embed?: {
    images?: { thumb?: string; fullsize?: string }[]
  }
}

interface TimelineResponse {
  feed?: { post?: BskyPost }[]
}

interface NotificationsResponse {
  notifications?: {
    author?: BskyAuthor
    reason?: string
    indexedAt?: string
    record?: { text?: string }
  }[]
}

export class BlueskyClient implements ProviderClient {
  readonly id: ProviderId = 'bluesky'

  /** Secure-store key for one account's credentials. */
  private key(accountId: string): string {
    return accountKey(this.id, accountId)
  }

  // ── credential helpers ──────────────────────────────────────────────────

  private load(accountId: string): BlueskyCreds | null {
    const raw = getToken(this.key(accountId))
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as Partial<BlueskyCreds>
      if (!parsed.accessJwt || !parsed.refreshJwt || !parsed.handle) return null
      return {
        service: parsed.service || SERVICE_DEFAULT,
        handle: parsed.handle,
        did: parsed.did ?? '',
        accessJwt: parsed.accessJwt,
        refreshJwt: parsed.refreshJwt
      }
    } catch {
      return null
    }
  }

  private save(accountId: string, creds: BlueskyCreds): void {
    saveToken(this.key(accountId), JSON.stringify(creds))
  }

  // ── ProviderClient ──────────────────────────────────────────────────────

  async connect(opts: {
    accountId: string
    mode: 'token' | 'oauth'
    token?: string
    fields?: Record<string, string>
  }): Promise<ProviderStatus> {
    if (opts.mode !== 'token') {
      return { provider: this.id, connected: false, error: 'Bluesky uses an app password, not OAuth.' }
    }

    const handle = opts.fields?.handle?.trim()
    const appPassword = opts.fields?.appPassword?.trim()
    if (!handle || !appPassword) {
      return {
        provider: this.id,
        connected: false,
        error: 'Enter your handle and an app password.'
      }
    }

    const service = SERVICE_DEFAULT
    try {
      const res = await fetch(`${service}/xrpc/com.atproto.server.createSession`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: handle, password: appPassword })
      })
      if (!res.ok) {
        return {
          provider: this.id,
          connected: false,
          error: res.status === 401 ? 'Invalid handle or app password.' : `Sign-in failed (${res.status}).`
        }
      }
      const session = (await res.json()) as SessionResponse
      const creds: BlueskyCreds = {
        service,
        handle: session.handle || handle,
        did: session.did,
        accessJwt: session.accessJwt,
        refreshJwt: session.refreshJwt
      }
      this.save(opts.accountId, creds)
      upsertAccount(this.id, { id: opts.accountId, label: creds.handle })
      return { provider: this.id, connected: true, account: creds.handle }
    } catch (err) {
      return { provider: this.id, connected: false, error: safeError(err, 'Could not reach Bluesky.') }
    }
  }

  /**
   * Return a valid access JWT, refreshing it (and re-saving creds) if the
   * current one is rejected. Throws a user-safe Error if no session exists.
   */
  private async auth(accountId: string): Promise<{ creds: BlueskyCreds }> {
    const creds = this.load(accountId)
    if (!creds) throw new Error('Not connected to Bluesky.')
    return { creds }
  }

  /** Refresh the session using the refresh JWT; persists and returns new creds. */
  private async refresh(accountId: string, creds: BlueskyCreds): Promise<BlueskyCreds> {
    const res = await fetch(`${creds.service}/xrpc/com.atproto.server.refreshSession`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${creds.refreshJwt}` }
    })
    if (!res.ok) throw new Error('Session expired — reconnect Bluesky.')
    const session = (await res.json()) as SessionResponse
    const next: BlueskyCreds = {
      ...creds,
      handle: session.handle || creds.handle,
      did: session.did || creds.did,
      accessJwt: session.accessJwt,
      refreshJwt: session.refreshJwt
    }
    this.save(accountId, next)
    return next
  }

  /**
   * GET an XRPC endpoint with the access JWT, transparently refreshing once on a
   * 401/expired response and retrying.
   */
  private async authedGet(accountId: string, path: string): Promise<Response> {
    let { creds } = await this.auth(accountId)
    const call = (jwt: string): Promise<Response> =>
      fetch(`${creds.service}${path}`, { headers: { Authorization: `Bearer ${jwt}` } })

    let res = await call(creds.accessJwt)
    if (res.status === 401) {
      creds = await this.refresh(accountId, creds)
      res = await call(creds.accessJwt)
    }
    return res
  }

  async fetch(
    accountId: string,
    resource: string,
    _params?: Record<string, unknown>
  ): Promise<unknown> {
    void _params
    switch (resource) {
      case 'timeline':
        return this.timeline(accountId)
      case 'notifications':
        return this.notifications(accountId)
      default:
        return { timeline: await this.timeline(accountId) }
    }
  }

  private async timeline(accountId: string): Promise<unknown[]> {
    const res = await this.authedGet(accountId, '/xrpc/app.bsky.feed.getTimeline?limit=40')
    if (!res.ok) throw new Error(`Could not load timeline (${res.status}).`)
    const data = (await res.json()) as TimelineResponse
    return (data.feed ?? []).map((item) => {
      const post = item.post ?? {}
      const author = post.author ?? {}
      const embedImage = post.embed?.images?.[0]?.thumb ?? post.embed?.images?.[0]?.fullsize
      return {
        uri: post.uri ?? '',
        author: {
          handle: author.handle ?? '',
          displayName: author.displayName ?? '',
          avatar: author.avatar ?? ''
        },
        text: post.record?.text ?? '',
        createdAt: post.record?.createdAt ?? '',
        likeCount: post.likeCount ?? 0,
        repostCount: post.repostCount ?? 0,
        replyCount: post.replyCount ?? 0,
        ...(embedImage ? { embedImage } : {})
      }
    })
  }

  private async notifications(accountId: string): Promise<unknown[]> {
    const res = await this.authedGet(
      accountId,
      '/xrpc/app.bsky.notification.listNotifications?limit=40'
    )
    if (!res.ok) throw new Error(`Could not load notifications (${res.status}).`)
    const data = (await res.json()) as NotificationsResponse
    return (data.notifications ?? []).map((n) => {
      const author = n.author ?? {}
      return {
        author: {
          handle: author.handle ?? '',
          displayName: author.displayName ?? '',
          avatar: author.avatar ?? ''
        },
        reason: n.reason ?? '',
        indexedAt: n.indexedAt ?? '',
        ...(n.record?.text ? { text: n.record.text } : {})
      }
    })
  }

  async disconnect(accountId: string): Promise<void> {
    removeToken(this.key(accountId))
    removeAccount(this.id, accountId)
  }

  async status(accountId: string): Promise<ProviderStatus> {
    const creds = this.load(accountId)
    if (!creds) return { provider: this.id, connected: false }
    return { provider: this.id, connected: true, account: creds.handle }
  }

  async listAccounts(): Promise<AccountSummary[]> {
    return listProviderAccounts(this.id)
  }
}
