/**
 * Decks — Canvas native deck (renderer process).
 *
 * Renders OUR React UI over the Canvas LMS provider inside a deck card body. It
 * never holds the Canvas token or talks to Canvas directly — it asks main via
 * `window.decks.provider.status(provider, accountId)` and
 * `window.decks.provider.fetch({ provider, accountId, resource })` and renders
 * the sanitized JSON it gets back.
 *
 * Tabbed: Overview (active courses + upcoming/to-do summary) / Assignments /
 * Grades / Announcements / Calendar. Each tab lazy-fetches its resource on first
 * open and caches the result in state, with loading / empty / error states.
 * Dates are formatted relatively + absolutely, with overdue (err) and soon
 * (warn) highlighting. Card body is scrollable. Matches the app's dark theme.
 */
import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { NativeDeckProps } from '../types'

/* ── Shapes mirrored from the main-process CanvasClient.fetch(...) ── */

interface CanvasCourse {
  id?: string
  name?: string
  courseCode?: string
}

interface CanvasTodo {
  type?: string
  title?: string
  courseId?: string
  dueAt?: string
  htmlUrl?: string
}

interface CanvasUpcoming {
  id?: string
  title?: string
  startAt?: string
  type?: string
  htmlUrl?: string
}

interface CanvasDashboard {
  courses: CanvasCourse[]
  todo: CanvasTodo[]
  upcoming: CanvasUpcoming[]
}

interface CanvasGrade {
  courseId?: string
  name?: string
  courseCode?: string
  score?: number
  grade?: string
}

interface CanvasAssignment {
  id?: string
  courseId?: string
  courseName?: string
  name?: string
  dueAt?: string
  pointsPossible?: number
  htmlUrl?: string
  hasSubmitted?: boolean
}

interface CanvasAnnouncement {
  id?: string
  title?: string
  courseId?: string
  postedAt?: string
  message?: string
  htmlUrl?: string
}

interface CanvasCalendarEvent {
  id?: string
  title?: string
  startAt?: string
  endAt?: string
  type?: string
  courseId?: string
  htmlUrl?: string
}

/** A unified row for the "Upcoming / To-do" list. */
interface AgendaItem {
  key: string
  title: string
  when?: string
  url?: string
  source: 'todo' | 'upcoming'
}

type LoadState = 'loading' | 'disconnected' | 'ready' | 'error'
type TabKey = 'overview' | 'assignments' | 'grades' | 'announcements' | 'calendar'
type TabState = 'idle' | 'loading' | 'ready' | 'error'

/* ── Date helpers ── */

const MS_MIN = 60 * 1000
const MS_HOUR = 60 * MS_MIN
const MS_DAY = 24 * MS_HOUR
const MS_SOON = MS_DAY // within 24h = "soon"

/** Format an ISO date like "Mon, Jun 9 · 11:59 PM"; '' when missing/invalid. */
function formatWhen(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

/** Date only, e.g. "Mon, Jun 9". */
function formatDate(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric'
  })
}

/** Time only, e.g. "11:59 PM". */
function formatTime(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/** Compact relative label, e.g. "in 3h", "2d ago", "now". */
function relative(iso?: string): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return ''
  const delta = t - Date.now()
  const abs = Math.abs(delta)
  const fmt = (n: number, unit: string): string => `${n}${unit}`
  let label: string
  if (abs < MS_MIN) return 'now'
  if (abs < MS_HOUR) label = fmt(Math.round(abs / MS_MIN), 'm')
  else if (abs < MS_DAY) label = fmt(Math.round(abs / MS_HOUR), 'h')
  else label = fmt(Math.round(abs / MS_DAY), 'd')
  return delta >= 0 ? `in ${label}` : `${label} ago`
}

/** Bucket a due date relative to now for color/highlight. */
function urgency(iso?: string): 'overdue' | 'soon' | 'later' | 'none' {
  if (!iso) return 'none'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return 'none'
  const delta = t - Date.now()
  if (delta < 0) return 'overdue'
  if (delta <= MS_SOON) return 'soon'
  return 'later'
}

/** Open an external Canvas link in the user's browser via the main process. */
function openExternal(url?: string): void {
  if (!url) return
  window.open(url, '_blank', 'noopener,noreferrer')
}

/* ── Course color chips ── */

const CHIP_PALETTE = [
  'text-accent',
  'text-live',
  'text-ok',
  'text-warn',
  'text-[#c084fc]',
  'text-[#60a5fa]'
]

/** Deterministic color class for a given course id/name (stable per course). */
function courseColor(key?: string): string {
  if (!key) return 'text-txt-3'
  let hash = 0
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0
  return CHIP_PALETTE[Math.abs(hash) % CHIP_PALETTE.length]
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
            <svg
              viewBox="0 0 24 24"
              className="h-6 w-6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M22 10v6M2 10l10-5 10 5-10 5z" />
              <path d="M6 12v5c3 3 9 3 12 0v-5" />
            </svg>
          )}
        </div>
        <div className="text-sm font-medium text-txt-1">{title}</div>
        {body && <p className="mt-1 text-xs leading-relaxed text-txt-3">{body}</p>}
      </div>
    </div>
  )
}

/** Small inline status block for a tab body (loading / empty / error). */
function TabStatus({
  kind,
  message
}: {
  kind: 'loading' | 'empty' | 'error'
  message: string
}): JSX.Element {
  if (kind === 'loading') {
    return (
      <div className="flex items-center gap-2 py-8 text-xs text-txt-3">
        <Spinner />
        <span>{message}</span>
      </div>
    )
  }
  return (
    <div
      className={`py-8 text-center text-xs ${kind === 'error' ? 'text-err' : 'text-txt-4'}`}
    >
      {message}
    </div>
  )
}

const URGENCY_DOT: Record<ReturnType<typeof urgency>, string> = {
  overdue: 'bg-err',
  soon: 'bg-warn',
  later: 'bg-txt-4',
  none: 'bg-txt-4'
}

const URGENCY_TEXT: Record<ReturnType<typeof urgency>, string> = {
  overdue: 'text-err',
  soon: 'text-warn',
  later: 'text-txt-3',
  none: 'text-txt-3'
}

function AgendaRow({ item }: { item: AgendaItem }): JSX.Element {
  const u = urgency(item.when)
  const when = formatWhen(item.when)
  return (
    <button
      type="button"
      onClick={() => openExternal(item.url)}
      disabled={!item.url}
      className="flex w-full items-start gap-2.5 rounded-lg border border-line bg-bg-elevated px-3 py-2.5 text-left transition-colors enabled:hover:border-accent-ring disabled:cursor-default"
    >
      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${URGENCY_DOT[u]}`} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-txt-1">{item.title}</div>
        <div className="mt-0.5 flex items-center gap-2 text-xs">
          {when ? (
            <span className={URGENCY_TEXT[u]}>{u === 'overdue' ? `Overdue · ${when}` : when}</span>
          ) : (
            <span className="text-txt-4">No due date</span>
          )}
          <span className="text-txt-4">·</span>
          <span className="capitalize text-txt-4">{item.source}</span>
        </div>
      </div>
    </button>
  )
}

/** Flatten todo + upcoming into one chronologically-sorted agenda list. */
function buildAgenda(data: CanvasDashboard): AgendaItem[] {
  const items: AgendaItem[] = []

  data.todo.forEach((t, i) => {
    items.push({
      key: `todo-${t.htmlUrl ?? t.title ?? i}-${i}`,
      title: t.title ?? 'Untitled assignment',
      when: t.dueAt,
      url: t.htmlUrl,
      source: 'todo'
    })
  })

  data.upcoming.forEach((e, i) => {
    items.push({
      key: `up-${e.id ?? e.title ?? i}-${i}`,
      title: e.title ?? 'Untitled event',
      when: e.startAt,
      url: e.htmlUrl,
      source: 'upcoming'
    })
  })

  items.sort((a, b) => {
    const ta = a.when ? new Date(a.when).getTime() : Number.POSITIVE_INFINITY
    const tb = b.when ? new Date(b.when).getTime() : Number.POSITIVE_INFINITY
    return ta - tb
  })

  return items
}

/* ── Section heading ── */
function SectionHeading({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-txt-3">{children}</h3>
  )
}

/* ── Tabs ── */

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'assignments', label: 'Assignments' },
  { key: 'grades', label: 'Grades' },
  { key: 'announcements', label: 'Announcements' },
  { key: 'calendar', label: 'Calendar' }
]

/* ── Per-tab caches ── */

interface TabData {
  state: TabState
  error: string
}

const IDLE_TAB: TabData = { state: 'idle', error: '' }

export default function CanvasDeck({ provider, accountId }: NativeDeckProps): JSX.Element {
  const [state, setState] = useState<LoadState>('loading')
  const [account, setAccount] = useState<string | undefined>(undefined)
  const [tab, setTab] = useState<TabKey>('overview')

  // Overview (dashboard) data
  const [dash, setDash] = useState<CanvasDashboard | null>(null)
  const [error, setError] = useState<string>('')

  // Lazy tab data + meta
  const [assignments, setAssignments] = useState<CanvasAssignment[]>([])
  const [grades, setGrades] = useState<CanvasGrade[]>([])
  const [announcements, setAnnouncements] = useState<CanvasAnnouncement[]>([])
  const [calendar, setCalendar] = useState<CanvasCalendarEvent[]>([])
  const [meta, setMeta] = useState<Record<TabKey, TabData>>({
    overview: IDLE_TAB,
    assignments: IDLE_TAB,
    grades: IDLE_TAB,
    announcements: IDLE_TAB,
    calendar: IDLE_TAB
  })

  /** Resolve a course label from the dashboard course list, by id. */
  const courseName = useCallback(
    (courseId?: string): string | undefined => {
      if (!courseId || !dash) return undefined
      const c = dash.courses.find((x) => x.id === courseId)
      return c?.name ?? c?.courseCode
    },
    [dash]
  )

  /** Load the Overview (status + dashboard). Resets all caches. */
  const load = useCallback(async (): Promise<void> => {
    setState('loading')
    setError('')
    try {
      const status = await window.decks?.provider.status(provider, accountId)
      if (!status?.connected) {
        setState('disconnected')
        return
      }
      setAccount(status.account)

      const result = (await window.decks?.provider.fetch({
        provider,
        accountId,
        resource: 'dashboard'
      })) as CanvasDashboard | undefined

      setDash({
        courses: Array.isArray(result?.courses) ? result!.courses : [],
        todo: Array.isArray(result?.todo) ? result!.todo : [],
        upcoming: Array.isArray(result?.upcoming) ? result!.upcoming : []
      })
      // Reset lazy caches so re-fetch happens on next visit.
      setMeta({
        overview: { state: 'ready', error: '' },
        assignments: IDLE_TAB,
        grades: IDLE_TAB,
        announcements: IDLE_TAB,
        calendar: IDLE_TAB
      })
      setState('ready')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load Canvas data')
      setState('error')
    }
  }, [provider, accountId])

  useEffect(() => {
    void load()
  }, [load])

  /** Lazy-load a single tab's resource (skips if already loaded). */
  const loadTab = useCallback(
    async (key: Exclude<TabKey, 'overview'>, force = false): Promise<void> => {
      setMeta((m) => {
        if (!force && (m[key].state === 'ready' || m[key].state === 'loading')) return m
        return { ...m, [key]: { state: 'loading', error: '' } }
      })

      try {
        const result = await window.decks?.provider.fetch({ provider, accountId, resource: key })
        const arr = Array.isArray(result) ? result : []
        if (key === 'assignments') setAssignments(arr as CanvasAssignment[])
        else if (key === 'grades') setGrades(arr as CanvasGrade[])
        else if (key === 'announcements') setAnnouncements(arr as CanvasAnnouncement[])
        else if (key === 'calendar') setCalendar(arr as CanvasCalendarEvent[])
        setMeta((m) => ({ ...m, [key]: { state: 'ready', error: '' } }))
      } catch (err) {
        setMeta((m) => ({
          ...m,
          [key]: {
            state: 'error',
            error: err instanceof Error ? err.message : 'Failed to load'
          }
        }))
      }
    },
    [provider, accountId]
  )

  // Lazy-fetch the active tab on first open.
  useEffect(() => {
    if (state !== 'ready') return
    if (tab === 'overview') return
    if (meta[tab].state === 'idle') void loadTab(tab)
  }, [tab, state, meta, loadTab])

  /** Refresh: reload current tab (overview reloads everything). */
  const refresh = useCallback((): void => {
    if (tab === 'overview') void load()
    else void loadTab(tab, true)
  }, [tab, load, loadTab])

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
        title="Connect Canvas in Settings"
        body="Add your school's Canvas URL and a personal access token to see your courses, assignments, grades, and calendar here."
      />
    )
  }

  if (state === 'error') {
    return (
      <CenterMessage title="Couldn't load Canvas" body={error}>
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

  const data = dash ?? { courses: [], todo: [], upcoming: [] }

  return (
    <div className="flex h-full w-full flex-col bg-bg">
      {/* Header */}
      <header className="shrink-0 border-b border-line px-4 pt-3">
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-txt-1">Canvas</h2>
            {account && <p className="truncate text-xs text-txt-3">{account}</p>}
          </div>
          <button
            onClick={refresh}
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

        {/* Tab bar */}
        <nav className="-mb-px mt-2 flex gap-1 overflow-x-auto">
          {TABS.map((t) => {
            const active = t.key === tab
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={`shrink-0 border-b-2 px-2.5 pb-2 text-xs font-medium transition-colors ${
                  active
                    ? 'border-accent text-accent'
                    : 'border-transparent text-txt-3 hover:text-txt-1'
                }`}
              >
                {t.label}
              </button>
            )
          })}
        </nav>
      </header>

      {/* Scrollable body */}
      <div className="flex-1 overflow-auto px-4 py-4">
        {tab === 'overview' && (
          <OverviewTab data={data} agenda={buildAgenda(data)} />
        )}
        {tab === 'assignments' && (
          <AssignmentsTab meta={meta.assignments} items={assignments} courseName={courseName} />
        )}
        {tab === 'grades' && <GradesTab meta={meta.grades} items={grades} />}
        {tab === 'announcements' && (
          <AnnouncementsTab
            meta={meta.announcements}
            items={announcements}
            courseName={courseName}
          />
        )}
        {tab === 'calendar' && (
          <CalendarTab meta={meta.calendar} items={calendar} courseName={courseName} />
        )}
      </div>
    </div>
  )
}

/* ── Overview tab ── */

function OverviewTab({
  data,
  agenda
}: {
  data: CanvasDashboard
  agenda: AgendaItem[]
}): JSX.Element {
  return (
    <>
      <section className="mb-5">
        <SectionHeading>Active courses</SectionHeading>
        {data.courses.length === 0 ? (
          <p className="text-xs text-txt-4">No active courses.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {data.courses.map((c, i) => (
              <span
                key={c.id ?? `${c.name ?? 'course'}-${i}`}
                title={c.name}
                className="flex max-w-[14rem] items-center gap-1.5 truncate rounded-full border border-line bg-bg-elevated px-3 py-1 text-xs text-txt-2"
              >
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${courseColor(c.id ?? c.name)} bg-current`} />
                <span className="truncate">{c.courseCode || c.name || 'Course'}</span>
              </span>
            ))}
          </div>
        )}
      </section>

      <section>
        <SectionHeading>Upcoming / To-do</SectionHeading>
        {agenda.length === 0 ? (
          <p className="text-xs text-txt-4">Nothing due. You&apos;re all caught up.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {agenda.map((item) => (
              <AgendaRow key={item.key} item={item} />
            ))}
          </div>
        )}
      </section>
    </>
  )
}

/* ── Course chip (shared by Assignments / Announcements / Calendar) ── */

function CourseChip({ label, colorKey }: { label?: string; colorKey?: string }): JSX.Element | null {
  if (!label) return null
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md bg-bg px-1.5 py-0.5 text-[10px] font-medium ${courseColor(colorKey ?? label)}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      <span className="max-w-[10rem] truncate">{label}</span>
    </span>
  )
}

/* ── Assignments tab ── */

function AssignmentsTab({
  meta,
  items,
  courseName
}: {
  meta: TabData
  items: CanvasAssignment[]
  courseName: (id?: string) => string | undefined
}): JSX.Element {
  if (meta.state === 'loading' || meta.state === 'idle')
    return <TabStatus kind="loading" message="Loading assignments…" />
  if (meta.state === 'error') return <TabStatus kind="error" message={meta.error} />
  if (items.length === 0)
    return <TabStatus kind="empty" message="No upcoming assignments. You're all caught up." />

  return (
    <div className="flex flex-col gap-2">
      {items.map((a, i) => {
        const u = urgency(a.dueAt)
        const label = a.courseName ?? courseName(a.courseId)
        return (
          <button
            key={a.id ?? `${a.name ?? 'a'}-${i}`}
            type="button"
            onClick={() => openExternal(a.htmlUrl)}
            disabled={!a.htmlUrl}
            className="flex w-full items-start gap-2.5 rounded-lg border border-line bg-bg-elevated px-3 py-2.5 text-left transition-colors enabled:hover:border-accent-ring disabled:cursor-default"
          >
            <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${URGENCY_DOT[u]}`} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-txt-1">
                  {a.name ?? 'Untitled assignment'}
                </span>
                {a.hasSubmitted && (
                  <span className="shrink-0 rounded bg-bg px-1.5 py-0.5 text-[10px] font-medium text-ok">
                    Submitted
                  </span>
                )}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                <CourseChip label={label} colorKey={a.courseId ?? label} />
                {a.dueAt ? (
                  <span className={URGENCY_TEXT[u]}>
                    {u === 'overdue' ? 'Overdue · ' : `Due ${relative(a.dueAt)} · `}
                    {formatWhen(a.dueAt)}
                  </span>
                ) : (
                  <span className="text-txt-4">No due date</span>
                )}
                {typeof a.pointsPossible === 'number' && (
                  <span className="text-txt-4">· {a.pointsPossible} pts</span>
                )}
              </div>
            </div>
          </button>
        )
      })}
    </div>
  )
}

/* ── Grades tab ── */

/** Color a percentage score: green ≥90, cyan ≥80, warn ≥70, err below. */
function scoreColor(score?: number): string {
  if (typeof score !== 'number') return 'text-txt-3'
  if (score >= 90) return 'text-ok'
  if (score >= 80) return 'text-accent'
  if (score >= 70) return 'text-warn'
  return 'text-err'
}

function GradesTab({ meta, items }: { meta: TabData; items: CanvasGrade[] }): JSX.Element {
  if (meta.state === 'loading' || meta.state === 'idle')
    return <TabStatus kind="loading" message="Loading grades…" />
  if (meta.state === 'error') return <TabStatus kind="error" message={meta.error} />
  if (items.length === 0) return <TabStatus kind="empty" message="No graded courses found." />

  return (
    <div className="flex flex-col gap-2">
      {items.map((g, i) => {
        const hasScore = typeof g.score === 'number'
        return (
          <div
            key={g.courseId ?? `${g.name ?? 'g'}-${i}`}
            className="flex items-center gap-3 rounded-lg border border-line bg-bg-elevated px-3 py-2.5"
          >
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${courseColor(g.courseId ?? g.name)} bg-current`}
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-txt-1">
                {g.name ?? g.courseCode ?? 'Course'}
              </div>
              {g.courseCode && g.name && (
                <div className="truncate text-xs text-txt-4">{g.courseCode}</div>
              )}
            </div>
            <div className="shrink-0 text-right">
              <div className={`text-sm font-semibold tabular-nums ${scoreColor(g.score)}`}>
                {hasScore ? `${g.score}%` : '—'}
              </div>
              {g.grade && <div className="text-xs text-txt-3">{g.grade}</div>}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/* ── Announcements tab ── */

function AnnouncementsTab({
  meta,
  items,
  courseName
}: {
  meta: TabData
  items: CanvasAnnouncement[]
  courseName: (id?: string) => string | undefined
}): JSX.Element {
  if (meta.state === 'loading' || meta.state === 'idle')
    return <TabStatus kind="loading" message="Loading announcements…" />
  if (meta.state === 'error') return <TabStatus kind="error" message={meta.error} />
  if (items.length === 0) return <TabStatus kind="empty" message="No recent announcements." />

  return (
    <div className="flex flex-col gap-2">
      {items.map((a, i) => {
        const label = courseName(a.courseId)
        return (
          <button
            key={a.id ?? `${a.title ?? 'an'}-${i}`}
            type="button"
            onClick={() => openExternal(a.htmlUrl)}
            disabled={!a.htmlUrl}
            className="flex w-full flex-col items-start gap-1 rounded-lg border border-line bg-bg-elevated px-3 py-2.5 text-left transition-colors enabled:hover:border-accent-ring disabled:cursor-default"
          >
            <div className="flex w-full items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-txt-1">
                {a.title ?? 'Announcement'}
              </span>
              {a.postedAt && (
                <span className="shrink-0 text-xs text-txt-4" title={formatWhen(a.postedAt)}>
                  {relative(a.postedAt)}
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <CourseChip label={label} colorKey={a.courseId ?? label} />
            </div>
            {a.message && (
              <p className="line-clamp-2 text-xs leading-relaxed text-txt-3">{a.message}</p>
            )}
          </button>
        )
      })}
    </div>
  )
}

/* ── Calendar tab ── */

/** Group calendar events by their start date (YYYY-MM-DD key, keeps order). */
function groupByDay(items: CanvasCalendarEvent[]): Array<{ day: string; iso?: string; events: CanvasCalendarEvent[] }> {
  const groups: Array<{ day: string; iso?: string; events: CanvasCalendarEvent[] }> = []
  const index = new Map<string, number>()
  for (const ev of items) {
    const key = ev.startAt ? new Date(ev.startAt).toISOString().slice(0, 10) : 'no-date'
    let gi = index.get(key)
    if (gi === undefined) {
      gi = groups.length
      index.set(key, gi)
      groups.push({ day: key, iso: ev.startAt, events: [] })
    }
    groups[gi].events.push(ev)
  }
  return groups
}

function CalendarTab({
  meta,
  items,
  courseName
}: {
  meta: TabData
  items: CanvasCalendarEvent[]
  courseName: (id?: string) => string | undefined
}): JSX.Element {
  if (meta.state === 'loading' || meta.state === 'idle')
    return <TabStatus kind="loading" message="Loading calendar…" />
  if (meta.state === 'error') return <TabStatus kind="error" message={meta.error} />
  if (items.length === 0)
    return <TabStatus kind="empty" message="Nothing scheduled in the next 30 days." />

  const groups = groupByDay(items)

  return (
    <div className="flex flex-col gap-4">
      {groups.map((group) => (
        <section key={group.day}>
          <SectionHeading>{group.iso ? formatDate(group.iso) : 'No date'}</SectionHeading>
          <div className="flex flex-col gap-2">
            {group.events.map((ev, i) => {
              const label = courseName(ev.courseId)
              const isAssignment = ev.type === 'assignment'
              return (
                <button
                  key={ev.id ?? `${ev.title ?? 'ev'}-${i}`}
                  type="button"
                  onClick={() => openExternal(ev.htmlUrl)}
                  disabled={!ev.htmlUrl}
                  className="flex w-full items-start gap-2.5 rounded-lg border border-line bg-bg-elevated px-3 py-2.5 text-left transition-colors enabled:hover:border-accent-ring disabled:cursor-default"
                >
                  <span
                    className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${isAssignment ? 'bg-warn' : 'bg-accent'}`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-txt-1">
                      {ev.title ?? (isAssignment ? 'Assignment' : 'Event')}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                      <CourseChip label={label} colorKey={ev.courseId ?? label} />
                      {ev.startAt && <span className="text-txt-3">{formatTime(ev.startAt)}</span>}
                      <span className="capitalize text-txt-4">· {ev.type ?? 'event'}</span>
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}
