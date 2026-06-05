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
import type { ProviderId, ProviderStatus } from '@shared/types'

export interface ProviderClient {
  /** The provider this client backs. Must be unique in the registry. */
  readonly id: ProviderId

  /**
   * Connect the provider. `mode === 'token'` stores the pasted token (via
   * tokens.ts); `mode === 'oauth'` runs the OAuth helper (../oauth) and stores
   * the resulting token. Resolves with the new status.
   */
  connect(opts: {
    mode: 'token' | 'oauth'
    token?: string
    /** Extra non-secret connection fields (instanceUrl, handle, clientId, …). */
    fields?: Record<string, string>
  }): Promise<ProviderStatus>

  /**
   * Fetch a sanitized resource. `resource` and `params` are provider-defined.
   * Implementations MUST strip secrets before returning.
   */
  fetch(resource: string, params?: Record<string, unknown>): Promise<unknown>

  /** Disconnect: forget the stored token (via tokens.ts) and any cached session. */
  disconnect(): Promise<void>

  /** Report current connection status (typically derived from the stored token). */
  status(): Promise<ProviderStatus>
}
