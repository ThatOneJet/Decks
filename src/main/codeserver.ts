/**
 * Decks — code-server integration.
 *
 * code-server (https://github.com/coder/code-server) is full VS Code running as a
 * local web server. This module spawns a single `code-server` instance pointed at
 * a folder, binds it to loopback only, waits until it is serving, and hands back a
 * `http://127.0.0.1:<port>` URL the orchestrator can open as an embedded web deck.
 *
 * HARD RULES:
 *  - Never leave an orphaned process. The spawned PID is registered with the
 *    lifecycle registry (killed on quit via the app's cleanup()), AND we install a
 *    `process` exit backstop, AND `stopCodeServer()` is exported for explicit
 *    teardown. Teardown is idempotent and never throws.
 *  - Bind 127.0.0.1 ONLY (loopback). `--auth none` is acceptable precisely because
 *    the socket is not reachable off-host. Never bind 0.0.0.0.
 *  - code-server is NOT an npm dependency; it must be found on the user's PATH.
 */
import { spawn, type ChildProcess } from 'child_process'
import { createServer } from 'net'
import { get as httpGet } from 'http'
import { registerChild, unregisterChild } from './lifecycle'

/** A running code-server instance we own. */
interface ActiveServer {
  child: ChildProcess
  pid: number
  url: string
  folder: string
}

/** Module singleton — at most one code-server is ever running. */
let active: ActiveServer | null = null

/** Install the process-exit backstop exactly once. */
let exitHookInstalled = false

/** How long to wait for code-server to become ready before giving up. */
const READY_TIMEOUT_MS = 20_000

/** Interval between /healthz poll attempts. */
const POLL_INTERVAL_MS = 300

/**
 * Find a free localhost TCP port: bind a server to port 0, let the OS pick, read
 * the assigned port, then release it. Standard trick. The brief gap between close
 * and code-server binding is an accepted (and practically negligible) race.
 */
function findFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr && typeof addr === 'object') {
        const port = addr.port
        srv.close(() => resolve(port))
      } else {
        srv.close(() => reject(new Error('Could not determine a free port for code-server.')))
      }
    })
  })
}

/** One-shot GET http://127.0.0.1:<port>/healthz — resolves true on HTTP 200. */
function probeHealthz(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const req = httpGet(
      { host: '127.0.0.1', port, path: '/healthz', timeout: 1500 },
      (res) => {
        // Drain so the socket can be reused/closed cleanly.
        res.resume()
        resolve(res.statusCode === 200)
      }
    )
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
    req.on('error', () => resolve(false))
  })
}

/** Sleep helper. */
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Spawn `code-server`. On Windows the resolvable binary on PATH is usually
 * `code-server.cmd`; `shell: true` lets the shell perform PATHEXT resolution so we
 * find it without hardcoding the extension. `windowsHide` keeps a console window
 * from flashing. Returns the child; readiness is handled by the caller.
 */
function spawnCodeServer(port: number, folder: string): ChildProcess {
  const args = [
    '--auth',
    'none',
    '--disable-telemetry',
    '--bind-addr',
    `127.0.0.1:${port}`,
    folder
  ]
  return spawn('code-server', args, {
    shell: true,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

/** Best-effort tree kill. Never throws. */
function killChild(child: ChildProcess): void {
  const pid = child.pid
  try {
    if (process.platform === 'win32' && typeof pid === 'number') {
      // `shell: true` means the tracked PID is the shell; child VS Code procs are
      // descendants. /T kills the whole tree, /F forces it.
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }).on(
        'error',
        () => {
          /* taskkill missing/failed — fall back below */
        }
      )
    } else {
      child.kill('SIGKILL')
    }
  } catch {
    /* swallow — teardown must never throw */
  }
}

/**
 * Start (or reuse) code-server pointed at `folder`.
 *
 * @returns `{ url }` of the live, ready local server.
 * @throws  if code-server is not installed (ENOENT), or it never became ready,
 *          or it exited early.
 */
export async function startCodeServer(folder: string): Promise<{ url: string }> {
  // Singleton: reuse the existing instance regardless of the requested folder.
  // (code-server serves a whole VS Code; the orchestrator opens specific folders
  // within it. Spawning a second instance would leak processes.)
  if (active) return { url: active.url }

  if (!exitHookInstalled) {
    // Backstop: if the app dies without going through cleanup()/stopCodeServer(),
    // still take our child with us. `process.on('exit')` must be synchronous, so
    // we just fire the kill and clear state.
    const onExit = (): void => {
      if (active) {
        killChild(active.child)
        active = null
      }
    }
    process.once('exit', onExit)
    exitHookInstalled = true
  }

  const port = await findFreePort()
  const url = `http://127.0.0.1:${port}`

  const child = spawnCodeServer(port, folder)

  return new Promise<{ url: string }>((resolve, reject) => {
    let settled = false
    let sawListening = false
    // Keep the tail of stderr so an early exit can explain itself. With shell:true
    // a missing binary doesn't raise ENOENT — the shell prints "not recognized" /
    // "command not found" and exits non-zero, so we sniff for that here.
    let stderrTail = ''
    const looksMissing = (s: string): boolean =>
      /not recognized|command not found|No such file|cannot find/i.test(s)

    const finishOk = (): void => {
      if (settled) return
      settled = true
      cleanupListeners()
      const pid = child.pid
      if (typeof pid === 'number') registerChild(pid)
      active = { child, pid: pid ?? -1, url, folder }
      // Once tracked & active, keep the child alive independent of this scope.
      resolve({ url })
    }

    const finishErr = (err: Error): void => {
      if (settled) return
      settled = true
      cleanupListeners()
      killChild(child)
      reject(err)
    }

    const onError = (err: NodeJS.ErrnoException): void => {
      if (err && err.code === 'ENOENT') {
        finishErr(
          new Error(
            'code-server is not installed. Install it (npm i -g code-server, or see coder/code-server) and try again.'
          )
        )
      } else {
        finishErr(
          new Error(`Failed to start code-server: ${err?.message ?? String(err)}`)
        )
      }
    }

    const onExit = (code: number | null): void => {
      // Early exit before readiness → failure. With shell:true a missing binary
      // exits non-zero rather than raising ENOENT, so check stderr for the
      // shell's "not found" message and report it as a clean not-installed error.
      if (looksMissing(stderrTail) || code === 127) {
        finishErr(
          new Error(
            'code-server is not installed. Install it (npm i -g code-server, or see ' +
              'coder/code-server) and try again.'
          )
        )
        return
      }
      finishErr(
        new Error(
          `code-server exited before it was ready (code ${code ?? 'null'}). ` +
            'Ensure it is installed and on PATH (npm i -g code-server).'
        )
      )
    }

    const onStdout = (buf: Buffer): void => {
      const text = buf.toString()
      if (
        text.includes('HTTP server listening on') ||
        text.includes(`listening on http://127.0.0.1:${port}`) ||
        text.includes('listening on http://127.0.0.1')
      ) {
        sawListening = true
        finishOk()
      }
    }

    const cleanupListeners = (): void => {
      child.removeListener('error', onError)
      child.removeListener('exit', onExit)
      child.stdout?.removeListener('data', onStdout)
    }

    child.on('error', onError)
    child.on('exit', onExit)
    child.stdout?.on('data', onStdout)
    // Keep the tail of stderr (so onExit can diagnose) and drain the pipe.
    child.stderr?.on('data', (buf: Buffer) => {
      stderrTail = (stderrTail + buf.toString()).slice(-2000)
    })

    // Readiness via /healthz polling, in parallel with the stdout sniff above.
    // Whichever proves the server is up first wins.
    void (async () => {
      const deadline = Date.now() + READY_TIMEOUT_MS
      while (!settled && Date.now() < deadline) {
        if (await probeHealthz(port)) {
          finishOk()
          return
        }
        if (settled) return
        await delay(POLL_INTERVAL_MS)
      }
      if (!settled) {
        finishErr(
          new Error(
            sawListening
              ? `code-server reported listening but /healthz never responded on ${url}.`
              : `code-server did not become ready within ${READY_TIMEOUT_MS / 1000}s.`
          )
        )
      }
    })()
  })
}

/**
 * Stop the running code-server (if any) and clear state. Idempotent; never throws.
 * Safe to call from the orchestrator's cleanup().
 */
export function stopCodeServer(): void {
  const current = active
  active = null
  if (!current) return
  try {
    if (current.pid > 0) unregisterChild(current.pid)
  } catch {
    /* ignore */
  }
  killChild(current.child)
}

/** True iff a code-server instance is currently tracked as running. */
export function isCodeServerRunning(): boolean {
  return active !== null
}

/** The URL of the running code-server, or null if none is running. */
export function codeServerUrl(): string | null {
  return active ? active.url : null
}
