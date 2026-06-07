/**
 * Decks — JetCore Operations integration.
 *
 * "Operations" is the already-built JetCore Flask backend (a packaged
 * PyInstaller `backend.exe` that serves a full web UI). This module spawns ONE
 * instance bound to a free loopback port, waits until it serves `/health`, and
 * shows its UI full-area inside a single owned `WebContentsView` overlaid on the
 * main window — switchable with the rest of Decks.
 *
 * Mirrors codeserver.ts (free port → spawn → health-poll → tree-kill) and uses
 * the lifecycle registry so the child is never orphaned. Teardown is idempotent
 * and never throws.
 */
import { spawn, type ChildProcess } from 'child_process'
import { createServer } from 'net'
import { get as httpGet } from 'http'
import { existsSync } from 'fs'
import { join, dirname } from 'path'
import { app, WebContentsView, BrowserWindow } from 'electron'
import { IPC } from '@shared/ipc'
import type { OperationsStartResult, OperationsBoundsPayload } from '@shared/ipc'
import type { PanelBounds } from '@shared/types'
import { registerChild, unregisterChild } from './lifecycle'
import { CHROME_UA } from './panels'

/** How long to wait for the backend to answer /health before giving up. */
const READY_TRIES = 40
/** Interval between /health poll attempts (40 × 500ms ≈ 20s). */
const POLL_INTERVAL_MS = 500

/** The running JetCore backend we own (at most one). */
interface ActiveBackend {
  child: ChildProcess
  pid: number
  url: string
}

let active: ActiveBackend | null = null

/** The single Operations WebContentsView (lazily created once started). */
let view: WebContentsView | null = null
/** Whether the view is currently a child of the window's contentView. */
let attached = false
/** Whether loadURL has already been issued for the current view. */
let loaded = false

/** The main window the Operations view is overlaid onto (bound on first use). */
let mainWindowRef: BrowserWindow | null = null

/** Install the process-exit backstop exactly once. */
let exitHookInstalled = false

/** Bind the main window the Operations view overlays. Call once after creation. */
export function setOperationsWindow(win: BrowserWindow): void {
  mainWindowRef = win
}

/**
 * Resolve the JetCore backend executable.
 *  - packaged: <resources>/jetcore-backend/backend.exe (bundled as an extra resource)
 *  - dev: the sibling repo's PyInstaller build. The decks repo lives at
 *    <Apps>/decks and JetCore at <Apps>/JetCore, so we walk up from the decks
 *    project dir (app.getAppPath()) to the parent `Apps` folder and join
 *    'JetCore/dist-pyinstaller/backend/backend.exe'. Computed, never hardcoded.
 */
function resolveBackendExe(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'jetcore-backend', 'backend.exe')
  }
  // app.getAppPath() → <Apps>/decks (the project dir); its parent is <Apps>.
  const appsDir = dirname(app.getAppPath())
  return join(appsDir, 'JetCore', 'dist-pyinstaller', 'backend', 'backend.exe')
}

/**
 * Find a free localhost TCP port: bind to port 0, let the OS pick, then release.
 * Same trick as codeserver.ts; the brief gap before the backend binds is an
 * accepted (negligible) race.
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
        srv.close(() => reject(new Error('Could not determine a free port for JetCore.')))
      }
    })
  })
}

/** One-shot GET http://127.0.0.1:<port>/health — resolves true on HTTP 200. */
function probeHealth(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const req = httpGet({ host: '127.0.0.1', port, path: '/health', timeout: 1500 }, (res) => {
      res.resume() // drain so the socket closes cleanly
      resolve(res.statusCode === 200)
    })
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

/** Round a bounds rect to integer pixels (Electron rejects fractional bounds). */
function toIntBounds(b: PanelBounds): PanelBounds {
  return {
    x: Math.round(b.x),
    y: Math.round(b.y),
    width: Math.round(b.width),
    height: Math.round(b.height)
  }
}

/** Best-effort tree kill of the backend. Never throws. */
function killChild(child: ChildProcess): void {
  const pid = child.pid
  try {
    if (process.platform === 'win32' && typeof pid === 'number') {
      // /T kills the whole process tree (PyInstaller bootloader + child), /F forces it.
      spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true }).on(
        'error',
        () => {
          /* taskkill missing/failed — nothing else to do */
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
 * Start (or reuse) the JetCore backend.
 *
 * @returns `{ url }` of the live backend, or `{ error }` with a clear message.
 *          Never rejects — failures are reported in the resolved result.
 */
export async function startOperations(): Promise<OperationsStartResult> {
  // Singleton: reuse the existing instance.
  if (active) return { url: active.url }

  const exe = resolveBackendExe()
  if (!existsSync(exe)) {
    return {
      error:
        `JetCore backend not found at ${exe}. ` +
        'Build it (JetCore/dist-pyinstaller/backend/backend.exe) and try again.'
    }
  }

  if (!exitHookInstalled) {
    // Backstop: if the app dies without going through cleanup()/stopOperations(),
    // still take our child with us. `process.on('exit')` must be synchronous.
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

  let child: ChildProcess
  try {
    child = spawn(exe, [], {
      cwd: dirname(exe),
      env: { ...process.env, JETCORE_PORT: String(port) },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (err) {
    return { error: `Failed to start JetCore: ${err instanceof Error ? err.message : String(err)}` }
  }

  return new Promise<OperationsStartResult>((resolve) => {
    let settled = false
    let stderrTail = ''

    const finishOk = (): void => {
      if (settled) return
      settled = true
      cleanupListeners()
      const pid = child.pid
      if (typeof pid === 'number') registerChild(pid)
      active = { child, pid: pid ?? -1, url }
      resolve({ url })
    }

    const finishErr = (message: string): void => {
      if (settled) return
      settled = true
      cleanupListeners()
      killChild(child)
      resolve({ error: message })
    }

    const onError = (err: NodeJS.ErrnoException): void => {
      finishErr(`Failed to start JetCore: ${err?.message ?? String(err)}`)
    }

    const onExit = (code: number | null): void => {
      // Early exit before readiness → failure; surface the stderr tail for context.
      finishErr(
        `JetCore backend exited before it was ready (code ${code ?? 'null'}). ` +
          (stderrTail ? `Last output: ${stderrTail.trim().slice(-300)}` : '')
      )
    }

    const cleanupListeners = (): void => {
      child.removeListener('error', onError)
      child.removeListener('exit', onExit)
    }

    child.on('error', onError)
    child.on('exit', onExit)
    // Keep the tail of stderr so an early exit can explain itself; drain the pipe.
    child.stderr?.on('data', (buf: Buffer) => {
      stderrTail = (stderrTail + buf.toString()).slice(-2000)
    })
    child.stdout?.resume()

    // Readiness via /health polling (the only reliable signal — the backend
    // doesn't print a stable "listening" line we can rely on).
    void (async () => {
      for (let i = 0; i < READY_TRIES && !settled; i++) {
        if (await probeHealth(port)) {
          finishOk()
          return
        }
        if (settled) return
        await delay(POLL_INTERVAL_MS)
      }
      if (!settled) {
        finishErr(
          `JetCore did not become ready within ${(READY_TRIES * POLL_INTERVAL_MS) / 1000}s on ${url}.`
        )
      }
    })()
  })
}

/** Lazily create the Operations WebContentsView (the URL is loaded by the caller). */
function ensureView(): WebContentsView {
  if (view) return view
  view = new WebContentsView({
    webPreferences: {
      // Its own persistent session so JetCore logins survive restarts.
      partition: 'persist:jetcore-ops',
      // The separate preload for this view (built by electron-vite to out/preload/).
      // Mirrors how index.ts references the main preload (../preload/index.js).
      preload: join(__dirname, '../preload/operations.js'),
      contextIsolation: true,
      sandbox: false
    }
  })
  // Present as plain Chrome, consistent with the rest of the app's embedded views.
  view.webContents.setUserAgent(CHROME_UA)
  view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
  view.setVisible(false)
  return view
}

/**
 * Show the Operations view full-area over the renderer at `bounds`. Ensures the
 * backend is started and the view created/loaded first. Resolves with no value.
 */
export async function showOperations(payload: OperationsBoundsPayload): Promise<void> {
  const result = await startOperations()
  if (!result.url) return // start failed — renderer already has the error from start()
  const win = mainWindowRef
  if (!win || win.isDestroyed()) return

  const v = ensureView()
  if (!loaded) {
    loaded = true
    void v.webContents.loadURL(result.url).catch((err: NodeJS.ErrnoException) => {
      if (err?.code === 'ERR_ABORTED' || err?.errno === -3) return // benign superseded nav
      console.error('[decks] Operations view failed to load:', err)
    })
  }
  if (!attached) {
    win.contentView.addChildView(v)
    attached = true
  }
  v.setVisible(true)
  v.setBounds(toIntBounds(payload.bounds))
}

/** Hide the Operations view (detach + zero bounds). The backend keeps running. */
export function hideOperations(): void {
  if (!view) return
  try {
    view.setVisible(false)
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
    if (attached && mainWindowRef && !mainWindowRef.isDestroyed()) {
      mainWindowRef.contentView.removeChildView(view)
    }
  } catch {
    /* view may already be gone — ignore */
  }
  attached = false
}

/**
 * Stop Operations entirely: kill the backend, destroy the view, reset state.
 * Idempotent; never throws. Safe to call from cleanup().
 */
export function stopOperations(): void {
  // Tear down the view first.
  if (view) {
    try {
      hideOperations()
      const wc = view.webContents
      if (!wc.isDestroyed()) {
        wc.removeAllListeners()
        wc.close()
      }
    } catch {
      /* ignore */
    }
    view = null
  }
  attached = false
  loaded = false

  // Then kill the backend child.
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

/**
 * Wire the "return to Decks" bridge: when the Operations view's preload sends
 * OperationsRequestDecks, forward OperationsExit to the MAIN renderer so it can
 * flip the UI back from Operations to Decks. Call once from registerIpc().
 */
export function forwardOperationsExit(): void {
  const win = mainWindowRef
  if (!win || win.isDestroyed()) return
  win.webContents.send(IPC.OperationsExit)
}
