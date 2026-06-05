/**
 * Decks — Mastodon provider client (main process).
 *
 * Talks to a user-chosen Mastodon instance's REST API using an access token the
 * user creates under their instance's Preferences → Development → New
 * application (read scopes). connect() validates the token; fetch() returns
 * SANITIZED home-timeline / notification JSON to the renderer.
 *
 * Security: the access token lives only in this process (encrypted via
 * tokens.ts). It is never logged and never returned to the renderer.
 */
import type { ProviderClient } from './types'
import type { ProviderId, ProviderStatus } from '@shared/types'
import type { AccountSummary } from '@shared/types'
import { saveToken, getToken, removeToken } from '../tokens'
import {
  accountKey,
  listAccounts as listProviderAccounts,
  upsertAccount,
  removeAccount
} from '../accounts'

/** Persisted credential blob (encrypted at rest, main-only). */
interface MastodonCreds {
  instanceUrl: string
  token: string
  account: string
}

/** Strip a trailing slash so we can safely concatenate API paths. */
function normalizeInstanceUrl(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

/** A short, user-safe error string — never carries a token. */
function safeError(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message
  if (typeof err === 'string' && err) return err
  return fallback
}

/** Minimal shapes of the REST responses we consume. */
interface MastoAccount {
  acct?: string
  username?: string
  display_name?: string
  avatar?: string
}

interface MastoMedia {
  preview_url?: string
  url?: string
}

interface MastoStatus {
  id?: string
  account?: MastoAccount
  content?: string
  created_at?: string
  url?: string
  reblog?: MastoStatus | null
  favourites_count?: number
  reblogs_count?: number
  media_attachments?: MastoMedia[]
}

interface MastoNotification {
  id?: string
  type?: string
  account?: MastoAccount
  created_at?: string
}

function mapAccount(a: MastoAccount | undefined): {
  acct: string
  displayName: string
  avatar: string
} {
  return {
    acct: a?.acct ?? a?.username ?? '',
    displayName: a?.display_name ?? '',
    avatar: a?.avatar ?? ''
  }
}

export class MastodonClient implements ProviderClient {
  readonly id: ProviderId = 'mastodon'

  // ── credential helpers ──────────────────────────────────────────────────

  /** Secure-store key for one account's credentials. */
  private key(accountId: string): string {
    return accountKey(this.id, accountId)
  }

  private load(accountId: string): MastodonCreds | null {
    const raw = getToken(this.key(accountId))
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as Partial<MastodonCreds>
      if (!parsed.instanceUrl || !parsed.token) return null
      return {
        instanceUrl: parsed.instanceUrl,
        token: parsed.token,
        account: parsed.account ?? ''
      }
    } catch {
      return null
    }
  }

  private save(accountId: string, creds: MastodonCreds): void {
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
      return { provider: this.id, connected: false, error: 'Mastodon uses an access token, not OAuth.' }
    }

    const instanceUrl = normalizeInstanceUrl(opts.fields?.instanceUrl ?? '')
    const token = opts.token?.trim()
    if (!instanceUrl || !token) {
      return {
        provider: this.id,
        connected: false,
        error: 'Enter your instance URL and an access token.'
      }
    }

    try {
      const res = await fetch(`${instanceUrl}/api/v1/accounts/verify_credentials`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      if (!res.ok) {
        return {
          provider: this.id,
          connected: false,
          error: res.status === 401 ? 'Invalid access token.' : `Sign-in failed (${res.status}).`
        }
      }
      const account = (await res.json()) as MastoAccount
      const acct = account.acct ?? account.username ?? ''
      const creds: MastodonCreds = { instanceUrl, token, account: acct }
      this.save(opts.accountId, creds)
      // Label the account with the handle plus the instance host so two accounts
      // on different instances stay distinguishable in the Settings UI.
      const host = instanceUrl.replace(/^https?:\/\//, '')
      const label = acct
        ? acct.includes('@')
          ? `@${acct}`
          : `@${acct}@${host}`
        : host
      upsertAccount(this.id, { id: opts.accountId, label })
      return { provider: this.id, connected: true, account: acct ? `@${acct}` : undefined }
    } catch (err) {
      return { provider: this.id, connected: false, error: safeError(err, 'Could not reach the instance.') }
    }
  }

  /** GET an API path on the connected instance with the Bearer token. */
  private async authedGet(accountId: string, path: string): Promise<Response> {
    const creds = this.load(accountId)
    if (!creds) throw new Error('Not connected to Mastodon.')
    return fetch(`${creds.instanceUrl}${path}`, {
      headers: { Authorization: `Bearer ${creds.token}` }
    })
  }

  async fetch(
    accountId: string,
    resource: string,
    _params?: Record<string, unknown>
  ): Promise<unknown> {
    void _params
    switch (resource) {
      case 'home':
        return this.home(accountId)
      case 'notifications':
        return this.notifications(accountId)
      default:
        return { home: await this.home(accountId) }
    }
  }

  private async home(accountId: string): Promise<unknown[]> {
    const res = await this.authedGet(accountId, '/api/v1/timelines/home?limit=40')
    if (!res.ok) throw new Error(`Could not load timeline (${res.status}).`)
    const data = (await res.json()) as MastoStatus[]
    return (Array.isArray(data) ? data : []).map((status) => {
      const reblog = status.reblog ?? undefined
      const media = status.media_attachments?.[0]
      const mediaPreview = media?.preview_url ?? media?.url
      return {
        id: status.id ?? '',
        account: mapAccount(status.account),
        content: status.content ?? '',
        createdAt: status.created_at ?? '',
        url: status.url ?? '',
        ...(reblog
          ? {
              reblog: {
                account: mapAccount(reblog.account),
                content: reblog.content ?? '',
                createdAt: reblog.created_at ?? '',
                url: reblog.url ?? ''
              }
            }
          : {}),
        favouritesCount: status.favourites_count ?? 0,
        reblogsCount: status.reblogs_count ?? 0,
        ...(mediaPreview ? { mediaPreview } : {})
      }
    })
  }

  private async notifications(accountId: string): Promise<unknown[]> {
    const res = await this.authedGet(accountId, '/api/v1/notifications?limit=40')
    if (!res.ok) throw new Error(`Could not load notifications (${res.status}).`)
    const data = (await res.json()) as MastoNotification[]
    return (Array.isArray(data) ? data : []).map((n) => ({
      id: n.id ?? '',
      type: n.type ?? '',
      account: mapAccount(n.account),
      createdAt: n.created_at ?? ''
    }))
  }

  async disconnect(accountId: string): Promise<void> {
    removeToken(this.key(accountId))
    removeAccount(this.id, accountId)
  }

  async status(accountId: string): Promise<ProviderStatus> {
    const creds = this.load(accountId)
    if (!creds) return { provider: this.id, connected: false }
    return {
      provider: this.id,
      connected: true,
      account: creds.account ? `@${creds.account}` : undefined
    }
  }

  async listAccounts(): Promise<AccountSummary[]> {
    return listProviderAccounts(this.id)
  }
}
