/**
 * Decks — GitHub provider client (main process).
 *
 * Backs the native GitHub deck. Supports two connect modes:
 *  - 'token' (primary): the user pastes a personal access token (PAT).
 *  - 'oauth':           runs the OAuth helper with a user-supplied client id/secret.
 *
 * Credentials live ONLY in main, encrypted via ../tokens (a JSON blob). All HTTP
 * happens here with the global `fetch`; the renderer receives sanitized JSON and
 * never sees the token. Token values are never logged.
 */
import { runOAuth } from '../oauth'
import { saveToken, getToken, removeToken } from '../tokens'
import {
  accountKey,
  listAccounts as listProviderAccounts,
  upsertAccount,
  removeAccount
} from '../accounts'
import type { ProviderClient } from './types'
import type { ProviderId, ProviderStatus, AccountSummary } from '@shared/types'

const ID: ProviderId = 'github'
const API = 'https://api.github.com'

/** Persisted credential blob (encrypted in tokens.json, never sent to renderer). */
interface GithubCreds {
  token: string
  account?: string
}

/** GitHub REST shapes we touch (only the fields we read). */
interface GhUser {
  login?: string
}
interface GhNotification {
  id: string
  reason: string
  subject?: { title?: string; url?: string | null; type?: string }
  repository?: { full_name?: string }
  updated_at?: string
}
interface GhRepo {
  id: number
  full_name?: string
  description?: string | null
  stargazers_count?: number
  language?: string | null
  html_url?: string
  updated_at?: string
  private?: boolean
}
interface GhIssue {
  id: number
  title?: string
  number?: number
  html_url?: string
  updated_at?: string
  repository?: { full_name?: string }
}
/** An entry from the contents API — a dir listing item OR a single file blob. */
interface GhContentEntry {
  name?: string
  path?: string
  type?: string
  size?: number
  content?: string
  encoding?: string
  html_url?: string
}

export class GithubClient implements ProviderClient {
  readonly id: ProviderId = ID

  /** Secure-store key for one account's credentials. */
  private key(accountId: string): string {
    return accountKey(this.id, accountId)
  }

  /** Decrypt + parse the stored credential blob, or null if absent/corrupt. */
  private readCreds(accountId: string): GithubCreds | null {
    const raw = getToken(this.key(accountId))
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as GithubCreds
      if (parsed && typeof parsed.token === 'string') return parsed
      return null
    } catch {
      return null
    }
  }

  /** Standard GitHub API headers for a given token. */
  private headers(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Decks',
      'X-GitHub-Api-Version': '2022-11-28'
    }
  }

  /** GET an API path with auth, returning parsed JSON or throwing a clean error. */
  private async api<T>(token: string, path: string): Promise<T> {
    const res = await fetch(`${API}${path}`, { headers: this.headers(token) })
    if (!res.ok) {
      throw new Error(`GitHub request failed (${res.status})`)
    }
    return (await res.json()) as T
  }

  async connect(opts: {
    accountId: string
    mode: 'token' | 'oauth'
    token?: string
    fields?: Record<string, string>
  }): Promise<ProviderStatus> {
    try {
      let token: string

      if (opts.mode === 'oauth') {
        const fields = opts.fields ?? {}
        if (!fields.clientId) {
          return { provider: this.id, connected: false, error: 'Missing OAuth client id.' }
        }
        const result = await runOAuth({
          authUrl: 'https://github.com/login/oauth/authorize',
          tokenUrl: 'https://github.com/login/oauth/access_token',
          clientId: fields.clientId,
          clientSecret: fields.clientSecret,
          scopes: ['repo', 'notifications', 'read:user'],
          redirectUri: fields.redirectUri || 'http://127.0.0.1:8888/callback'
        })
        token = result.accessToken
      } else {
        token = (opts.token ?? '').trim()
        if (!token) {
          return { provider: this.id, connected: false, error: 'Missing access token.' }
        }
      }

      // Validate the token by fetching the authenticated user.
      const user = await this.api<GhUser>(token, '/user')
      const account = user.login

      const creds: GithubCreds = { token, account }
      saveToken(this.key(opts.accountId), JSON.stringify(creds))

      const label = account ? `@${account}` : opts.accountId
      upsertAccount(this.id, { id: opts.accountId, label })

      return { provider: this.id, connected: true, account }
    } catch {
      return {
        provider: this.id,
        connected: false,
        error: 'Could not connect to GitHub. Check your token and try again.'
      }
    }
  }

  async fetch(
    accountId: string,
    resource: string,
    _params?: Record<string, unknown>
  ): Promise<unknown> {
    const creds = this.readCreds(accountId)
    if (!creds) throw new Error('GitHub is not connected.')
    const { token } = creds

    switch (resource) {
      case 'notifications':
        return this.fetchNotifications(token)
      case 'repos':
        return this.fetchRepos(token)
      case 'issues':
        return this.fetchIssues(token)
      case 'repoContents':
        return this.fetchRepoContents(
          token,
          String(_params?.fullName ?? ''),
          String(_params?.path ?? '')
        )
      case 'repoReadme':
        return this.fetchRepoReadme(token, String(_params?.fullName ?? ''))
      case 'dashboard':
      default: {
        const [notifications, repos] = await Promise.all([
          this.fetchNotifications(token),
          this.fetchRepos(token)
        ])
        return { notifications, repos }
      }
    }
  }

  private async fetchNotifications(token: string): Promise<unknown[]> {
    const list = await this.api<GhNotification[]>(token, '/notifications')
    return list.map((n) => ({
      id: n.id,
      reason: n.reason,
      title: n.subject?.title ?? '',
      repo: n.repository?.full_name ?? '',
      type: n.subject?.type ?? '',
      updatedAt: n.updated_at ?? '',
      url: this.notificationUrl(n)
    }))
  }

  private async fetchRepos(token: string): Promise<unknown[]> {
    // affiliation=owner → the user's OWN repositories (not ones they only
    // collaborate on), most-recently-updated first, including privates.
    const list = await this.api<GhRepo[]>(
      token,
      '/user/repos?affiliation=owner&sort=updated&per_page=100'
    )
    return list.map((r) => ({
      id: r.id,
      fullName: r.full_name ?? '',
      description: r.description ?? '',
      stars: r.stargazers_count ?? 0,
      language: r.language ?? '',
      htmlUrl: r.html_url ?? '',
      updatedAt: r.updated_at ?? '',
      private: r.private ?? false
    }))
  }

  /**
   * Browse a repo's contents at `path`. The GitHub contents API returns an ARRAY
   * for a directory and an OBJECT (with base64 `content`) for a file — we
   * normalize both into a tagged result the native deck can render in-app.
   */
  private async fetchRepoContents(
    token: string,
    fullName: string,
    path: string
  ): Promise<unknown> {
    if (!fullName) throw new Error('Missing repository.')
    const clean = path.replace(/^\/+/, '')
    const raw = await this.api<unknown>(
      token,
      `/repos/${fullName}/contents/${clean.split('/').map(encodeURIComponent).join('/')}`
    )
    if (Array.isArray(raw)) {
      const entries = (raw as GhContentEntry[])
        .map((e) => ({
          name: e.name ?? '',
          path: e.path ?? '',
          type: e.type === 'dir' ? 'dir' : 'file',
          size: e.size ?? 0
        }))
        // Directories first, then files, each alphabetical.
        .sort((a, b) =>
          a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1
        )
      return { kind: 'dir', path: clean, entries }
    }
    const file = raw as GhContentEntry
    const size = file.size ?? 0
    // Don't try to render giant or binary blobs as text.
    const isBinary = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|mp4|mov|mp3|wav|woff2?|ttf|otf|exe|dll|bin)$/i.test(
      file.name ?? ''
    )
    if (size > 400_000 || isBinary) {
      return { kind: 'file', name: file.name ?? '', path: clean, tooBig: true, htmlUrl: file.html_url ?? '' }
    }
    const text =
      file.content && file.encoding === 'base64'
        ? Buffer.from(file.content, 'base64').toString('utf8')
        : (file.content ?? '')
    return { kind: 'file', name: file.name ?? '', path: clean, text, htmlUrl: file.html_url ?? '' }
  }

  /** A repo's README rendered to text (decoded from base64). '' when none. */
  private async fetchRepoReadme(token: string, fullName: string): Promise<unknown> {
    if (!fullName) throw new Error('Missing repository.')
    try {
      const r = await this.api<GhContentEntry>(token, `/repos/${fullName}/readme`)
      const text =
        r.content && r.encoding === 'base64'
          ? Buffer.from(r.content, 'base64').toString('utf8')
          : (r.content ?? '')
      return { name: r.name ?? 'README', text }
    } catch {
      return { name: '', text: '' }
    }
  }

  private async fetchIssues(token: string): Promise<unknown[]> {
    const list = await this.api<GhIssue[]>(token, '/issues?filter=assigned&state=open&per_page=30')
    return list.map((i) => ({
      id: i.id,
      title: i.title ?? '',
      repo: i.repository?.full_name ?? '',
      number: i.number ?? 0,
      htmlUrl: i.html_url ?? '',
      updatedAt: i.updated_at ?? ''
    }))
  }

  /** Derive a browser URL from a notification's subject (best-effort, simple). */
  private notificationUrl(n: GhNotification): string {
    const apiUrl = n.subject?.url
    if (apiUrl && typeof apiUrl === 'string') {
      // Convert api.github.com/repos/... into the html page where possible.
      const html = apiUrl
        .replace('https://api.github.com/repos/', 'https://github.com/')
        .replace('/pulls/', '/pull/')
      return html
    }
    const repo = n.repository?.full_name
    return repo ? `https://github.com/${repo}` : 'https://github.com/notifications'
  }

  async disconnect(accountId: string): Promise<void> {
    removeToken(this.key(accountId))
    removeAccount(this.id, accountId)
  }

  async status(accountId: string): Promise<ProviderStatus> {
    const creds = this.readCreds(accountId)
    if (!creds) return { provider: this.id, connected: false }
    return { provider: this.id, connected: true, account: creds.account }
  }

  async listAccounts(): Promise<AccountSummary[]> {
    return listProviderAccounts(this.id)
  }
}
