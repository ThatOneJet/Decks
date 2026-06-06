/**
 * DashboardHome — the landing surface (view === 'home'). Replaces the old launcher.
 *
 * It's the "Discover" board promoted to the home page: a cross-service feed of
 * what's new/notable across your connected decks (rendered as horizontal,
 * arrow-scrollable rows), plus a right-hand SIDE WIDGET that stacks your most
 * time-relevant Canvas assignments (Canvas is coursework, not video content, so
 * it gets a focused list rather than a media row).
 *
 * The jump/command bar + Decks brand live in the header (always present), so this
 * page focuses on content. On mount it hides all web views so nothing covers it.
 */
import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import { useStore } from '../store'
import HScroll from './HScroll'

interface BoardItem {
  id?: string
  title?: string
  subtitle?: string
  image?: string
  link?: string
  timestamp?: string
}
interface BoardSection {
  source?: string
  title?: string
  items?: BoardItem[]
}
interface CanvasAssignment {
  id?: string
  courseId?: string
  courseName?: string
  name?: string
  dueAt?: string
  hasSubmitted?: boolean
  submissionState?: string
}

function relative(iso?: string): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const d = t - Date.now()
  const a = Math.abs(d)
  const m = 60_000, h = 60 * m, day = 24 * h
  let s: string
  if (a < h) s = `${Math.max(1, Math.round(a / m))}m`
  else if (a < day) s = `${Math.round(a / h)}h`
  else s = `${Math.round(a / day)}d`
  return d >= 0 ? `in ${s}` : `${s} ago`
}

function isMissing(a: CanvasAssignment): boolean {
  if (!a.dueAt) return false
  const t = Date.parse(a.dueAt)
  if (Number.isNaN(t) || t >= Date.now()) return false
  if (a.hasSubmitted) return false
  return !a.submissionState || a.submissionState === 'unsubmitted'
}

export default function DashboardHome(): JSX.Element {
  const openPalette = useStore((s) => s.openPalette)
  const [sections, setSections] = useState<BoardSection[]>([])
  const [assignments, setAssignments] = useState<CanvasAssignment[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    window.decks?.panel.hideAll()
  }, [])

  useEffect(() => {
    let alive = true
    void (async () => {
      // Cross-service board (Discover) — minus Canvas, which gets the side widget.
      try {
        const r = (await window.decks?.provider.fetch({
          provider: 'discovery',
          accountId: 'default',
          resource: 'board'
        })) as { sections?: BoardSection[] } | undefined
        const secs = (r?.sections ?? []).filter((s) => s.source !== 'canvas' && (s.items?.length ?? 0) > 0)
        if (alive) setSections(secs)
      } catch {
        /* ignore */
      }
      // Canvas assignments for the side widget (first connected Canvas account).
      try {
        const accts = (await window.decks?.provider.accounts('canvas')) ?? []
        if (accts[0]) {
          const a = (await window.decks?.provider.fetch({
            provider: 'canvas',
            accountId: accts[0].id,
            resource: 'assignments'
          })) as CanvasAssignment[] | undefined
          const list = (Array.isArray(a) ? a : [])
            .filter((x) => isMissing(x) || (x.dueAt && Date.parse(x.dueAt) >= Date.now() && !x.hasSubmitted))
            .sort((x, y) => (Date.parse(x.dueAt ?? '') || 0) - (Date.parse(y.dueAt ?? '') || 0))
            .slice(0, 10)
          if (alive) setAssignments(list)
        }
      } catch {
        /* ignore */
      }
      if (alive) setLoading(false)
    })()
    return () => {
      alive = false
    }
  }, [])

  const open = (link?: string): void => {
    if (link) window.open(link, '_blank', 'noopener,noreferrer')
  }

  return (
    <div className="page-area">
      <div className="page-card">
        <div className="flex h-full w-full min-h-0">
          {/* Main column — the cross-service board */}
          <div className="min-w-0 flex-1 overflow-y-auto px-6 py-5">
            <div className="mb-5 flex items-center justify-between gap-3">
              <div>
                <h1 className="font-display text-2xl font-semibold tracking-tight text-txt-1">Dashboard</h1>
                <p className="mt-0.5 text-sm text-txt-3">What's new across your decks.</p>
              </div>
              <button
                onClick={openPalette}
                className="flex items-center gap-2 rounded-xl2 border border-line bg-bg-elevated px-3.5 py-2 text-sm text-txt-3 transition-colors hover:border-accent-ring hover:text-txt-1"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
                Jump to a deck…
                <span className="kbd">⌘K</span>
              </button>
            </div>

            {loading && sections.length === 0 ? (
              <p className="py-10 text-center text-sm text-txt-4">Loading your dashboard…</p>
            ) : sections.length === 0 ? (
              <div className="rounded-xl2 border border-dashed border-line p-8 text-center">
                <p className="text-sm font-medium text-txt-2">Connect services to fill your dashboard</p>
                <p className="mt-1 text-xs text-txt-4">
                  Add Spotify, RSS, Bluesky, Mastodon, GitHub and more from <b>⌘K → add a deck</b> or Settings.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-6">
                {sections.map((sec, i) => (
                  <section key={`${sec.source}-${i}`}>
                    <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-txt-3">{sec.title}</h2>
                    <HScroll>
                      {(sec.items ?? []).map((it, j) => (
                        <button
                          key={it.id ?? j}
                          onClick={() => open(it.link)}
                          className="group flex w-44 shrink-0 flex-col overflow-hidden rounded-xl2 border border-line bg-bg-elevated text-left transition-colors hover:border-accent-ring"
                        >
                          {it.image ? (
                            <div className="aspect-video w-full overflow-hidden bg-bg">
                              <img src={it.image} alt="" className="h-full w-full object-cover" draggable={false} />
                            </div>
                          ) : null}
                          <div className="p-2.5">
                            <div className="line-clamp-2 text-xs font-medium text-txt-1">{it.title}</div>
                            {it.subtitle && <div className="mt-1 line-clamp-1 text-[11px] text-txt-3">{it.subtitle}</div>}
                            {it.timestamp && <div className="mt-1 text-[10px] text-txt-4">{relative(it.timestamp)}</div>}
                          </div>
                        </button>
                      ))}
                    </HScroll>
                  </section>
                ))}
              </div>
            )}
          </div>

          {/* Side widget — time-relevant Canvas assignments, stacked */}
          <aside className="hidden w-72 shrink-0 flex-col border-l border-line bg-bg-rail/40 lg:flex">
            <div className="flex items-center gap-2 border-b border-line px-4 py-3">
              <svg viewBox="0 0 24 24" className="h-4 w-4 text-accent" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 10v6M2 10l10-5 10 5-10 5z" /><path d="M6 12v5c3 3 9 3 12 0v-5" /></svg>
              <span className="text-sm font-semibold text-txt-1">Assignments</span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {assignments.length === 0 ? (
                <p className="px-1 py-6 text-center text-xs text-txt-4">
                  {loading ? 'Loading…' : 'No upcoming assignments. Connect Canvas in Settings.'}
                </p>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {assignments.map((a, i) => {
                    const missing = isMissing(a)
                    return (
                      <div
                        key={a.id ?? i}
                        className="rounded-lg border border-line bg-bg-elevated px-3 py-2"
                        style={missing ? { borderLeft: '3px solid var(--err)', paddingLeft: 'calc(0.75rem - 3px)' } : undefined}
                      >
                        <div className="truncate text-xs font-medium text-txt-1">{a.name ?? 'Assignment'}</div>
                        <div className="mt-1 flex items-center justify-between gap-2 text-[10.5px]">
                          <span className="truncate text-txt-3">{a.courseName ?? ''}</span>
                          <span className={missing ? 'shrink-0 font-semibold text-err' : 'shrink-0 text-txt-4'}>
                            {missing ? `missing · ${relative(a.dueAt)}` : `due ${relative(a.dueAt)}`}
                          </span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </aside>
        </div>
      </div>
    </div>
  )
}
