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

const FILE_NAME = 'tokens.json'

/**
 * On-disk shape: storage key → base64 of the safeStorage-encrypted value.
 *
 * Keys are arbitrary strings so a provider can store several accounts, e.g.
 * `canvas:<accountId>` for one account's credentials and `canvas#index` for that
 * provider's account list. Single-credential providers still just use their id.
 */
type TokenFile = Record<string, string>

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
export function saveToken(key: string, token: string): void {
  if (!encryptionAvailable()) {
    console.warn(
      `[decks] safeStorage encryption unavailable — refusing to store ${key} (fail closed)`
    )
    return
  }
  try {
    const encrypted = safeStorage.encryptString(token)
    const data = readAll()
    data[key] = encrypted.toString('base64')
    writeAll(data)
  } catch (err) {
    // Note: never log the token value.
    console.error(`[decks] failed to encrypt/save value for ${key}:`, err)
  }
}

/** Decrypt and return the value at `key`, or null if absent/undecryptable. */
export function getToken(key: string): string | null {
  if (!encryptionAvailable()) return null
  const blob = readAll()[key]
  if (!blob) return null
  try {
    return safeStorage.decryptString(Buffer.from(blob, 'base64'))
  } catch (err) {
    console.error(`[decks] failed to decrypt value for ${key}:`, err)
    return null
  }
}

/** Forget the stored value at `key`. Never throws. */
export function removeToken(key: string): void {
  const data = readAll()
  if (data[key] === undefined) return
  delete data[key]
  writeAll(data)
}

/** True if an encrypted blob exists at `key` on disk. */
export function hasToken(key: string): boolean {
  return readAll()[key] !== undefined
}
