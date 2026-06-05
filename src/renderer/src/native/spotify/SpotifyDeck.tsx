/**
 * Decks — Spotify native deck (renderer process).
 *
 * Renders OUR React UI over the Spotify provider inside a deck card body. It never
 * holds tokens or talks to Spotify directly — it asks main via
 * `window.decks.provider.status(provider, accountId)` and
 * `window.decks.provider.fetch({ provider, accountId, resource })` and renders the
 * sanitized JSON it gets back. Every call is scoped to the deck's `accountId`, so a
 * provider can hold several connected accounts.
 *
 * Layout: a now-playing card (artwork, track/artist, progress bar, prev/play-
 * pause/next controls) that polls every ~5s while connected, then a Playlists grid
 * and a Recently Played list. Loading, not-connected, and error states. Playback
 * controls hint "Premium required" when the provider reports it.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { NativeDeckProps } from '../types'

/* ── Shapes mirrored from the main-process SpotifyClient ── */

interface NowPlaying {
  isPlaying?: boolean
  track?: string
  artists?: string[]
  album?: string
  artwork?: string
  progressMs?: number
  durationMs?: number
  deviceName?: string
}

interface Playlist {
  id?: string
  name?: string
  image?: string
  tracks?: number
  owner?: string
}

interface RecentItem {
  track?: string
  artists?: string[]
  artwork?: string
  playedAt?: string
}

interface SpotifyDashboard {
  nowPlaying: NowPlaying | null
  playlists: Playlist[]
  recentlyPlayed: RecentItem[]
}

interface ControlResult {
  ok?: boolean
  premiumRequired?: boolean
}

type LoadState = 'loading' | 'disconnected' | 'ready' | 'error'

const NOW_PLAYING_POLL_MS = 5000

/* ── Helpers ── */

/** Format milliseconds as m:ss. */
function fmtTime(ms?: number): string {
  if (!ms || ms < 0) return '0:00'
  const total = Math.floor(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

/* ── UI bits ── */

function Spinner(): JSX.Element {
  return (
    <svg className="h-5 w-5 animate-spin text-txt-3" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path
        className="opacity-90"
        d="M22 12a10 10 0 0 1-10 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  )
}

function CenterMessage({
  title,
  body,
  children
}: {
  title: string
  body?: string
  children?: React.ReactNode
}): JSX.Element {
  return (
    <div className="grid h-full w-full place-items-center bg-bg p-6 text-center">
      <div className="max-w-sm">
        <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-xl2 bg-bg-elevated text-txt-3">
          {children ?? (
            <svg viewBox="0 0 24 24" className="h-6 w-6" fill="currentColor">
              <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm4.59 14.44a.62.62 0 0 1-.86.21c-2.35-1.44-5.3-1.76-8.79-.96a.62.62 0 1 1-.28-1.21c3.81-.87 7.08-.5 9.72 1.11.3.18.39.57.21.85zm1.22-2.72a.78.78 0 0 1-1.07.26c-2.69-1.65-6.79-2.13-9.97-1.17a.78.78 0 1 1-.45-1.49c3.63-1.1 8.15-.56 11.23 1.33.37.23.49.71.26 1.07zm.11-2.84C14.8 8.96 9.3 8.78 6.16 9.73a.93.93 0 1 1-.54-1.79c3.6-1.09 9.68-.88 13.49 1.39a.94.94 0 0 1-.96 1.6z" />
            </svg>
          )}
        </div>
        <div className="text-sm font-medium text-txt-1">{title}</div>
        {body && <p className="mt-1 text-xs leading-relaxed text-txt-3">{body}</p>}
      </div>
    </div>
  )
}

function ControlButton({
  onClick,
  label,
  large,
  children
}: {
  onClick: () => void
  label: string
  large?: boolean
  children: React.ReactNode
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`grid place-items-center rounded-full border border-line bg-bg-elevated text-txt-1 transition-colors hover:border-accent-ring ${
        large ? 'h-11 w-11' : 'h-9 w-9 text-txt-2 hover:text-txt-1'
      }`}
    >
      {children}
    </button>
  )
}

function NowPlayingCard({
  np,
  onControl,
  premiumNote
}: {
  np: NowPlaying | null
  onControl: (action: 'play' | 'pause' | 'next' | 'prev') => void
  premiumNote: boolean
}): JSX.Element {
  const progress =
    np && np.durationMs && np.durationMs > 0
      ? Math.min(100, ((np.progressMs ?? 0) / np.durationMs) * 100)
      : 0
  const playing = np?.isPlaying ?? false

  return (
    <section className="rounded-xl2 border border-line bg-bg-panel p-4">
      <div className="flex items-center gap-3">
        <div className="h-16 w-16 shrink-0 overflow-hidden rounded-lg bg-bg-elevated">
          {np?.artwork ? (
            <img src={np.artwork} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="grid h-full w-full place-items-center text-txt-4">
              <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M9 18V5l12-2v13" strokeLinecap="round" strokeLinejoin="round" />
                <circle cx="6" cy="18" r="3" />
                <circle cx="18" cy="16" r="3" />
              </svg>
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-txt-1">
            {np?.track || 'Nothing playing'}
          </div>
          <div className="mt-0.5 truncate text-xs text-txt-3">
            {np?.artists?.length ? np.artists.join(', ') : np?.album || '—'}
          </div>
          {np?.deviceName && (
            <div className="mt-0.5 truncate text-[11px] text-txt-4">{np.deviceName}</div>
          )}
        </div>
      </div>

      {/* Progress */}
      <div className="mt-3">
        <div className="h-1 w-full overflow-hidden rounded-full bg-bg-elevated">
          <div className="h-full rounded-full bg-accent" style={{ width: `${progress}%` }} />
        </div>
        <div className="mt-1 flex justify-between text-[11px] tabular-nums text-txt-4">
          <span>{fmtTime(np?.progressMs)}</span>
          <span>{fmtTime(np?.durationMs)}</span>
        </div>
      </div>

      {/* Controls */}
      <div className="mt-3 flex items-center justify-center gap-3">
        <ControlButton onClick={() => onControl('prev')} label="Previous">
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
            <path d="M6 5h2v14H6zM20 5v14l-11-7z" />
          </svg>
        </ControlButton>
        <ControlButton onClick={() => onControl(playing ? 'pause' : 'play')} label={playing ? 'Pause' : 'Play'} large>
          {playing ? (
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
              <path d="M7 5h4v14H7zM13 5h4v14h-4z" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
              <path d="M7 5v14l12-7z" />
            </svg>
          )}
        </ControlButton>
        <ControlButton onClick={() => onControl('next')} label="Next">
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
            <path d="M16 5h2v14h-2zM4 5l11 7-11 7z" />
          </svg>
        </ControlButton>
      </div>

      {premiumNote && (
        <p className="mt-2 text-center text-[11px] text-warn">
          Spotify Premium is required to control playback.
        </p>
      )}
    </section>
  )
}

function PlaylistCard({ p }: { p: Playlist }): JSX.Element {
  const inner = (
    <div className="rounded-lg border border-line bg-bg-elevated p-2 transition-colors hover:border-accent-ring">
      <div className="aspect-square w-full overflow-hidden rounded-md bg-bg-panel">
        {p.image ? (
          <img src={p.image} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="grid h-full w-full place-items-center text-txt-4">
            <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M9 18V5l12-2v13" strokeLinecap="round" strokeLinejoin="round" />
              <circle cx="6" cy="18" r="3" />
              <circle cx="18" cy="16" r="3" />
            </svg>
          </div>
        )}
      </div>
      <div className="mt-1.5 truncate text-xs font-medium text-txt-1">{p.name || 'Playlist'}</div>
      <div className="truncate text-[11px] text-txt-4">{p.tracks ?? 0} tracks</div>
    </div>
  )
  return inner
}

function RecentRow({ r }: { r: RecentItem }): JSX.Element {
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-line bg-bg-elevated px-3 py-2 transition-colors hover:border-accent-ring">
      <div className="h-9 w-9 shrink-0 overflow-hidden rounded bg-bg-panel">
        {r.artwork && <img src={r.artwork} alt="" className="h-full w-full object-cover" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-txt-1">{r.track || 'Track'}</div>
        <div className="truncate text-xs text-txt-3">
          {r.artists?.length ? r.artists.join(', ') : '—'}
        </div>
      </div>
    </div>
  )
}

export default function SpotifyDeck({ provider, accountId }: NativeDeckProps): JSX.Element {
  const [state, setState] = useState<LoadState>('loading')
  const [account, setAccount] = useState<string | undefined>(undefined)
  const [data, setData] = useState<SpotifyDashboard | null>(null)
  const [error, setError] = useState<string>('')
  const [premiumNote, setPremiumNote] = useState<boolean>(false)
  const connectedRef = useRef<boolean>(false)

  const fetchResource = useCallback(
    async <T,>(resource: string): Promise<T | undefined> => {
      return (await window.decks?.provider.fetch({ provider, accountId, resource })) as T | undefined
    },
    [provider, accountId]
  )

  const load = useCallback(async (): Promise<void> => {
    setState('loading')
    setError('')
    try {
      const status = await window.decks?.provider.status(provider, accountId)
      if (!status?.connected) {
        connectedRef.current = false
        setState('disconnected')
        return
      }
      connectedRef.current = true
      setAccount(status.account)

      const result = await fetchResource<SpotifyDashboard>('dashboard')
      setData({
        nowPlaying: (result?.nowPlaying as NowPlaying | null) ?? null,
        playlists: Array.isArray(result?.playlists) ? result!.playlists : [],
        recentlyPlayed: Array.isArray(result?.recentlyPlayed) ? result!.recentlyPlayed : []
      })
      setState('ready')
    } catch (err) {
      connectedRef.current = false
      setError(err instanceof Error ? err.message : 'Failed to load Spotify data')
      setState('error')
    }
  }, [provider, accountId, fetchResource])

  useEffect(() => {
    void load()
  }, [load])

  // Poll now-playing every ~5s while connected.
  useEffect(() => {
    let alive = true
    const poll = async (): Promise<void> => {
      if (!connectedRef.current) return
      try {
        const np = await fetchResource<NowPlaying | null>('now-playing')
        if (!alive) return
        setData((prev) => (prev ? { ...prev, nowPlaying: np ?? null } : prev))
      } catch {
        /* transient; keep last known now-playing */
      }
    }
    const id = setInterval(poll, NOW_PLAYING_POLL_MS)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [fetchResource])

  const onControl = useCallback(
    async (action: 'play' | 'pause' | 'next' | 'prev'): Promise<void> => {
      try {
        const res = (await window.decks?.provider.fetch({
          provider,
          accountId,
          resource: `control:${action}`
        })) as ControlResult | undefined
        if (res?.premiumRequired) setPremiumNote(true)
        // Refresh now-playing shortly after a successful control.
        if (res?.ok) {
          const np = await fetchResource<NowPlaying | null>('now-playing')
          setData((prev) => (prev ? { ...prev, nowPlaying: np ?? null } : prev))
        }
      } catch {
        /* ignore transient control errors */
      }
    },
    [provider, accountId, fetchResource]
  )

  if (state === 'loading') {
    return (
      <div className="grid h-full w-full place-items-center bg-bg">
        <Spinner />
      </div>
    )
  }

  if (state === 'disconnected') {
    return (
      <CenterMessage
        title="Connect Spotify in Settings"
        body="Register a Spotify app, then connect it here to see what's playing, your playlists, and recent tracks."
      />
    )
  }

  if (state === 'error') {
    return (
      <CenterMessage title="Couldn't load Spotify" body={error}>
        <svg
          viewBox="0 0 24 24"
          className="h-6 w-6 text-err"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 9v4M12 17h.01" />
          <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
        </svg>
      </CenterMessage>
    )
  }

  const dash = data ?? { nowPlaying: null, playlists: [], recentlyPlayed: [] }

  return (
    <div className="flex h-full w-full flex-col bg-bg">
      {/* Header */}
      <header className="shrink-0 border-b border-line px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-txt-1">Spotify</h2>
            {account && <p className="truncate text-xs text-txt-3">{account}</p>}
          </div>
          <button
            onClick={() => void load()}
            className="grid h-7 w-7 place-items-center rounded-lg border border-line bg-bg-elevated text-txt-3 transition-colors hover:text-txt-1"
            aria-label="Refresh"
            title="Refresh"
          >
            <svg
              viewBox="0 0 24 24"
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6" />
            </svg>
          </button>
        </div>
      </header>

      {/* Scrollable body */}
      <div className="flex-1 overflow-auto px-4 py-4">
        <NowPlayingCard np={dash.nowPlaying} onControl={onControl} premiumNote={premiumNote} />

        {/* Playlists */}
        <section className="mt-5">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-txt-3">Playlists</h3>
          {dash.playlists.length === 0 ? (
            <p className="text-xs text-txt-4">No playlists found.</p>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              {dash.playlists.map((p, i) => (
                <PlaylistCard key={p.id ?? `${p.name ?? 'pl'}-${i}`} p={p} />
              ))}
            </div>
          )}
        </section>

        {/* Recently played */}
        <section className="mt-5">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-txt-3">
            Recently played
          </h3>
          {dash.recentlyPlayed.length === 0 ? (
            <p className="text-xs text-txt-4">Nothing played recently.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {dash.recentlyPlayed.map((r, i) => (
                <RecentRow key={`${r.track ?? 'r'}-${r.playedAt ?? i}-${i}`} r={r} />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
