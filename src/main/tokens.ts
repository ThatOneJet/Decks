/**
 * Decks — secure token store (main process only).
 *
 * Provider credentials (personal access tokens / OAuth tokens) are encrypted
 * with Electron's `safeStorage`, which is backed by the OS keychain
 * (Keychain on macOS, libsecret on Linux, DPAPI on Windows). The encrypted
 * blobs are persisted to a SEPARATE file `tokens.json` in userData — NEVER the
 * decks-state.json snapshot (which is plaintext and shipped through the renderer).
 *
 * Security rules enforced here:
 *  - Fail CLOSED: if `safeStorage.isEncryptionAvailable()` is false we refuse to
 *    store anything (we never write plaintext) and log a one-line warning.
 *  - Token VALUES are never logged.
 *  - This module is the only thing that reads/writes tokens.json.
 */
import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'fs'
import { join } from 'path'
import type { ProviderId } from '@shared/types'

const FILE_NAME = 'tokens.json'

/** On-disk shape: provider id → base64 of the safeStorage-encrypted token. */
type TokenFile = Partial<Record<ProviderId, string>>

function tokensPath(): string {
  return join(app.getPath('userData'), FILE_NAME)
}

/** True if OS-backed encryption is available; otherwise we fail closed. */
function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

/** Read the encrypted blob map from disk. Never throws; returns {} on any error. */
function readAll(): TokenFile {
  try {
    const raw = readFileSync(tokensPath(), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    return parsed as TokenFile
  } catch {
    return {}
  }
}

/** Persist the encrypted blob map atomically (temp + rename). Never throws. */
function writeAll(data: TokenFile): void {
  const file = tokensPath()
  const tmp = `${file}.${process.pid}.tmp`
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(tmp, JSON.stringify(data), 'utf8')
    renameSync(tmp, file)
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      /* ignore */
    }
    console.error('[decks] failed to write tokens.json:', err)
  }
}

/**
 * Encrypt and persist a provider's token. Fails closed (no-op + warning) if
 * OS encryption is unavailable, so we never write a plaintext secret to disk.
 */
export function saveToken(provider: ProviderId, token: string): void {
  if (!encryptionAvailable()) {
    console.warn(
      `[decks] safeStorage encryption unavailable — refusing to store ${provider} token (fail closed)`
    )
    return
  }
  try {
    const encrypted = safeStorage.encryptString(token)
    const data = readAll()
    data[provider] = encrypted.toString('base64')
    writeAll(data)
  } catch (err) {
    // Note: never log the token value.
    console.error(`[decks] failed to encrypt/save token for ${provider}:`, err)
  }
}

/** Decrypt and return a provider's token, or null if absent/undecryptable. */
export function getToken(provider: ProviderId): string | null {
  if (!encryptionAvailable()) return null
  const blob = readAll()[provider]
  if (!blob) return null
  try {
    return safeStorage.decryptString(Buffer.from(blob, 'base64'))
  } catch (err) {
    console.error(`[decks] failed to decrypt token for ${provider}:`, err)
    return null
  }
}

/** Forget a provider's stored token. Never throws. */
export function removeToken(provider: ProviderId): void {
  const data = readAll()
  if (data[provider] === undefined) return
  delete data[provider]
  writeAll(data)
}

/** True if an encrypted token blob exists for the provider on disk. */
export function hasToken(provider: ProviderId): boolean {
  return readAll()[provider] !== undefined
}
