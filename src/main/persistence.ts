/**
 * Decks — persistence.
 *
 * Reads/writes the full `PersistedState` snapshot to a JSON file in the app's
 * userData directory. Loads tolerate a missing/corrupt file (return null).
 * Saves are atomic-ish: write a temp file, then rename over the target.
 */
import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import type { PersistedState } from '@shared/types'

const FILE_NAME = 'decks-state.json'

function statePath(): string {
  return join(app.getPath('userData'), FILE_NAME)
}

/** Read the persisted snapshot, or null if missing/corrupt. Never throws. */
export async function loadState(): Promise<PersistedState | null> {
  const file = statePath()
  try {
    const raw = await fs.readFile(file, 'utf8')
    const parsed = JSON.parse(raw) as PersistedState
    // Minimal shape sanity-check; treat anything unexpected as "no state".
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.workspaces)) {
      return null
    }
    return parsed
  } catch {
    // Missing file, bad JSON, permission error — all mean "nothing to hydrate".
    return null
  }
}

/** Persist the snapshot atomically (temp file + rename). Never throws. */
export async function saveState(state: PersistedState): Promise<void> {
  const file = statePath()
  const tmp = `${file}.${process.pid}.tmp`
  try {
    await fs.mkdir(app.getPath('userData'), { recursive: true })
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8')
    await fs.rename(tmp, file)
  } catch (err) {
    // Best-effort cleanup of the temp file; swallow so a failed save never
    // crashes the renderer call.
    try {
      await fs.unlink(tmp)
    } catch {
      /* ignore */
    }
    console.error('[decks] failed to save state:', err)
  }
}
