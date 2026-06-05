/**
 * Decks — ProviderClient contract (main process).
 *
 * A ProviderClient is the main-process adapter for one native deck provider
 * (Canvas, GitHub, Reddit, …). It owns all I/O for that service: it reads and
 * writes its OWN token via `../tokens`, talks to the service API, and returns
 * SANITIZED JSON to the renderer (never raw tokens, never the live response with
 * secrets). The registry (./registry) wires these to the provider IPC channels.
 *
 * Phase 0 ships no concrete clients — only this seam. Phase 1 agents implement
 * one class per provider and register it in ./index.
 */
import type { ProviderId, ProviderStatus, AccountSummary } from '@shared/types'

/**
 * A ProviderClient is ACCOUNT-AWARE: every operation is scoped to one connected
 * account (`accountId`), so a provider can hold several at once (two Canvas
 * schools, two GitHubs). Credentials are stored per account under
 * `accountKey(id, accountId)` (see ../accounts); the account list is the index
 * `listAccounts(id)` returns.
 */
export interface ProviderClient {
  /** The provider this client backs. Must be unique in the registry. */
  readonly id: ProviderId

  /**
   * Connect (or re-connect) ONE account. `mode === 'token'` stores the pasted
   * token; `mode === 'oauth'` runs the OAuth helper. On success the client
   * persists the credential under `accountId` and adds it to the account index.
   */
  connect(opts: {
    accountId: string
    mode: 'token' | 'oauth'
    token?: string
    /** Extra non-secret connection fields (instanceUrl, handle, clientId, …). */
    fields?: Record<string, string>
  }): Promise<ProviderStatus>

  /**
   * Fetch a sanitized resource for one account. `resource`/`params` are
   * provider-defined. Implementations MUST strip secrets before returning.
   */
  fetch(accountId: string, resource: string, params?: Record<string, unknown>): Promise<unknown>

  /** Disconnect one account: forget its stored credential + index entry. */
  disconnect(accountId: string): Promise<void>

  /** Report one account's connection status (derived from stored credentials). */
  status(accountId: string): Promise<ProviderStatus>

  /** List this provider's connected accounts (for the Settings UI). */
  listAccounts(): Promise<AccountSummary[]>
}
