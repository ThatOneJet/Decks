"""
Decks launcher.

Frees the app's own Vite dev port (only the PID bound to it — never a blanket
kill), makes sure dependencies and the Electron binary are present, then starts
`npm run dev` (electron-vite: renderer dev server + Electron main).

Usage:  python launcher.py
"""
import os
import sys
import shutil
import subprocess

BASE_DIR     = os.path.dirname(os.path.abspath(__file__))
NODE_MODULES = os.path.join(BASE_DIR, 'node_modules')
ELECTRON_BIN = os.path.join(NODE_MODULES, 'electron', 'dist',
                            'electron.exe' if os.name == 'nt' else 'electron')
VITE_PORT    = 5173            # electron-vite renderer dev server


def npm_cmd():
    """Resolve npm (npm.cmd on Windows)."""
    return shutil.which('npm.cmd') or shutil.which('npm') or 'npm'


# ── Free ONLY the process bound to our own dev port ──────────────────────────

def free_port(port):
    """Kill just the PID listening on `port`. Never a kill-by-name."""
    try:
        if os.name == 'nt':
            out = subprocess.check_output(
                f'netstat -ano | findstr :{port}', shell=True,
                encoding='utf-8', stderr=subprocess.DEVNULL
            )
            pids = set()
            for line in out.splitlines():
                if 'LISTENING' in line:
                    parts = line.split()
                    if parts:
                        pids.add(parts[-1])
            for pid in pids:
                subprocess.run(f'taskkill /F /PID {pid}', shell=True,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                print(f'[Decks] Freed dev port {port} (PID {pid}).')
        else:
            out = subprocess.check_output(
                ['lsof', '-ti', f'tcp:{port}', '-sTCP:LISTEN'],
                encoding='utf-8', stderr=subprocess.DEVNULL
            )
            for pid in out.split():
                subprocess.run(['kill', '-9', pid],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                print(f'[Decks] Freed dev port {port} (PID {pid}).')
    except subprocess.CalledProcessError:
        pass  # nothing on the port
    except Exception as e:
        print(f'[Decks] Port-free skipped: {e}')


# ── Dependencies ─────────────────────────────────────────────────────────────

def ensure_deps():
    npm = npm_cmd()
    if not os.path.isdir(NODE_MODULES):
        print('[Decks] Installing dependencies (first run)…')
        r = subprocess.run([npm, 'install'], cwd=BASE_DIR, shell=(os.name == 'nt'))
        if r.returncode != 0:
            print('[Decks] npm install failed.')
            sys.exit(1)

    # The Electron binary download can be skipped on a flaky network; fetch it.
    if not os.path.isfile(ELECTRON_BIN):
        print('[Decks] Electron binary missing — downloading…')
        subprocess.run([npm, 'rebuild', 'electron'],
                       cwd=BASE_DIR, shell=(os.name == 'nt'))
        if not os.path.isfile(ELECTRON_BIN):
            print('[Decks] Could not fetch Electron. Run `npm rebuild electron` '
                  'once on a stable connection, then retry.')
            sys.exit(1)


# ── Run ──────────────────────────────────────────────────────────────────────

def main():
    free_port(VITE_PORT)
    ensure_deps()

    env = os.environ.copy()
    # If this var is set, electron.exe runs as plain Node and `app` is undefined.
    # Strip it so the app always boots as a real Electron process.
    env.pop('ELECTRON_RUN_AS_NODE', None)

    print('[Decks] Starting (npm run dev)…  Ctrl+C to stop.')
    try:
        subprocess.run([npm_cmd(), 'run', 'dev'], cwd=BASE_DIR,
                       shell=(os.name == 'nt'), env=env)
    except KeyboardInterrupt:
        print('\n[Decks] Stopped.')
    finally:
        free_port(VITE_PORT)


if __name__ == '__main__':
    main()
