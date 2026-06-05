/**
 * Decks — per-provider account index (main process).
 *
 * A provider can have several connected accounts (two Canvas schools, two
 * GitHubs, …). Each account's credentials live in the secure token store under
 * `accountKey(provider, accountId)`; this module keeps the small NON-secret index
 * of which accounts exist (id + display label) under `<provider>#index`, so the
 * Settings UI can list them and a native deck can bind to one.
 *
 * The index is stored via the same encrypted token store for simplicity (it's
 * not sensitive, but keeping one persistence path is tidier).
 */
import { saveToken, getToken } from './tokens'
import type { ProviderId, AccountSummary } from '@shared/types'

const INDEX_SUFFIX = '#index'

/** Secure-store key for one account's credentials. */
export function accountKey(provider: ProviderId, accountId: string): string {
  return `${provider}:${accountId}`
}

/** The list of connected accounts for a provider (empty if none). */
export function listAccounts(provider: ProviderId): AccountSummary[] {
  const raw = getToken(`${provider}${INDEX_SUFFIX}`)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (a): a is AccountSummary =>
        !!a && typeof a === 'object' && typeof (a as AccountSummary).id === 'string'
    )
  } catch {
    return []
  }
}

/** Add or update an account in the provider's index (id is the key). */
export function upsertAccount(provider: ProviderId, account: AccountSummary): void {
  const next = listAccounts(provider).filter((a) => a.id !== account.id)
  next.push(account)
  saveToken(`${provider}${INDEX_SUFFIX}`, JSON.stringify(next))
}

/** Remove an account from the provider's index. */
export function removeAccount(provider: ProviderId, accountId: string): void {
  const next = listAccounts(provider).filter((a) => a.id !== accountId)
  saveToken(`${provider}${INDEX_SUFFIX}`, JSON.stringify(next))
}
