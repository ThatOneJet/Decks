/**
 * NotificationCenter — a topbar dropdown that aggregates every deck's live
 * signals (unread badges + now-playing) into one place, newest-attention first.
 * Click a row to jump to that deck. "Refresh" reloads all web decks so their
 * page-title badge counts re-sync on demand (closed third-party sites like
 * Instagram only report a count while their page is loaded).
 */
import { useStore } from '../store'
import type { Workspace } from '@shared/types'
import TileIcon from './sidebar/TileIcon'

/** Drop the "(3) " unread prefix + a trailing site suffix from a page title. */
function cleanTitle(raw?: string): string {
  if (!raw) return ''
  return raw
    .replace(/^\(\d+\)\s*/, '')
    .replace(/\s*[-–—|•]\s*(YouTube|YouTube Music|Spotify|SoundCloud|Twitch|Netflix|Apple Music)\s*$/i, '')
    .trim()
}

interface Row {
  ws: Workspace
  unread: number
  playing: boolean
  title: string
}

function rowFor(ws: Workspace): Row {
  const unread = ws.panels.reduce((s, p) => s + (p.badge || 0), 0)
  const playingPanel = ws.panels.find((p) => p.playing)
  return { ws, unread, playing: !!playingPanel, title: cleanTitle(playingPanel?.title) }
}

export default function NotificationCenter({ onClose }: { onClose: () => void }): JSX.Element {
  const workspaces = useStore((s) => s.workspaces)
  const activateWorkspace = useStore((s) => s.activateWorkspace)

  const rows = workspaces
    .map(rowFor)
    .filter((r) => r.unread > 0 || r.playing)
    .sort((a, b) => b.unread - a.unread)
  const totalUnread = rows.reduce((s, r) => s + r.unread, 0)

  const open = (id: string): void => {
    activateWorkspace(id)
    onClose()
  }

  // Reload every live web deck so their page-title badge counts re-sync.
  const refresh = (): void => {
    for (const ws of workspaces) {
      for (const p of ws.panels) {
        if (p.id && p.kind !== 'native' && !p.discarded) window.decks?.panel.reload(p.id)
      }
    }
  }

  return (
    <>
      {/* click-away backdrop */}
      <div className="fixed inset-0 z-[150]" onClick={onClose} />
      <div className="glass absolute right-2 top-11 z-[151] flex max-h-[70vh] w-80 flex-col overflow-hidden rounded-xl border border-line shadow-2xl">
        <div className="flex items-center justify-between border-b border-line px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-txt-1">Notifications</span>
            {totalUnread > 0 && (
              <span className="rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-bold text-white">
                {totalUnread > 99 ? '99+' : totalUnread}
              </span>
            )}
          </div>
          <button
            onClick={refresh}
            className="rounded-md px-2 py-1 text-[11px] font-medium text-txt-3 transition-colors hover:bg-bg-elevated hover:text-txt-1"
            title="Reload all web decks to re-sync their counts"
          >
            Refresh
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {rows.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-txt-4">
              You’re all caught up — no unread or playing decks.
            </p>
          ) : (
            rows.map(({ ws, unread, playing, title }) => {
              const primary = ws.panels[0]
              return (
                <button
                  key={ws.id}
                  onClick={() => open(ws.id)}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-bg-elevated"
                >
                  <span className="grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-lg bg-bg">
                    <TileIcon
                      url={primary?.url}
                      favicon={primary?.favicon}
                      color={ws.color || '#45d6e8'}
                      glyph={ws.glyph}
                      name={ws.name}
                    />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium text-txt-1">{ws.name}</span>
                    <span className="block truncate text-[11px] text-txt-3">
                      {playing ? `♪ ${title || 'Playing'}` : `${unread} unread`}
                    </span>
                  </span>
                  {unread > 0 ? (
                    <span className="shrink-0 rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-bold text-white">
                      {unread > 99 ? '99+' : unread}
                    </span>
                  ) : (
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: 'var(--live)' }} />
                  )}
                </button>
              )
            })
          )}
        </div>
      </div>
    </>
  )
}
