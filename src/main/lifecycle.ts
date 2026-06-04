/**
 * Decks — process-lifecycle registry + safe cleanup.
 *
 * HARD RULES (see Phase 1 spec):
 *  - Never blanket-kill by name (no `taskkill /im`, no `pkill node`).
 *  - Only ever kill (a) PIDs we explicitly registered, or (b) the single PID
 *    bound to THIS app's own renderer dev port.
 *  - Cleanup must never throw.
 */
import { execFile } from 'child_process'

/** Every child-process PID this app has spawned. */
const tracked = new Set<number>()

/** Record a PID we spawned so we (and only we) can later kill it. */
export function registerChild(pid: number): void {
  if (typeof pid === 'number' && pid > 0) tracked.add(pid)
}

/** Forget a PID (e.g. once we observed it exit). */
export function unregisterChild(pid: number): void {
  tracked.delete(pid)
}

/** Kill ONLY the PIDs we registered. Best-effort; never throws. */
export function killTrackedChildren(): void {
  for (const pid of tracked) {
    try {
      // SIGKILL — these are our own children and we're tearing down.
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone / no permission — ignore */
    }
  }
  tracked.clear()
}

/**
 * Parse a port number out of a URL like `http://localhost:5173`.
 * Falls back to the default Vite port (5173) when absent/unparseable.
 */
export function rendererDevPort(rendererUrl: string | undefined): number {
  const DEFAULT = 5173
  if (!rendererUrl) return DEFAULT
  try {
    const parsed = new URL(rendererUrl)
    const port = Number(parsed.port)
    return Number.isFinite(port) && port > 0 ? port : DEFAULT
  } catch {
    return DEFAULT
  }
}

/** Run a command and resolve its stdout (empty string on any error). */
function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { windowsHide: true }, (err, stdout) => {
        resolve(err ? '' : stdout || '')
      })
    } catch {
      resolve('')
    }
  })
}

/**
 * Find the PID(s) LISTENING on `port` and kill them. This targets only the one
 * specific port (our own dev port), so a crashed previous run that left the
 * renderer dev server bound can be cleared on the next startup.
 *
 * Cross-platform, guarded by `process.platform`. Never throws.
 */
export async function freeDevPort(port: number): Promise<void> {
  try {
    const pids = new Set<number>()

    if (process.platform === 'win32') {
      // `netstat -ano` lines: Proto  Local  Foreign  State  PID
      const out = await run('netstat', ['-ano'])
      for (const line of out.split(/\r?\n/)) {
        const cols = line.trim().split(/\s+/)
        if (cols.length < 5) continue
        const local = cols[1]
        const state = cols[3]
        const pidStr = cols[4]
        // Only LISTENING sockets, and only on our exact port.
        if (state !== 'LISTENING') continue
        if (!local.endsWith(`:${port}`)) continue
        const pid = Number(pidStr)
        if (Number.isFinite(pid) && pid > 0) pids.add(pid)
      }
    } else {
      // macOS / Linux: lsof gives PIDs of listeners on the port.
      const out = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])
      for (const line of out.split(/\r?\n/)) {
        const pid = Number(line.trim())
        if (Number.isFinite(pid) && pid > 0) pids.add(pid)
      }
    }

    // Never kill ourselves.
    pids.delete(process.pid)

    for (const pid of pids) {
      if (process.platform === 'win32') {
        await run('taskkill', ['/F', '/PID', String(pid)])
      } else {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    // Discovery/kill failure is non-fatal — the dev server may just not be up.
  }
}
