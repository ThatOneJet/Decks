/**
 * Decks — Canvas native deck (renderer process).
 *
 * Renders OUR React UI over the Canvas LMS provider inside a deck card body. It
 * never holds the Canvas token or talks to Canvas directly — it asks main via
 * `window.decks.provider.status('canvas')` and
 * `window.decks.provider.fetch({ provider: 'canvas', resource: 'dashboard' })`
 * and renders the sanitized JSON it gets back.
 *
 * States: loading spinner → (not connected) tidy empty state → (connected)
 * active courses + an Upcoming / To-do list with due dates (overdue/soon
 * highlighted). Card body is scrollable. Matches the app's dark theme tokens.
 */
import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { NativeDeckProps } from '../types'

/* ── Shapes mirrored from the main-process CanvasClient.fetch('dashboard') ── */

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

/** A unified row for the "Upcoming / To-do" list. */
interface AgendaItem {
  key: string
  title: string
  when?: string
  url?: string
  source: 'todo' | 'upcoming'
}

type LoadState = 'loading' | 'disconnected' | 'ready' | 'error'

/* ── Date helpers ── */

const MS_SOON = 24 * 60 * 60 * 1000 // within 24h = "soon"

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
  const inner = (
    <div className="flex items-start gap-2.5 rounded-lg border border-line bg-bg-elevated px-3 py-2.5 transition-colors hover:border-accent-ring">
      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${URGENCY_DOT[u]}`} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-txt-1">{item.title}</div>
        <div className="mt-0.5 flex items-center gap-2 text-xs">
          {when ? (
            <span className={URGENCY_TEXT[u]}>
              {u === 'overdue' ? `Overdue · ${when}` : when}
            </span>
          ) : (
            <span className="text-txt-4">No due date</span>
          )}
          <span className="text-txt-4">·</span>
          <span className="text-txt-4 capitalize">{item.source}</span>
        </div>
      </div>
    </div>
  )

  if (item.url) {
    return (
      <a href={item.url} target="_blank" rel="noreferrer" className="block">
        {inner}
      </a>
    )
  }
  return inner
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

  // Sort by date ascending; items without a date sink to the bottom.
  items.sort((a, b) => {
    const ta = a.when ? new Date(a.when).getTime() : Number.POSITIVE_INFINITY
    const tb = b.when ? new Date(b.when).getTime() : Number.POSITIVE_INFINITY
    return ta - tb
  })

  return items
}

export default function CanvasDeck({ provider }: NativeDeckProps): JSX.Element {
  const [state, setState] = useState<LoadState>('loading')
  const [account, setAccount] = useState<string | undefined>(undefined)
  const [data, setData] = useState<CanvasDashboard | null>(null)
  const [error, setError] = useState<string>('')

  const load = useCallback(async (): Promise<void> => {
    setState('loading')
    setError('')
    try {
      const status = await window.decks?.provider.status(provider)
      if (!status?.connected) {
        setState('disconnected')
        return
      }
      setAccount(status.account)

      const result = (await window.decks?.provider.fetch({
        provider,
        resource: 'dashboard'
      })) as CanvasDashboard | undefined

      setData({
        courses: Array.isArray(result?.courses) ? result!.courses : [],
        todo: Array.isArray(result?.todo) ? result!.todo : [],
        upcoming: Array.isArray(result?.upcoming) ? result!.upcoming : []
      })
      setState('ready')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load Canvas data')
      setState('error')
    }
  }, [provider])

  useEffect(() => {
    void load()
  }, [load])

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
        body="Add your school's Canvas URL and a personal access token to see your courses and upcoming work here."
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

  const dash = data ?? { courses: [], todo: [], upcoming: [] }
  const agenda = buildAgenda(dash)

  return (
    <div className="flex h-full w-full flex-col bg-bg">
      {/* Header */}
      <header className="shrink-0 border-b border-line px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-txt-1">Canvas</h2>
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
        {/* Active courses */}
        <section className="mb-5">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-txt-3">
            Active courses
          </h3>
          {dash.courses.length === 0 ? (
            <p className="text-xs text-txt-4">No active courses.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {dash.courses.map((c, i) => (
                <span
                  key={c.id ?? `${c.name ?? 'course'}-${i}`}
                  title={c.name}
                  className="max-w-[14rem] truncate rounded-full border border-line bg-bg-elevated px-3 py-1 text-xs text-txt-2"
                >
                  {c.courseCode || c.name || 'Course'}
                </span>
              ))}
            </div>
          )}
        </section>

        {/* Upcoming / To-do */}
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-txt-3">
            Upcoming / To-do
          </h3>
          {agenda.length === 0 ? (
            <p className="text-xs text-txt-4">Nothing due. You're all caught up.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {agenda.map((item) => (
                <AgendaRow key={item.key} item={item} />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
