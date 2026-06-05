/**
 * Decks — Spotify provider client (main process).
 *
 * Backs the native Spotify deck via OAuth (authorization code). The user
 * registers their own Spotify app and supplies clientId/clientSecret plus a
 * loopback redirect URI. Access tokens are short-lived; `validToken()` refreshes
 * transparently using the stored refresh token and re-persists the blob.
 *
 * Credentials live ONLY in main, encrypted via ../tokens. All HTTP happens here
 * with the global `fetch`; the renderer receives sanitized JSON. Secrets are
 * never logged or returned to the renderer.
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

const ID: ProviderId = 'spotify'
const API = 'https://api.spotify.com'
const TOKEN_URL = 'https://accounts.spotify.com/api/token'

const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'playlist-read-private',
  'user-read-recently-played',
  'user-top-read'
]

/** Persisted credential blob (encrypted in tokens.json, never sent to renderer). */
interface SpotifyCreds {
  accessToken: string
  refreshToken: string
  /** Epoch ms when the access token expires. */
  expiresAt: number
  clientId: string
  clientSecret: string
  account?: string
}

/** Spotify shapes we touch (only the fields we read). */
interface SpImage {
  url?: string
}
interface SpArtist {
  name?: string
}
interface SpTrack {
  name?: string
  artists?: SpArtist[]
  album?: { name?: string; images?: SpImage[] }
  duration_ms?: number
}
interface SpPlayer {
  is_playing?: boolean
  progress_ms?: number
  item?: SpTrack | null
  device?: { name?: string }
}
interface SpPlaylist {
  id: string
  name?: string
  images?: SpImage[]
  tracks?: { total?: number }
  owner?: { display_name?: string }
}
interface SpRecentItem {
  track?: SpTrack
  played_at?: string
}

export class SpotifyClient implements ProviderClient {
  readonly id: ProviderId = ID

  /** Secure-store key for one account's credential blob. */
  private key(accountId: string): string {
    return accountKey(this.id, accountId)
  }

  /** Decrypt + parse the stored credential blob, or null if absent/corrupt. */
  private readCreds(accountId: string): SpotifyCreds | null {
    const raw = getToken(this.key(accountId))
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as SpotifyCreds
      if (parsed && typeof parsed.accessToken === 'string' && typeof parsed.refreshToken === 'string') {
        return parsed
      }
      return null
    } catch {
      return null
    }
  }

  private save(accountId: string, creds: SpotifyCreds): void {
    saveToken(this.key(accountId), JSON.stringify(creds))
  }

  /**
   * Return a valid access token, refreshing (and re-saving) if it has expired
   * or is within a 60s safety margin. Throws if not connected or refresh fails.
   */
  private async validToken(accountId: string): Promise<{ token: string; creds: SpotifyCreds }> {
    const creds = this.readCreds(accountId)
    if (!creds) throw new Error('Spotify is not connected.')

    const margin = 60_000
    if (Date.now() < creds.expiresAt - margin) {
      return { token: creds.accessToken, creds }
    }

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: creds.refreshToken,
      client_id: creds.clientId,
      client_secret: creds.clientSecret
    })
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body
    })
    if (!res.ok) throw new Error(`Spotify token refresh failed (${res.status})`)
    const json = (await res.json()) as {
      access_token?: string
      refresh_token?: string
      expires_in?: number
    }
    if (!json.access_token) throw new Error('Spotify refresh response had no access_token')

    const next: SpotifyCreds = {
      ...creds,
      accessToken: json.access_token,
      // Spotify may or may not rotate the refresh token; keep the old one if absent.
      refreshToken: json.refresh_token ?? creds.refreshToken,
      expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000
    }
    this.save(accountId, next)
    return { token: next.accessToken, creds: next }
  }

  /** Authenticated request to the Spotify Web API. Returns the Response. */
  private async req(
    token: string,
    path: string,
    init?: { method?: string }
  ): Promise<Response> {
    return fetch(`${API}${path}`, {
      method: init?.method ?? 'GET',
      headers: { Authorization: `Bearer ${token}` }
    })
  }

  /** GET + parse JSON, throwing a clean error on non-2xx. */
  private async getJson<T>(token: string, path: string): Promise<T> {
    const res = await this.req(token, path)
    if (!res.ok) throw new Error(`Spotify request failed (${res.status})`)
    return (await res.json()) as T
  }

  async connect(opts: {
    accountId: string
    mode: 'token' | 'oauth'
    token?: string
    fields?: Record<string, string>
  }): Promise<ProviderStatus> {
    try {
      const { accountId } = opts
      const fields = opts.fields ?? {}
      const clientId = fields.clientId
      const clientSecret = fields.clientSecret
      if (!clientId || !clientSecret) {
        return {
          provider: this.id,
          connected: false,
          error: 'Spotify needs a client id and client secret.'
        }
      }

      const result = await runOAuth({
        authUrl: 'https://accounts.spotify.com/authorize',
        tokenUrl: TOKEN_URL,
        clientId,
        clientSecret,
        scopes: SCOPES,
        redirectUri: fields.redirectUri || 'http://127.0.0.1:8888/callback'
      })

      if (!result.refreshToken) {
        return {
          provider: this.id,
          connected: false,
          error: 'Spotify did not return a refresh token.'
        }
      }

      const creds: SpotifyCreds = {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresAt: Date.now() + (result.expiresIn ?? 3600) * 1000,
        clientId,
        clientSecret
      }

      // Resolve the account label (best-effort; non-fatal if it fails).
      try {
        const me = await this.getJson<{ display_name?: string; id?: string }>(
          creds.accessToken,
          '/v1/me'
        )
        creds.account = me.display_name ?? me.id
      } catch {
        /* account label is optional */
      }

      this.save(accountId, creds)
      upsertAccount(this.id, { id: accountId, label: creds.account ?? 'Spotify' })
      return { provider: this.id, connected: true, account: creds.account }
    } catch {
      return {
        provider: this.id,
        connected: false,
        error: 'Could not connect to Spotify. Check your app credentials and try again.'
      }
    }
  }

  async fetch(
    accountId: string,
    resource: string,
    _params?: Record<string, unknown>
  ): Promise<unknown> {
    if (resource.startsWith('control:')) {
      return this.control(accountId, resource.slice('control:'.length))
    }

    const { token } = await this.validToken(accountId)

    switch (resource) {
      case 'now-playing':
        return this.fetchNowPlaying(token)
      case 'playlists':
        return this.fetchPlaylists(token)
      case 'recently-played':
        return this.fetchRecentlyPlayed(token)
      case 'dashboard':
      default: {
        const [nowPlaying, playlists, recentlyPlayed] = await Promise.all([
          this.fetchNowPlaying(token),
          this.fetchPlaylists(token),
          this.fetchRecentlyPlayed(token)
        ])
        return { nowPlaying, playlists, recentlyPlayed }
      }
    }
  }

  private async fetchNowPlaying(token: string): Promise<unknown> {
    const res = await this.req(token, '/v1/me/player')
    if (res.status === 204) return null
    if (!res.ok) throw new Error(`Spotify request failed (${res.status})`)
    const data = (await res.json()) as SpPlayer
    const track = data.item ?? null
    if (!track) return null
    return {
      isPlaying: data.is_playing ?? false,
      track: track.name ?? '',
      artists: (track.artists ?? []).map((a) => a.name ?? '').filter(Boolean),
      album: track.album?.name ?? '',
      artwork: track.album?.images?.[0]?.url ?? '',
      progressMs: data.progress_ms ?? 0,
      durationMs: track.duration_ms ?? 0,
      deviceName: data.device?.name ?? ''
    }
  }

  private async fetchPlaylists(token: string): Promise<unknown[]> {
    const data = await this.getJson<{ items?: SpPlaylist[] }>(token, '/v1/me/playlists?limit=30')
    return (data.items ?? []).map((p) => ({
      id: p.id,
      name: p.name ?? '',
      image: p.images?.[0]?.url ?? '',
      tracks: p.tracks?.total ?? 0,
      owner: p.owner?.display_name ?? ''
    }))
  }

  private async fetchRecentlyPlayed(token: string): Promise<unknown[]> {
    const data = await this.getJson<{ items?: SpRecentItem[] }>(
      token,
      '/v1/me/player/recently-played?limit=20'
    )
    return (data.items ?? []).map((it) => {
      const track = it.track
      return {
        track: track?.name ?? '',
        artists: (track?.artists ?? []).map((a) => a.name ?? '').filter(Boolean),
        artwork: track?.album?.images?.[0]?.url ?? '',
        playedAt: it.played_at ?? ''
      }
    })
  }

  /**
   * Playback controls. Spotify control endpoints require Premium; a 403 is
   * surfaced as `{ ok: false, premiumRequired: true }` so the UI can hint.
   */
  private async control(
    accountId: string,
    action: string
  ): Promise<{ ok: boolean; premiumRequired?: boolean }> {
    const { token } = await this.validToken(accountId)

    let path: string
    let method: string
    switch (action) {
      case 'play':
        path = '/v1/me/player/play'
        method = 'PUT'
        break
      case 'pause':
        path = '/v1/me/player/pause'
        method = 'PUT'
        break
      case 'next':
        path = '/v1/me/player/next'
        method = 'POST'
        break
      case 'prev':
        path = '/v1/me/player/previous'
        method = 'POST'
        break
      default:
        return { ok: false }
    }

    const res = await this.req(token, path, { method })
    if (res.status === 403) return { ok: false, premiumRequired: true }
    return { ok: res.ok }
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
