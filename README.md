# Decks — a personal workspace browser

An Opera-GX-style desktop shell that holds web panels in a customizable sidebar.
Electron + electron-vite, React 18 + TypeScript, Tailwind, zustand. Web panels are
native `WebContentsView`s (never iframes) with persistent `persist:<workspace>`
session partitions so logins survive restarts.

## How the pieces connect

The codebase is split into **surfaces** that meet at two contracts in `src/shared`:

- **`src/shared/types.ts`** — the data model (`Workspace`, `Panel`, `LayoutNode`,
  `PersistedState`). The one source of truth for shapes.
- **`src/shared/ipc.ts`** — the main↔renderer boundary: every channel name (`IPC`),
  each payload type, and `DecksApi` (the typed surface the preload exposes as
  `window.decks`). Renderer code only ever reaches the main process through this.

The **main process** (`src/main`) owns native concerns: the frameless window, one
`WebContentsView` per panel positioned over renderer "slots", persistent session
partitions, every `IPC` handler, disk persistence, and the process-lifecycle
registry that tears down only the PIDs/views it spawned (never a kill-by-name).

The **preload** (`src/preload`) implements `DecksApi` as a thin forwarder.

The **renderer** (`src/renderer/src`) is plain React over a zustand store
(`store.ts`): UI state only. Surfaces:

- `components/Sidebar.tsx` — the live-state workspace rail.
- `components/CommandPalette.tsx` — ⌘K fuzzy launcher.
- `components/Home.tsx` + `components/SplitView.tsx` — home screen (one React Bits
  animated background) and the split-panel layout that reports slot rects to main
  so the native web views sit exactly over them.
- `components/Titlebar.tsx` — frameless drag region + window controls.

`App.tsx` is the integration seam: it hydrates state (persisted → else `seed.ts`),
wires the global ⌘K/Esc keys, and renders Sidebar + (Home | SplitView) + palette.

## File tree

```
decks/
├─ electron.vite.config.ts        # main / preload / renderer builds + @ / @shared aliases
├─ tailwind.config.js             # dark palette tokens
├─ src/
│  ├─ shared/                     # CONTRACT — imported by both sides
│  │  ├─ types.ts                 #   domain model
│  │  ├─ ipc.ts                   #   channels + payloads + DecksApi
│  │  └─ seed.ts                  #   default workspaces (first launch)
│  ├─ main/index.ts               # window, WebContentsViews, IPC handlers, lifecycle
│  ├─ preload/
│  │  ├─ index.ts                 # exposes window.decks (implements DecksApi)
│  │  └─ index.d.ts               # global Window typing
│  └─ renderer/
│     ├─ index.html
│     └─ src/
│        ├─ main.tsx  App.tsx  store.ts  index.css
│        └─ components/  Titlebar Sidebar Home SplitView CommandPalette
```

## Run

```
npm install
npm run dev
```

## Scope (v0)

IN: sidebar, webview switching with persistent logins, ⌘K, home screen with one
animated background, split view, safe process cleanup.
OUT (deferred): DRM streaming (no Widevine in vanilla Electron), accounts, cloud
sync, plugins, theme editor.
