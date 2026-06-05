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
import type { ProviderClient } from './types'
import type { ProviderId, ProviderStatus } from '@shared/types'

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

export class GithubClient implements ProviderClient {
  readonly id: ProviderId = ID

  /** Decrypt + parse the stored credential blob, or null if absent/corrupt. */
  private readCreds(): GithubCreds | null {
    const raw = getToken(this.id)
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
      saveToken(this.id, JSON.stringify(creds))

      return { provider: this.id, connected: true, account }
    } catch {
      return {
        provider: this.id,
        connected: false,
        error: 'Could not connect to GitHub. Check your token and try again.'
      }
    }
  }

  async fetch(resource: string, _params?: Record<string, unknown>): Promise<unknown> {
    const creds = this.readCreds()
    if (!creds) throw new Error('GitHub is not connected.')
    const { token } = creds

    switch (resource) {
      case 'notifications':
        return this.fetchNotifications(token)
      case 'repos':
        return this.fetchRepos(token)
      case 'issues':
        return this.fetchIssues(token)
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
    const list = await this.api<GhRepo[]>(token, '/user/repos?sort=updated&per_page=30')
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

  async disconnect(): Promise<void> {
    removeToken(this.id)
  }

  async status(): Promise<ProviderStatus> {
    const creds = this.readCreds()
    if (!creds) return { provider: this.id, connected: false }
    return { provider: this.id, connected: true, account: creds.account }
  }
}
