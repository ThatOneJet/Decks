/**
 * Decks — generic OAuth 2.0 authorization-code helper (main process only).
 *
 * Runs an OAuth flow in a DEDICATED top-level `BrowserWindow` (never an embedded
 * webview / WebContentsView panel — keeping the auth surface isolated from the
 * sites Decks embeds). The redirect is captured on a short-lived loopback HTTP
 * server at `http://127.0.0.1:<port>/callback`; the redirect origin is validated
 * before the window closes and (optionally) the code is exchanged for tokens.
 *
 * This is a SEAM. No provider uses it in Phase 0 (Canvas pastes a token).
 * Phase 1 providers that need OAuth call `runOAuth(config)` and store the result
 * via ../tokens. It is exported and compiles; nothing wires it yet.
 *
 * Security notes:
 *  - `state` is generated and verified to defeat CSRF on the redirect.
 *  - Only the exact `127.0.0.1:<port>/callback` path is accepted.
 *  - Token VALUES are never logged.
 */
import { BrowserWindow } from 'electron'
import { createServer, type Server } from 'http'
import { randomBytes } from 'crypto'
import { AddressInfo } from 'net'

/** Configuration for one OAuth authorization-code flow. */
export interface OAuthConfig {
  /** Provider's authorization endpoint (the user-facing consent page). */
  authUrl: string
  /**
   * Provider's token endpoint. When omitted, `runOAuth` returns the raw
   * authorization `code` as `accessToken` (for flows that exchange elsewhere).
   */
  tokenUrl?: string
  /** OAuth client id. */
  clientId: string
  /** OAuth client secret, when the provider requires one for the exchange. */
  clientSecret?: string
  /** Requested scopes (space-joined into the authorize URL). */
  scopes?: string[]
  /**
   * Loopback redirect URI registered with the provider. Should point at
   * `http://127.0.0.1:<port>/callback`. The port here is also where the helper
   * listens; pass 0 to let the OS pick a free port (then register that URI).
   */
  redirectUri: string
  /** Extra params appended to the authorize URL (e.g. `access_type=offline`). */
  extraAuthParams?: Record<string, string>
}

/** Result of a successful OAuth flow. */
export interface OAuthResult {
  accessToken: string
  refreshToken?: string
  /** Lifetime in seconds, when the provider reports it. */
  expiresIn?: number
}

/** Parse the loopback `redirectUri` into a listen port + expected pathname. */
function parseRedirect(redirectUri: string): { port: number; pathname: string } {
  const u = new URL(redirectUri)
  if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') {
    throw new Error('redirectUri must be a loopback address (127.0.0.1)')
  }
  return { port: u.port ? Number(u.port) : 0, pathname: u.pathname || '/callback' }
}

/** Build the provider authorize URL with state + scopes. */
function buildAuthUrl(config: OAuthConfig, state: string, redirectUri: string): string {
  const u = new URL(config.authUrl)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('client_id', config.clientId)
  u.searchParams.set('redirect_uri', redirectUri)
  u.searchParams.set('state', state)
  if (config.scopes?.length) u.searchParams.set('scope', config.scopes.join(' '))
  for (const [k, v] of Object.entries(config.extraAuthParams ?? {})) u.searchParams.set(k, v)
  return u.toString()
}

/** Exchange an authorization code for tokens at the provider's token endpoint. */
async function exchangeCode(
  config: OAuthConfig,
  code: string,
  redirectUri: string
): Promise<OAuthResult> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: config.clientId,
    redirect_uri: redirectUri
  })
  if (config.clientSecret) body.set('client_secret', config.clientSecret)

  const res = await fetch(config.tokenUrl as string, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body
  })
  if (!res.ok) throw new Error(`OAuth token exchange failed (${res.status})`)
  const json = (await res.json()) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
  }
  if (!json.access_token) throw new Error('OAuth token response had no access_token')
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresIn: json.expires_in
  }
}

/**
 * Run an OAuth authorization-code flow and resolve with the resulting tokens.
 * Opens a dedicated BrowserWindow for consent, captures the loopback redirect,
 * validates `state`, then (if `tokenUrl` is set) exchanges the code.
 */
export function runOAuth(config: OAuthConfig): Promise<OAuthResult> {
  const { port, pathname } = parseRedirect(config.redirectUri)
  const state = randomBytes(16).toString('hex')

  return new Promise<OAuthResult>((resolve, reject) => {
    let authWindow: BrowserWindow | null = null
    let settled = false

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      try {
        server.close()
      } catch {
        /* ignore */
      }
      if (authWindow && !authWindow.isDestroyed()) authWindow.destroy()
      authWindow = null
      fn()
    }

    const server: Server = createServer((req, res) => {
      try {
        // Resolve against the loopback origin so relative URLs parse cleanly.
        const reqUrl = new URL(req.url ?? '/', `http://127.0.0.1`)
        if (reqUrl.pathname !== pathname) {
          res.writeHead(404).end()
          return
        }
        const returnedState = reqUrl.searchParams.get('state')
        const code = reqUrl.searchParams.get('code')
        const err = reqUrl.searchParams.get('error')

        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end('<html><body>You can close this window and return to Decks.</body></html>')

        if (err) return finish(() => reject(new Error(`OAuth error: ${err}`)))
        if (!code) return finish(() => reject(new Error('OAuth redirect missing code')))
        if (returnedState !== state) {
          return finish(() => reject(new Error('OAuth state mismatch (possible CSRF)')))
        }

        if (!config.tokenUrl) {
          // No exchange configured — hand back the raw code as the access token.
          return finish(() => resolve({ accessToken: code }))
        }
        exchangeCode(config, code, config.redirectUri)
          .then((result) => finish(() => resolve(result)))
          .catch((e) => finish(() => reject(e)))
      } catch (e) {
        finish(() => reject(e as Error))
      }
    })

    server.on('error', (e) => finish(() => reject(e)))

    server.listen(port, '127.0.0.1', () => {
      // If the config used port 0, the redirectUri must already match the chosen
      // port; surface it for callers that pre-register a fixed loopback URI.
      const actualPort = (server.address() as AddressInfo).port
      void actualPort

      authWindow = new BrowserWindow({
        width: 520,
        height: 700,
        title: 'Connect provider',
        autoHideMenuBar: true,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
      })
      authWindow.on('closed', () => {
        finish(() => reject(new Error('OAuth window closed before completing')))
      })
      void authWindow.loadURL(buildAuthUrl(config, state, config.redirectUri))
    })
  })
}
