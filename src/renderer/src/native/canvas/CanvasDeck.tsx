/**
 * Decks — Canvas native deck (renderer process).
 *
 * Renders OUR React UI over the Canvas LMS provider inside a deck card body. It
 * never holds the Canvas token or talks to Canvas directly — it asks main via
 * `window.decks.provider.status(provider, accountId)` and
 * `window.decks.provider.fetch({ provider, accountId, resource })` and renders
 * the sanitized JSON it gets back.
 *
 * Tabbed: Overview / Assignments / Grades / Announcements. Overview is a single
 * chronological AGENDA spanning past + missing + upcoming assignments grouped by
 * day (scroll up for overdue/missing/past, down for upcoming, with a "Today"
 * divider scrolled into view on load). Each tab lazy-fetches its resource on
 * first open and caches the result, with loading / empty / error states.
 *
 * Clicking a course or assignment opens a NATIVE in-deck detail view (no
 * window.open redirect): assignment detail (description, due, points, score) and
 * course detail (header + that course's assignments + announcements). A back
 * button (←) returns to the previous tab. Dates are formatted relatively +
 * absolutely, with overdue (err)/missing and soon (warn) highlighting. The card
 * body is scrollable. Matches the app's dark theme.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { NativeDeckProps } from '../types'

/* ── Shapes mirrored from the main-process CanvasClient.fetch(...) ── */

interface CanvasCourse {
  id?: string
  name?: string
  courseCode?: string
  htmlUrl?: string
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
  courseId?: string
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
  htmlUrl?: string
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
  submissionState?: string
}

interface CanvasAnnouncement {
  id?: string
  title?: string
  courseId?: string
  postedAt?: string
  message?: string
  htmlUrl?: string
}

/** Full assignment detail (from the `assignment` resource). */
interface CanvasAssignmentDetail {
  id?: string
  name?: string
  courseId?: string
  dueAt?: string
  pointsPossible?: number
  htmlUrl?: string
  description?: string
  submissionState?: string
  score?: number
  submittedAt?: string
}

/** Course header + grade (from the `course` resource). */
interface CanvasCourseDetail {
  id?: string
  name?: string
  courseCode?: string
  htmlUrl?: string
  score?: number
  grade?: string
}

type LoadState = 'loading' | 'disconnected' | 'ready' | 'error'
type TabKey = 'overview' | 'assignments' | 'grades' | 'announcements'
type TabState = 'idle' | 'loading' | 'ready' | 'error'

/** Detail navigation state layered over the tabs. */
type View =
  | { type: 'list' }
  | { type: 'course'; courseId: string }
  | { type: 'assignment'; courseId: string; assignmentId: string }

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

/** Local YYYY-MM-DD day key for grouping (avoids UTC off-by-one). */
function dayKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Open an external Canvas link in the user's browser via the main process. */
function openExternal(url?: string): void {
  if (!url) return
  window.open(url, '_blank', 'noopener,noreferrer')
}

/**
 * Convert Canvas description HTML to readable plain text WITHOUT
 * dangerouslySetInnerHTML. Uses the DOM parser to strip tags + decode entities,
 * preserving paragraph/line breaks as newlines.
 */
function htmlToText(html?: string): string {
  if (!html) return ''
  // Insert newlines for block-ish breaks before stripping tags.
  const withBreaks = html
    .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\s*\/?>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '• ')
  const doc = new DOMParser().parseFromString(withBreaks, 'text/html')
  const text = doc.body.textContent ?? ''
  return text
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

/** True when a past-due assignment has not been submitted/graded. */
function isMissing(a: { dueAt?: string; submissionState?: string; hasSubmitted?: boolean }): boolean {
  if (!a.dueAt) return false
  const t = new Date(a.dueAt).getTime()
  if (Number.isNaN(t) || t >= Date.now()) return false
  if (a.submissionState && a.submissionState !== 'unsubmitted') return false
  if (a.hasSubmitted) return false
  return true
}

/* ── Course color system ──
 *
 * ONE stable color per course, derived deterministically from its courseId (or
 * name as a fallback). Ten distinct hues that read well on the dark card. The
 * same color is reused EVERYWHERE a course appears (Overview chips, assignment
 * left-edges, grade dots, announcements, detail headers) so it's instantly clear
 * which item belongs to which class. Applied via inline `style` because Tailwind
 * can't purge-safely generate arbitrary per-course classes.
 */
const COURSE_HUES = [
  '#35e3ff', // cyan (accent)
  '#a78bfa', // violet
  '#4ef0a6', // emerald (ok)
  '#ffc25c', // amber (warn)
  '#ff5bd0', // rose / live
  '#60a5fa', // sky
  '#fb923c', // orange
  '#a3e635', // lime
  '#e879f9', // fuchsia
  '#2dd4bf' // teal
] as const

/** Course color tokens for a course, ready to drop into inline styles. */
interface CourseColor {
  /** Solid hue, e.g. for dots and left-edges. */
  hue: string
  /** Translucent fill for soft tile/chip backgrounds. */
  soft: string
  /** Translucent border. */
  border: string
}

/** Deterministic, stable color for a course keyed by courseId (name fallback). */
function courseColor(key?: string): CourseColor {
  if (!key) {
    return { hue: '#6d7689', soft: 'rgba(109,118,137,0.12)', border: 'rgba(109,118,137,0.30)' }
  }
  let hash = 0
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0
  const hue = COURSE_HUES[Math.abs(hash) % COURSE_HUES.length]
  // hue is a #rrggbb literal → build rgba() variants.
  const r = parseInt(hue.slice(1, 3), 16)
  const g = parseInt(hue.slice(3, 5), 16)
  const b = parseInt(hue.slice(5, 7), 16)
  return {
    hue,
    soft: `rgba(${r},${g},${b},0.13)`,
    border: `rgba(${r},${g},${b},0.40)`
  }
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
    <div className={`py-8 text-center text-xs ${kind === 'error' ? 'text-err' : 'text-txt-4'}`}>
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

/* ── Section heading (with optional count + tone) ── */
function SectionHeading({
  children,
  count,
  tone = 'muted'
}: {
  children: React.ReactNode
  count?: number
  tone?: 'muted' | 'err' | 'warn' | 'accent' | 'ok'
}): JSX.Element {
  const toneClass =
    tone === 'err'
      ? 'text-err'
      : tone === 'warn'
        ? 'text-warn'
        : tone === 'accent'
          ? 'text-accent'
          : tone === 'ok'
            ? 'text-ok'
            : 'text-txt-3'
  return (
    <div className="mb-2 flex items-center gap-2">
      <h3 className={`text-xs font-semibold uppercase tracking-wide ${toneClass}`}>{children}</h3>
      {typeof count === 'number' && (
        <span className="rounded-full bg-bg-elevated px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-txt-3">
          {count}
        </span>
      )}
    </div>
  )
}

/* ── Course tag (shared) ── A small course-colored pill identifying the class. */

function CourseChip({
  label,
  colorKey,
  onClick
}: {
  label?: string
  colorKey?: string
  onClick?: () => void
}): JSX.Element | null {
  if (!label) return null
  const c = courseColor(colorKey ?? label)
  const inner = (
    <>
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: c.hue }} />
      <span className="max-w-[10rem] truncate">{label}</span>
    </>
  )
  const cls =
    'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium'
  if (onClick) {
    return (
      <span
        role="button"
        tabIndex={0}
        onClick={(e) => {
          e.stopPropagation()
          onClick()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            e.stopPropagation()
            onClick()
          }
        }}
        className={`${cls} cursor-pointer transition-[filter] hover:brightness-125`}
        style={{ backgroundColor: c.soft, color: c.hue }}
      >
        {inner}
      </span>
    )
  }
  return (
    <span className={cls} style={{ backgroundColor: c.soft, color: c.hue }}>
      {inner}
    </span>
  )
}

/* ── Tabs ── */

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'assignments', label: 'Assignments' },
  { key: 'grades', label: 'Grades' },
  { key: 'announcements', label: 'Announcements' }
]

/* ── Per-tab caches ── */

interface TabData {
  state: TabState
  error: string
}

const IDLE_TAB: TabData = { state: 'idle', error: '' }

/** A detail fetch wrapper (loading / ready / error + payload). */
interface DetailCache<T> {
  state: TabState
  error: string
  data: T | null
}

export default function CanvasDeck({ provider, accountId }: NativeDeckProps): JSX.Element {
  const [state, setState] = useState<LoadState>('loading')
  const [account, setAccount] = useState<string | undefined>(undefined)
  const [tab, setTab] = useState<TabKey>('overview')
  const [view, setView] = useState<View>({ type: 'list' })

  // Overview (dashboard) data
  const [dash, setDash] = useState<CanvasDashboard | null>(null)
  const [error, setError] = useState<string>('')

  // Lazy tab data + meta
  const [assignments, setAssignments] = useState<CanvasAssignment[]>([])
  const [grades, setGrades] = useState<CanvasGrade[]>([])
  const [announcements, setAnnouncements] = useState<CanvasAnnouncement[]>([])
  const [meta, setMeta] = useState<Record<TabKey, TabData>>({
    overview: IDLE_TAB,
    assignments: IDLE_TAB,
    grades: IDLE_TAB,
    announcements: IDLE_TAB
  })

  // Detail caches keyed by id (lazy-fetched on open, cached).
  const [courseDetails, setCourseDetails] = useState<Record<string, DetailCache<CanvasCourseDetail>>>(
    {}
  )
  const [assignmentDetails, setAssignmentDetails] = useState<
    Record<string, DetailCache<CanvasAssignmentDetail>>
  >({})

  // Tracks which list tabs have a fetch started (loading or done) so we don't
  // double-fetch. A ref (not the async-updated `meta`) is the reliable guard.
  const startedTabs = useRef<Set<string>>(new Set())

  /** Resolve a course label from the dashboard course list, by id. */
  const courseName = useCallback(
    (courseId?: string): string | undefined => {
      if (!courseId || !dash) return undefined
      const c = dash.courses.find((x) => x.id === courseId)
      return c?.courseCode ?? c?.name
    },
    [dash]
  )

  /** Load the Overview (status + dashboard + agenda assignments). Resets caches. */
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
      startedTabs.current.clear()
      setAssignments([])
      setGrades([])
      setAnnouncements([])
      setCourseDetails({})
      setAssignmentDetails({})
      setMeta({
        overview: { state: 'ready', error: '' },
        // The Overview agenda is driven by the `assignments` resource — mark it
        // idle so the effect below loads it for the agenda.
        assignments: IDLE_TAB,
        grades: IDLE_TAB,
        announcements: IDLE_TAB
      })
      setView({ type: 'list' })
      setState('ready')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load Canvas data')
      setState('error')
    }
  }, [provider, accountId])

  useEffect(() => {
    void load()
  }, [load])

  /** Lazy-load a single list tab's resource (skips if already started). */
  const loadTab = useCallback(
    async (key: 'assignments' | 'grades' | 'announcements', force = false): Promise<void> => {
      // Guard with a ref (the `meta` state updates async, so reading it here is
      // unreliable). force re-arms a fetch.
      if (force) startedTabs.current.delete(key)
      if (startedTabs.current.has(key)) return
      startedTabs.current.add(key)
      setMeta((m) => ({ ...m, [key]: { state: 'loading', error: '' } }))

      try {
        const result = await window.decks?.provider.fetch({ provider, accountId, resource: key })
        const arr = Array.isArray(result) ? result : []
        if (key === 'assignments') setAssignments(arr as CanvasAssignment[])
        else if (key === 'grades') setGrades(arr as CanvasGrade[])
        else if (key === 'announcements') setAnnouncements(arr as CanvasAnnouncement[])
        setMeta((m) => ({ ...m, [key]: { state: 'ready', error: '' } }))
      } catch (err) {
        startedTabs.current.delete(key) // allow a retry
        setMeta((m) => ({
          ...m,
          [key]: { state: 'error', error: err instanceof Error ? err.message : 'Failed to load' }
        }))
      }
    },
    [provider, accountId]
  )

  // Lazy-fetch the agenda (assignments) for Overview as soon as ready.
  useEffect(() => {
    if (state !== 'ready') return
    if (meta.assignments.state === 'idle') void loadTab('assignments')
  }, [state, meta.assignments.state, loadTab])

  // Lazy-fetch the active list tab on first open.
  useEffect(() => {
    if (state !== 'ready') return
    if (tab === 'overview' || tab === 'assignments') return
    if (meta[tab].state === 'idle') void loadTab(tab)
  }, [tab, state, meta, loadTab])

  /** Lazy-fetch a course detail (cached by id). */
  const loadCourseDetail = useCallback(
    async (courseId: string): Promise<void> => {
      setCourseDetails((m) => {
        const cur = m[courseId]
        if (cur && (cur.state === 'ready' || cur.state === 'loading')) return m
        return { ...m, [courseId]: { state: 'loading', error: '', data: null } }
      })
      try {
        const result = (await window.decks?.provider.fetch({
          provider,
          accountId,
          resource: 'course',
          params: { courseId }
        })) as CanvasCourseDetail | undefined
        setCourseDetails((m) => ({
          ...m,
          [courseId]: { state: 'ready', error: '', data: result ?? {} }
        }))
      } catch (err) {
        setCourseDetails((m) => ({
          ...m,
          [courseId]: {
            state: 'error',
            error: err instanceof Error ? err.message : 'Failed to load',
            data: null
          }
        }))
      }
    },
    [provider, accountId]
  )

  /** Lazy-fetch an assignment detail (cached by id). */
  const loadAssignmentDetail = useCallback(
    async (courseId: string, assignmentId: string): Promise<void> => {
      const k = `${courseId}/${assignmentId}`
      setAssignmentDetails((m) => {
        const cur = m[k]
        if (cur && (cur.state === 'ready' || cur.state === 'loading')) return m
        return { ...m, [k]: { state: 'loading', error: '', data: null } }
      })
      try {
        const result = (await window.decks?.provider.fetch({
          provider,
          accountId,
          resource: 'assignment',
          params: { courseId, assignmentId }
        })) as CanvasAssignmentDetail | undefined
        setAssignmentDetails((m) => ({
          ...m,
          [k]: { state: 'ready', error: '', data: result ?? {} }
        }))
      } catch (err) {
        setAssignmentDetails((m) => ({
          ...m,
          [k]: {
            state: 'error',
            error: err instanceof Error ? err.message : 'Failed to load',
            data: null
          }
        }))
      }
    },
    [provider, accountId]
  )

  /** Navigate into a course detail (also loads its assignments/announcements). */
  const openCourse = useCallback(
    (courseId?: string): void => {
      if (!courseId) return
      setView({ type: 'course', courseId })
      void loadCourseDetail(courseId)
      if (meta.assignments.state === 'idle') void loadTab('assignments')
      if (meta.announcements.state === 'idle') void loadTab('announcements')
    },
    [loadCourseDetail, loadTab, meta.assignments.state, meta.announcements.state]
  )

  /** Navigate into an assignment detail. */
  const openAssignment = useCallback(
    (courseId?: string, assignmentId?: string): void => {
      if (!courseId || !assignmentId) return
      setView({ type: 'assignment', courseId, assignmentId })
      void loadAssignmentDetail(courseId, assignmentId)
    },
    [loadAssignmentDetail]
  )

  /** Back from a detail view → the previous tab list. */
  const back = useCallback((): void => setView({ type: 'list' }), [])

  /** Refresh: reload current view/tab (overview reloads everything). */
  const refresh = useCallback((): void => {
    if (view.type === 'assignment') {
      void loadAssignmentDetail(view.courseId, view.assignmentId)
      return
    }
    if (view.type === 'course') {
      void loadCourseDetail(view.courseId)
      void loadTab('assignments', true)
      void loadTab('announcements', true)
      return
    }
    if (tab === 'overview') void load()
    else if (tab === 'assignments' || tab === 'grades' || tab === 'announcements')
      void loadTab(tab, true)
  }, [view, tab, load, loadTab, loadCourseDetail, loadAssignmentDetail])

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
        body="Add your school's Canvas URL and a personal access token to see your courses, assignments, grades, and announcements here."
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
  const inDetail = view.type !== 'list'

  return (
    <div className="flex h-full w-full flex-col bg-bg">
      {/* Header */}
      <header className="shrink-0 border-b border-line px-4 pt-3">
        <div className="flex items-center gap-2">
          {inDetail && (
            <button
              onClick={back}
              className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-line bg-bg-elevated text-txt-3 transition-colors hover:text-txt-1"
              aria-label="Back"
              title="Back"
            >
              <svg
                viewBox="0 0 24 24"
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </button>
          )}
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold text-txt-1">Canvas</h2>
            {account && <p className="truncate text-xs text-txt-3">{account}</p>}
          </div>
          <button
            onClick={refresh}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-line bg-bg-elevated text-txt-3 transition-colors hover:text-txt-1"
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

        {/* Tab bar (hidden inside a detail view) */}
        {!inDetail && (
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
        )}
      </header>

      {/* Scrollable body */}
      {view.type === 'course' ? (
        <CourseDetailView
          detail={courseDetails[view.courseId]}
          courseId={view.courseId}
          assignments={assignments}
          assignmentsMeta={meta.assignments}
          announcements={announcements}
          announcementsMeta={meta.announcements}
          courseName={courseName}
          onOpenAssignment={openAssignment}
        />
      ) : view.type === 'assignment' ? (
        <AssignmentDetailView
          detail={assignmentDetails[`${view.courseId}/${view.assignmentId}`]}
          courseId={view.courseId}
          courseName={courseName}
          onOpenCourse={openCourse}
        />
      ) : (
        <div className="flex-1 overflow-auto px-4 py-4">
          {tab === 'overview' && (
            <OverviewTab
              data={data}
              meta={meta.assignments}
              assignments={assignments}
              courseName={courseName}
              onOpenCourse={openCourse}
              onOpenAssignment={openAssignment}
            />
          )}
          {tab === 'assignments' && (
            <AssignmentsTab
              meta={meta.assignments}
              items={assignments}
              courseName={courseName}
              onOpenCourse={openCourse}
              onOpenAssignment={openAssignment}
            />
          )}
          {tab === 'grades' && (
            <GradesTab meta={meta.grades} items={grades} onOpenCourse={openCourse} />
          )}
          {tab === 'announcements' && (
            <AnnouncementsTab
              meta={meta.announcements}
              items={announcements}
              courseName={courseName}
              onOpenCourse={openCourse}
            />
          )}
        </div>
      )}
    </div>
  )
}

/* ── Agenda (Overview) ──
 *
 * ONE chronological list of assignments grouped by DAY, oldest → newest, with a
 * "Today" divider. Scroll up = past/missing/overdue, scroll down = upcoming. The
 * Today divider is scrolled into view on load. Each row carries its course color
 * and is clickable → assignment detail.
 */

interface DayGroup {
  key: string
  date: Date
  items: CanvasAssignment[]
}

/** Group assignments by local day, oldest→newest; undated items go last. */
function groupAgendaByDay(items: CanvasAssignment[]): { dated: DayGroup[]; undated: CanvasAssignment[] } {
  const undated: CanvasAssignment[] = []
  const map = new Map<string, DayGroup>()
  for (const a of items) {
    if (!a.dueAt) {
      undated.push(a)
      continue
    }
    const d = new Date(a.dueAt)
    if (Number.isNaN(d.getTime())) {
      undated.push(a)
      continue
    }
    const key = dayKey(d)
    let g = map.get(key)
    if (!g) {
      g = { key, date: new Date(d.getFullYear(), d.getMonth(), d.getDate()), items: [] }
      map.set(key, g)
    }
    g.items.push(a)
  }
  const dated = [...map.values()].sort((a, b) => a.date.getTime() - b.date.getTime())
  for (const g of dated) {
    g.items.sort((a, b) => new Date(a.dueAt!).getTime() - new Date(b.dueAt!).getTime())
  }
  return { dated, undated }
}

/** An agenda assignment row (course-colored, missing-aware, → assignment detail). */
function AgendaAssignmentRow({
  a,
  label,
  onOpenAssignment
}: {
  a: CanvasAssignment
  label?: string
  onOpenAssignment: (courseId?: string, assignmentId?: string) => void
}): JSX.Element {
  const missing = isMissing(a)
  const u = urgency(a.dueAt)
  const past = a.dueAt ? new Date(a.dueAt).getTime() < Date.now() : false
  const done = past && !missing
  const c = courseColor(a.courseId ?? label)
  const dot = missing ? 'bg-err' : done ? 'bg-txt-4' : URGENCY_DOT[u]
  return (
    <button
      type="button"
      onClick={() => onOpenAssignment(a.courseId, a.id)}
      disabled={!a.courseId || !a.id}
      className={`flex w-full items-start gap-2.5 overflow-hidden rounded-lg border border-line bg-bg-elevated py-2.5 pr-3 text-left transition-colors enabled:hover:border-accent-ring disabled:cursor-default ${
        done ? 'opacity-60' : ''
      }`}
      style={{ borderLeft: `3px solid ${c.hue}`, paddingLeft: 'calc(0.75rem - 3px)' }}
    >
      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dot}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className={`min-w-0 flex-1 truncate text-sm font-medium ${
              done ? 'text-txt-3' : 'text-txt-1'
            }`}
          >
            {a.name ?? 'Untitled assignment'}
          </span>
          {missing && (
            <span className="shrink-0 rounded bg-err/15 px-1.5 py-0.5 text-[10px] font-semibold text-err">
              Missing
            </span>
          )}
          {!missing && a.hasSubmitted && (
            <span className="shrink-0 rounded bg-bg px-1.5 py-0.5 text-[10px] font-medium text-ok">
              {done ? 'Done' : 'Submitted'}
            </span>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <CourseChip label={label} colorKey={a.courseId ?? label} />
          {a.dueAt ? (
            <span className={missing ? 'text-err' : done ? 'text-txt-4' : URGENCY_TEXT[u]}>
              {missing
                ? `Missing · was due ${relative(a.dueAt)}`
                : past
                  ? `${formatWhen(a.dueAt)}`
                  : `Due ${relative(a.dueAt)} · ${formatWhen(a.dueAt)}`}
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
}

/** A clickable, bold course chip carrying the course color (Overview header). */
function CourseTile({
  course,
  onOpenCourse
}: {
  course: CanvasCourse
  onOpenCourse: (courseId?: string) => void
}): JSX.Element {
  const c = courseColor(course.id ?? course.name)
  const label = course.courseCode || course.name || 'Course'
  const sub = course.courseCode && course.name ? course.name : undefined
  return (
    <button
      type="button"
      onClick={() => onOpenCourse(course.id)}
      disabled={!course.id}
      title={course.name ? `${course.name} — view in deck` : 'View course'}
      className="group flex max-w-full items-center gap-2 rounded-xl2 px-3 py-2 text-left transition-all enabled:cursor-pointer enabled:hover:brightness-125 disabled:cursor-default"
      style={{ backgroundColor: c.soft, border: `1px solid ${c.border}` }}
    >
      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: c.hue }} />
      <span className="min-w-0">
        <span className="block truncate text-xs font-semibold" style={{ color: c.hue }}>
          {label}
        </span>
        {sub && <span className="block max-w-[12rem] truncate text-[10px] text-txt-3">{sub}</span>}
      </span>
    </button>
  )
}

function OverviewTab({
  data,
  meta,
  assignments,
  courseName,
  onOpenCourse,
  onOpenAssignment
}: {
  data: CanvasDashboard
  meta: TabData
  assignments: CanvasAssignment[]
  courseName: (id?: string) => string | undefined
  onOpenCourse: (courseId?: string) => void
  onOpenAssignment: (courseId?: string, assignmentId?: string) => void
}): JSX.Element {
  const todayRef = useRef<HTMLDivElement | null>(null)
  const { dated, undated } = groupAgendaByDay(assignments)
  const todayKey = dayKey(new Date())

  // Scroll the Today divider into view once the agenda is ready.
  useEffect(() => {
    if (meta.state !== 'ready') return
    if (todayRef.current) {
      todayRef.current.scrollIntoView({ block: 'center' })
    }
  }, [meta.state, assignments.length])

  // Find where "Today" sits among the dated groups (first group >= today).
  const todayIdx = dated.findIndex((g) => g.key >= todayKey)
  const hasExactToday = dated.some((g) => g.key === todayKey)

  return (
    <>
      <section className="mb-5">
        <SectionHeading count={data.courses.length}>Active courses</SectionHeading>
        {data.courses.length === 0 ? (
          <p className="text-xs text-txt-4">No active courses.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {data.courses.map((c, i) => (
              <CourseTile
                key={c.id ?? `${c.name ?? 'course'}-${i}`}
                course={c}
                onOpenCourse={onOpenCourse}
              />
            ))}
          </div>
        )}
      </section>

      <section>
        <SectionHeading>Agenda</SectionHeading>
        {meta.state === 'loading' || meta.state === 'idle' ? (
          <TabStatus kind="loading" message="Loading agenda…" />
        ) : meta.state === 'error' ? (
          <TabStatus kind="error" message={meta.error} />
        ) : dated.length === 0 && undated.length === 0 ? (
          <p className="text-xs text-txt-4">Nothing on the agenda yet.</p>
        ) : (
          <div className="flex flex-col gap-4">
            {dated.map((g, i) => {
              const isToday = g.key === todayKey
              // Render a Today divider before the first group on/after today
              // when there's no exact-today group.
              const showInsertedToday = !hasExactToday && i === todayIdx && todayIdx !== -1
              return (
                <div key={g.key}>
                  {showInsertedToday && (
                    <div ref={todayRef}>
                      <TodayDivider />
                    </div>
                  )}
                  <div ref={isToday ? todayRef : undefined}>
                    <SectionHeading tone={isToday ? 'accent' : 'muted'}>
                      {isToday ? `Today · ${formatDate(g.date.toISOString())}` : formatDate(g.date.toISOString())}
                    </SectionHeading>
                  </div>
                  <div className="flex flex-col gap-2">
                    {g.items.map((a, j) => (
                      <AgendaAssignmentRow
                        key={a.id ?? `${a.name ?? 'a'}-${j}`}
                        a={a}
                        label={a.courseName ?? courseName(a.courseId)}
                        onOpenAssignment={onOpenAssignment}
                      />
                    ))}
                  </div>
                </div>
              )
            })}
            {/* If today is after every dated group, place the divider at the end. */}
            {!hasExactToday && todayIdx === -1 && dated.length > 0 && (
              <div ref={todayRef}>
                <TodayDivider />
              </div>
            )}
            {undated.length > 0 && (
              <div>
                <SectionHeading tone="muted">No due date</SectionHeading>
                <div className="flex flex-col gap-2">
                  {undated.map((a, j) => (
                    <AgendaAssignmentRow
                      key={a.id ?? `nd-${a.name ?? 'a'}-${j}`}
                      a={a}
                      label={a.courseName ?? courseName(a.courseId)}
                      onOpenAssignment={onOpenAssignment}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </section>
    </>
  )
}

/** A clear "Today" divider line for the agenda. */
function TodayDivider(): JSX.Element {
  return (
    <div className="mb-2 flex items-center gap-2">
      <span className="h-px flex-1 bg-accent/40" />
      <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">
        Today
      </span>
      <span className="h-px flex-1 bg-accent/40" />
    </div>
  )
}

/* ── Assignments tab ── */

/** Due-date buckets for grouping the assignments list, in display order. */
type DueBucket = 'missing' | 'overdue' | 'today' | 'week' | 'later' | 'none'

const DUE_BUCKETS: Array<{ key: DueBucket; label: string; tone: 'err' | 'warn' | 'accent' | 'muted' }> = [
  { key: 'missing', label: 'Missing', tone: 'err' },
  { key: 'overdue', label: 'Past', tone: 'muted' },
  { key: 'today', label: 'Today', tone: 'warn' },
  { key: 'week', label: 'This week', tone: 'accent' },
  { key: 'later', label: 'Later', tone: 'muted' },
  { key: 'none', label: 'No due date', tone: 'muted' }
]

/** Classify an assignment into a display bucket relative to now. */
function dueBucket(a: CanvasAssignment): DueBucket {
  const iso = a.dueAt
  if (!iso) return 'none'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return 'none'
  const now = Date.now()
  if (t < now) return isMissing(a) ? 'missing' : 'overdue'
  const endOfToday = new Date()
  endOfToday.setHours(23, 59, 59, 999)
  if (t <= endOfToday.getTime()) return 'today'
  if (t <= now + 7 * MS_DAY) return 'week'
  return 'later'
}

function AssignmentsTab({
  meta,
  items,
  courseName,
  onOpenAssignment
}: {
  meta: TabData
  items: CanvasAssignment[]
  courseName: (id?: string) => string | undefined
  onOpenCourse: (courseId?: string) => void
  onOpenAssignment: (courseId?: string, assignmentId?: string) => void
}): JSX.Element {
  if (meta.state === 'loading' || meta.state === 'idle')
    return <TabStatus kind="loading" message="Loading assignments…" />
  if (meta.state === 'error') return <TabStatus kind="error" message={meta.error} />
  if (items.length === 0)
    return <TabStatus kind="empty" message="No assignments found." />

  // Group into due buckets (items arrive pre-sorted by due date from main).
  const grouped = new Map<DueBucket, CanvasAssignment[]>()
  for (const a of items) {
    const b = dueBucket(a)
    const arr = grouped.get(b)
    if (arr) arr.push(a)
    else grouped.set(b, [a])
  }

  return (
    <div className="flex flex-col gap-5">
      {DUE_BUCKETS.map(({ key, label, tone }) => {
        const group = grouped.get(key)
        if (!group || group.length === 0) return null
        return (
          <section key={key}>
            <SectionHeading count={group.length} tone={tone}>
              {label}
            </SectionHeading>
            <div className="flex flex-col gap-2">
              {group.map((a, i) => (
                <AgendaAssignmentRow
                  key={a.id ?? `${a.name ?? 'a'}-${i}`}
                  a={a}
                  label={a.courseName ?? courseName(a.courseId)}
                  onOpenAssignment={onOpenAssignment}
                />
              ))}
            </div>
          </section>
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

function GradesTab({
  meta,
  items,
  onOpenCourse
}: {
  meta: TabData
  items: CanvasGrade[]
  onOpenCourse: (courseId?: string) => void
}): JSX.Element {
  if (meta.state === 'loading' || meta.state === 'idle')
    return <TabStatus kind="loading" message="Loading grades…" />
  if (meta.state === 'error') return <TabStatus kind="error" message={meta.error} />
  if (items.length === 0) return <TabStatus kind="empty" message="No graded courses found." />

  return (
    <>
      <SectionHeading count={items.length}>Course grades</SectionHeading>
      <div className="flex flex-col gap-2">
        {items.map((g, i) => {
          const hasScore = typeof g.score === 'number'
          const c = courseColor(g.courseId ?? g.name)
          return (
            <button
              key={g.courseId ?? `${g.name ?? 'g'}-${i}`}
              type="button"
              onClick={() => onOpenCourse(g.courseId)}
              disabled={!g.courseId}
              title={g.courseId ? 'View course in deck' : undefined}
              className="flex w-full items-center gap-3 overflow-hidden rounded-lg border border-line bg-bg-elevated py-2.5 pr-3 text-left transition-colors enabled:cursor-pointer enabled:hover:border-accent-ring disabled:cursor-default"
              style={{ borderLeft: `3px solid ${c.hue}`, paddingLeft: 'calc(0.75rem - 3px)' }}
            >
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: c.hue }} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-txt-1">
                  {g.name ?? g.courseCode ?? 'Course'}
                </div>
                {g.courseCode && g.name && (
                  <div className="truncate text-xs text-txt-4">{g.courseCode}</div>
                )}
              </div>
              <div className="flex shrink-0 items-baseline gap-1.5 text-right">
                <span className={`text-lg font-bold tabular-nums ${scoreColor(g.score)}`}>
                  {hasScore ? `${g.score}%` : '—'}
                </span>
                {g.grade && (
                  <span className={`text-sm font-semibold ${scoreColor(g.score)}`}>{g.grade}</span>
                )}
              </div>
            </button>
          )
        })}
      </div>
    </>
  )
}

/* ── Announcements tab ── */

function AnnouncementRow({
  a,
  label,
  onOpenCourse
}: {
  a: CanvasAnnouncement
  label?: string
  onOpenCourse?: (courseId?: string) => void
}): JSX.Element {
  const c = courseColor(a.courseId ?? label)
  return (
    <button
      type="button"
      onClick={() => onOpenCourse?.(a.courseId)}
      disabled={!a.courseId}
      className="flex w-full flex-col items-start gap-1 overflow-hidden rounded-lg border border-line bg-bg-elevated py-2.5 pr-3 text-left transition-colors enabled:hover:border-accent-ring disabled:cursor-default"
      style={{ borderLeft: `3px solid ${c.hue}`, paddingLeft: 'calc(0.75rem - 3px)' }}
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
}

function AnnouncementsTab({
  meta,
  items,
  courseName,
  onOpenCourse
}: {
  meta: TabData
  items: CanvasAnnouncement[]
  courseName: (id?: string) => string | undefined
  onOpenCourse: (courseId?: string) => void
}): JSX.Element {
  if (meta.state === 'loading' || meta.state === 'idle')
    return <TabStatus kind="loading" message="Loading announcements…" />
  if (meta.state === 'error') return <TabStatus kind="error" message={meta.error} />
  if (items.length === 0) return <TabStatus kind="empty" message="No recent announcements." />

  return (
    <>
      <SectionHeading count={items.length}>Recent announcements</SectionHeading>
      <div className="flex flex-col gap-2">
        {items.map((a, i) => (
          <AnnouncementRow
            key={a.id ?? `${a.title ?? 'an'}-${i}`}
            a={a}
            label={courseName(a.courseId)}
            onOpenCourse={onOpenCourse}
          />
        ))}
      </div>
    </>
  )
}

/* ── Detail: Assignment ── */

function OpenInCanvasLink({ url }: { url?: string }): JSX.Element | null {
  if (!url) return null
  return (
    <button
      type="button"
      onClick={() => openExternal(url)}
      className="inline-flex items-center gap-1 text-[11px] font-medium text-txt-3 underline-offset-2 transition-colors hover:text-accent hover:underline"
    >
      Open in Canvas
      <svg
        viewBox="0 0 24 24"
        className="h-3 w-3"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M7 17 17 7M9 7h8v8" />
      </svg>
    </button>
  )
}

function AssignmentDetailView({
  detail,
  courseId,
  courseName,
  onOpenCourse
}: {
  detail?: DetailCache<CanvasAssignmentDetail>
  courseId: string
  courseName: (id?: string) => string | undefined
  onOpenCourse: (courseId?: string) => void
}): JSX.Element {
  if (!detail || detail.state === 'loading' || detail.state === 'idle') {
    return (
      <div className="flex-1 overflow-auto px-4 py-4">
        <TabStatus kind="loading" message="Loading assignment…" />
      </div>
    )
  }
  if (detail.state === 'error') {
    return (
      <div className="flex-1 overflow-auto px-4 py-4">
        <TabStatus kind="error" message={detail.error} />
      </div>
    )
  }
  const a = detail.data ?? {}
  const label = courseName(courseId)
  const missing = isMissing(a)
  const u = urgency(a.dueAt)
  const past = a.dueAt ? new Date(a.dueAt).getTime() < Date.now() : false
  const description = htmlToText(a.description)
  const scored = typeof a.score === 'number'

  return (
    <div className="flex-1 overflow-auto px-4 py-4">
      <div className="mb-3">
        <CourseChip label={label} colorKey={courseId} onClick={() => onOpenCourse(courseId)} />
      </div>
      <h1 className="text-base font-semibold leading-snug text-txt-1">
        {a.name ?? 'Assignment'}
      </h1>

      {/* Meta row: due + points */}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {a.dueAt ? (
          <span className={missing ? 'text-err' : URGENCY_TEXT[u]}>
            {missing
              ? `Missing · was due ${formatWhen(a.dueAt)}`
              : past
                ? `Due ${formatWhen(a.dueAt)}`
                : `Due ${relative(a.dueAt)} · ${formatWhen(a.dueAt)}`}
          </span>
        ) : (
          <span className="text-txt-4">No due date</span>
        )}
        {typeof a.pointsPossible === 'number' && (
          <span className="text-txt-3">{a.pointsPossible} pts</span>
        )}
      </div>

      {/* Submission status + score */}
      <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-bg-elevated px-3 py-2 text-xs">
        {missing ? (
          <span className="rounded bg-err/15 px-1.5 py-0.5 font-semibold text-err">Missing</span>
        ) : a.submissionState && a.submissionState !== 'unsubmitted' ? (
          <span className="rounded bg-ok/15 px-1.5 py-0.5 font-medium text-ok capitalize">
            {a.submissionState.replace(/_/g, ' ')}
          </span>
        ) : (
          <span className="rounded bg-bg px-1.5 py-0.5 font-medium text-txt-3">Not submitted</span>
        )}
        {a.submittedAt && (
          <span className="text-txt-4" title={formatWhen(a.submittedAt)}>
            Submitted {relative(a.submittedAt)}
          </span>
        )}
        {scored && (
          <span className="ml-auto font-semibold tabular-nums text-txt-1">
            {a.score}
            {typeof a.pointsPossible === 'number' ? ` / ${a.pointsPossible}` : ''} pts
          </span>
        )}
      </div>

      {/* Description (safe plain text — no innerHTML) */}
      <div className="mt-4">
        <SectionHeading>Description</SectionHeading>
        {description ? (
          <p className="whitespace-pre-wrap text-xs leading-relaxed text-txt-2">{description}</p>
        ) : (
          <p className="text-xs text-txt-4">No description.</p>
        )}
      </div>

      <div className="mt-4">
        <OpenInCanvasLink url={a.htmlUrl} />
      </div>
    </div>
  )
}

/* ── Detail: Course ── */

function CourseDetailView({
  detail,
  courseId,
  assignments,
  assignmentsMeta,
  announcements,
  announcementsMeta,
  courseName,
  onOpenAssignment
}: {
  detail?: DetailCache<CanvasCourseDetail>
  courseId: string
  assignments: CanvasAssignment[]
  assignmentsMeta: TabData
  announcements: CanvasAnnouncement[]
  announcementsMeta: TabData
  courseName: (id?: string) => string | undefined
  onOpenAssignment: (courseId?: string, assignmentId?: string) => void
}): JSX.Element {
  const c = courseColor(courseId)
  const d = detail?.data ?? {}
  const headerLoading = !detail || detail.state === 'loading' || detail.state === 'idle'

  const mine = assignments.filter((a) => a.courseId === courseId)
  const missing = mine.filter((a) => isMissing(a))
  const upcoming = mine
    .filter((a) => a.dueAt && new Date(a.dueAt).getTime() >= Date.now())
    .sort((a, b) => new Date(a.dueAt!).getTime() - new Date(b.dueAt!).getTime())
  const pastDone = mine
    .filter((a) => a.dueAt && new Date(a.dueAt).getTime() < Date.now() && !isMissing(a))
    .sort((a, b) => new Date(b.dueAt!).getTime() - new Date(a.dueAt!).getTime())
  const noDate = mine.filter((a) => !a.dueAt)

  const myAnnouncements = announcements.filter((a) => a.courseId === courseId)
  const label = courseName(courseId) ?? d.courseCode ?? d.name

  const section = (
    title: string,
    tone: 'err' | 'accent' | 'muted' | 'ok',
    rows: CanvasAssignment[]
  ): JSX.Element | null => {
    if (rows.length === 0) return null
    return (
      <section key={title} className="mt-4">
        <SectionHeading count={rows.length} tone={tone}>
          {title}
        </SectionHeading>
        <div className="flex flex-col gap-2">
          {rows.map((a, i) => (
            <AgendaAssignmentRow
              key={a.id ?? `${a.name ?? 'a'}-${i}`}
              a={a}
              label={label}
              onOpenAssignment={onOpenAssignment}
            />
          ))}
        </div>
      </section>
    )
  }

  return (
    <div className="flex-1 overflow-auto px-4 py-4">
      {/* Course header */}
      <div
        className="flex items-center gap-3 rounded-xl2 px-3 py-3"
        style={{ backgroundColor: c.soft, border: `1px solid ${c.border}` }}
      >
        <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: c.hue }} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold" style={{ color: c.hue }}>
            {d.name ?? courseName(courseId) ?? 'Course'}
          </div>
          {d.courseCode && (
            <div className="truncate text-[11px] text-txt-3">{d.courseCode}</div>
          )}
        </div>
        {!headerLoading && (typeof d.score === 'number' || d.grade) && (
          <div className="flex shrink-0 items-baseline gap-1.5 text-right">
            {typeof d.score === 'number' && (
              <span className={`text-lg font-bold tabular-nums ${scoreColor(d.score)}`}>
                {d.score}%
              </span>
            )}
            {d.grade && (
              <span className={`text-sm font-semibold ${scoreColor(d.score)}`}>{d.grade}</span>
            )}
          </div>
        )}
        {headerLoading && <Spinner />}
      </div>

      <div className="mt-2">
        <OpenInCanvasLink url={d.htmlUrl} />
      </div>

      {detail?.state === 'error' && (
        <p className="mt-2 text-xs text-err">{detail.error}</p>
      )}

      {/* This course's assignments */}
      {assignmentsMeta.state === 'loading' || assignmentsMeta.state === 'idle' ? (
        <TabStatus kind="loading" message="Loading assignments…" />
      ) : assignmentsMeta.state === 'error' ? (
        <TabStatus kind="error" message={assignmentsMeta.error} />
      ) : mine.length === 0 ? (
        <p className="mt-4 text-xs text-txt-4">No assignments for this course.</p>
      ) : (
        <>
          {section('Missing', 'err', missing)}
          {section('Upcoming', 'accent', upcoming)}
          {section('Past', 'muted', pastDone)}
          {section('No due date', 'muted', noDate)}
        </>
      )}

      {/* This course's announcements */}
      <section className="mt-5">
        <SectionHeading count={myAnnouncements.length || undefined}>Announcements</SectionHeading>
        {announcementsMeta.state === 'loading' || announcementsMeta.state === 'idle' ? (
          <TabStatus kind="loading" message="Loading announcements…" />
        ) : announcementsMeta.state === 'error' ? (
          <TabStatus kind="error" message={announcementsMeta.error} />
        ) : myAnnouncements.length === 0 ? (
          <p className="text-xs text-txt-4">No announcements for this course.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {myAnnouncements.map((a, i) => (
              <AnnouncementRow key={a.id ?? `${a.title ?? 'an'}-${i}`} a={a} label={label} />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
