/**
 * Decks — provider registry + IPC wiring (main process).
 *
 * Holds the live `ProviderClient` instances keyed by ProviderId, and bridges the
 * provider IPC channels (see @shared/ipc) to whichever client is registered.
 *
 * Seam for Phase 1: concrete clients are constructed and `registerProvider`'d in
 * ./index (called once on startup). Nothing provider-specific lives here.
 */
import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import type { ProviderConnectPayload, ProviderFetchPayload } from '@shared/ipc'
import type { ProviderId, ProviderStatus, AccountSummary } from '@shared/types'
import type { ProviderClient } from './types'

const registry = new Map<ProviderId, ProviderClient>()

/** Register a provider client. Last registration for an id wins. */
export function registerProvider(client: ProviderClient): void {
  registry.set(client.id, client)
}

/** Look up a registered client, or undefined if none is registered for `id`. */
export function getProvider(id: ProviderId): ProviderClient | undefined {
  return registry.get(id)
}

/** A status describing "no client wired for this provider yet". */
function notRegisteredStatus(provider: ProviderId): ProviderStatus {
  return {
    provider,
    connected: false,
    error: `Provider "${provider}" is not available yet.`
  }
}

/** Resolve a client or throw a handled error for invoke handlers to surface. */
function requireProvider(id: ProviderId): ProviderClient {
  const client = registry.get(id)
  if (!client) throw new Error(`Provider "${id}" is not available yet.`)
  return client
}

/**
 * Wire the provider IPC channels to the registry. Call once from registerIpc().
 * Connect/Status return a ProviderStatus error (rather than throwing) when no
 * client is registered, so the renderer can render a clean "coming soon" state.
 * Fetch/Disconnect throw a handled error (rejecting the invoke promise).
 */
export function registerProviderIpc(): void {
  ipcMain.handle(
    IPC.ProviderConnect,
    (_e, p: ProviderConnectPayload): Promise<ProviderStatus> => {
      const client = registry.get(p.provider)
      if (!client) return Promise.resolve(notRegisteredStatus(p.provider))
      return client.connect({
        accountId: p.accountId,
        mode: p.mode,
        token: p.token,
        fields: p.fields
      })
    }
  )

  ipcMain.handle(IPC.ProviderFetch, (_e, p: ProviderFetchPayload): Promise<unknown> => {
    return requireProvider(p.provider).fetch(p.accountId, p.resource, p.params)
  })

  ipcMain.handle(
    IPC.ProviderDisconnect,
    (_e, provider: ProviderId, accountId: string): Promise<void> => {
      return requireProvider(provider).disconnect(accountId)
    }
  )

  ipcMain.handle(
    IPC.ProviderStatus,
    (_e, provider: ProviderId, accountId: string): Promise<ProviderStatus> => {
      const client = registry.get(provider)
      if (!client) return Promise.resolve(notRegisteredStatus(provider))
      return client.status(accountId)
    }
  )

  ipcMain.handle(IPC.ProviderAccounts, (_e, provider: ProviderId): Promise<AccountSummary[]> => {
    const client = registry.get(provider)
    if (!client) return Promise.resolve([])
    return client.listAccounts()
  })
}
