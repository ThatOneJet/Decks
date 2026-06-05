# Decks

A personal **workspace browser** — an Opera-GX / Arc-style desktop shell that holds
your sites as web "decks" in a fast, customizable rail. Built with Electron +
electron-vite, React 18 + TypeScript, Tailwind, and zustand.

Web pages are real, native **`WebContentsView`s** (never iframes), each on a
persistent `persist:<workspace>` session — so logins survive restarts and sites
that block iframe embedding still load.

---

## Features

- **Icon rail** of workspaces, each showing the site's real app-icon (crisp,
  full-bleed). Active accent pill, animated hover, unread + ▶ playing badges from
  real signals (page-title `(N)` counts and actual audio).
- **Decks & split view** — open multiple sites side-by-side. **Drag a deck into
  the page** to split it evenly (up to 4). Each deck card has reload, focus, and
  delete.
- **Drag-to-group folders** — drag one tile onto another to form a folder
  (auto-named "Group N"); right-click to rename or ungroup; Discord-style 2×2
  preview that expands inline.
- **Add anything by link** — the **+** button (or ⌘/Ctrl+N) adds any URL as a
  deck. ⌘/Ctrl+K opens a fuzzy command palette over workspaces + pinned sites.
- **Native decks** — for services with a real API, Decks renders *our own* UI on
  *their* data instead of embedding their site: **Canvas** (courses + to-dos),
  **GitHub** (notifications + repos), **Spotify** (now-playing + playlists),
  **Bluesky**, **Mastodon**, **RSS** (incl. YouTube channels), and a **Follows
  wall** — one chronological river of Bluesky + Mastodon + RSS, *no algorithm*.
  Connect each under **Settings → Accounts**. Tokens are encrypted with the OS
  keychain (`safeStorage`) and never leave the main process; all API calls happen
  in main, OAuth runs in a dedicated window. Because a native deck is just
  React + JSON, it spawns **no Chromium renderer** — moving a feed from an
  embedded deck to a native one drops a whole renderer process.
- **Closed feeds stay embedded** — Instagram, TikTok, X, Reddit and YouTube have
  no usable personal-feed API, so they remain sandboxed web decks. The rule:
  *real API → native deck; closed logged-in feed → embedded deck; never scrape.*
- **YouTube corner mini-player** — switch away from an audible YouTube deck and
  it shrinks to a still-playing corner video with a now-playing control bar
  (artwork/title from `mediaSession`, play-pause/skip); close expands it back.
- **code-server** — open a local folder in real VS Code (running on 127.0.0.1)
  as a deck, from Settings → Accounts.
- **Custom floating menus & hover cards** that render *above* live web pages via a
  transparent always-on-top overlay window (right-click for Rename / Reset /
  Note / Delete).
- **Focus mode** (⌘/Ctrl+.) collapses the rail onto a single deck.
- **Memory manager** — lazy first-load (≈1 renderer at boot), and a discard sweep
  that frees the renderer process of panels idle past a timeout (never the
  visible or audio-playing ones), reloading them from their URL on return. A live
  RAM meter sits in the rail.
- **Settings deck** — discard timeout, accent color, and a larger memory readout.
- **Responsive** — collapses the rail into a bottom **taskbar dock** in portrait.
- **Safe process lifecycle** — only ever tears down the views/PIDs it spawned
  (never a kill-by-name); nothing lingers after quit.

## Run

```bash
npm install
npm run dev          # electron-vite dev (renderer + main)
# or:
python launcher.py   # frees the dev port, ensures deps, then runs dev
```

Build a production bundle with `npm run build`; typecheck with `npm run typecheck`.

## DRM streaming (Netflix / Disney+ / Spotify)

Vanilla Electron ships **no Widevine CDM**, so DRM video won't play. The app
already has a feature-detected Widevine gate in `src/main/index.ts` (a no-op on
stock Electron); to actually enable DRM, swap Electron for the **castLabs
"Electron for Content Security" (ECS)** drop-in fork, which bundles Widevine:

```bash
# 1) Replace electron with the castLabs build (match your Electron major + "+wvcus"):
npm install --save-dev "github:castlabs/electron-releases#v33.0.0+wvcus"

# 2) First run downloads the Widevine component automatically (the gate awaits it).
npm run dev
```

For a **packaged** build that real services trust, you must VMP-sign with castLabs
EVS (free account): `pip install castlabs-evs && python -m castlabs_evs.account signup`,
then sign the built app with `python -m castlabs_evs.vmp sign-pkg <dist>`. Netflix
also requires the app to present as a real browser (the UA is already de-Electron'd).
Without signing, expect L3-only / limited playback. This isn't bundled here because
it needs your EVS account + signing on your machine.

## Architecture

The code is split into **surfaces** that meet at two contracts in `src/shared`:

- **`types.ts`** — the data model (`Workspace`, `Panel`, `LayoutNode`, `Settings`,
  `PersistedState`).
- **`ipc.ts`** — the main↔renderer boundary: every channel (`IPC`), each payload
  type, and `DecksApi` (the typed surface the preload exposes as `window.decks`).
  Renderer code reaches the main process *only* through this.

**Main process** (`src/main`) owns native concerns: the frameless window; one
`WebContentsView` per visible panel, positioned over renderer "slots"; persistent
partitions; the discard/memory manager (`panels.ts`); the always-on-top
**overlay window** (`overlay.ts`) that hosts hover cards + context menus above web
content; JSON persistence; and safe lifecycle cleanup.

**Preload** (`src/preload`) implements `DecksApi` as a thin forwarder.

**Renderer** (`src/renderer/src`) is React over a zustand store (`store.ts`, UI
state only). `App.tsx` is the integration seam: it hydrates state (persisted →
else `seed.ts`), creates views lazily for the active workspace, wires global
shortcuts, and renders the Sidebar + (Home | SplitView | Settings) + overlay.

```
src/
├─ shared/      types.ts · ipc.ts · seed.ts        (the contract)
├─ main/        index.ts · panels.ts · overlay.ts · persistence.ts · lifecycle.ts
│              tokens.ts (safeStorage) · oauth.ts · codeserver.ts
│              providers/ (registry + canvas · github · spotify · bluesky ·
│                          mastodon · rss · follows-wall — one ProviderClient each)
├─ preload/     index.ts (window.decks)
└─ renderer/src/
   ├─ App.tsx · store.ts · main.tsx · index.css
   ├─ components/  Titlebar · Sidebar · Home · SplitView · CommandPalette
   │              sidebar/ (RailTile · RailFolder · TileIcon · menus)
   │              Settings/ (SettingsDeck · Accounts)
   ├─ native/     NativeDeckHost · registry + <provider>/<Provider>Deck.tsx
   ├─ overlay/    OverlayApp · FloatingHoverCard · OverlayMenu · MiniPlayerBar
   └─ lib/        favicon · layout · platform · useOverlay
```

**Native decks** add a second deck kind: `Panel.kind: 'web' | 'native'`. A web
deck is a `WebContentsView`; a native deck is a React component
(`renderer/src/native/`) fed sanitized JSON from a main-process `ProviderClient`
(`main/providers/`) over the `provider:*` IPC channels — it has no view, so
SplitView renders it inline and it's excluded from view-bounds reporting.

## Keyboard

| Shortcut | Action |
|----------|--------|
| ⌘/Ctrl + K | Command palette (search workspaces + sites) |
| ⌘/Ctrl + N | Add a deck by link |
| ⌘/Ctrl + . | Toggle focus mode |
| Esc | Close palette / menu / exit focus |

## Scope

**In:** rail + folders, native web decks with persistent logins, split view,
drag-to-split, ⌘K, custom overlay menus/hover, focus mode, memory discard, RAM
meter, settings, responsive dock.

**Out (for now):** DRM streaming (Netflix/Spotify need Widevine, absent from
vanilla Electron), accounts/cloud sync, plugins.

## Stack

Electron · electron-vite · React 18 · TypeScript · Tailwind CSS · zustand
