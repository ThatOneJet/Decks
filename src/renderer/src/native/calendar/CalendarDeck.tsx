/**
 * Decks — Calendar native deck (renderer process).
 *
 * An Apple-Calendar-style calendar over OUR OWN 'calendar' provider. It never
 * holds tokens — it asks main via `window.decks.provider.fetch({ provider,
 * accountId, resource, params })` and renders the sanitized JSON it gets back.
 * All persistence happens through the provider (load / addEvent / updateEvent /
 * deleteEvent / setCalendars). One read-only overlay is layered on top: national
 * holidays ('holidays'). Canvas classwork ('classwork') is NOT a separate overlay —
 * it is folded into the user's "School" calendar: whenever the School calendar is
 * visible we render its events AND Canvas assignment due dates together, in the
 * School calendar's color. Hiding "School" hides both. Canvas items stay read-only.
 *
 * Views: Day / Week / Month / Year (segmented header) with ‹ Today › navigation.
 *  - WEEK (primary): weekday+date column headers (today highlighted), an all-day
 *    row (all-day events + holidays + School classwork), then an hourly time grid
 *    with a live "now" line; timed events render as colored blocks (calendar color).
 *  - DAY: a single-day hourly column. MONTH: a 6×7 grid with event chips. YEAR:
 *    twelve mini-months.
 * Left sidebar: a mini-month for navigation, the toggleable calendar list (persists
 * via setCalendars; "School" also gates Canvas classwork), plus a Holidays overlay
 * toggle.
 * Event CRUD: click an empty slot to create, click an event to edit/delete, via a
 * small inline modal form (title, calendar, start/end, all-day, notes).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { NativeDeckProps } from '../types'
import { useStore } from '../../store'

/* ── Shapes mirrored from the main-process CalendarClient.fetch(...) ── */

interface CalEvent {
  id: string
  calendarId: string
  title: string
  start: string
  end: string
  allDay?: boolean
  notes?: string
  location?: string
}

interface Cal {
  id: string
  name: string
  color: string
  visible: boolean
}

interface LoadResult {
  events: CalEvent[]
  calendars: Cal[]
  country: string
}

interface Holiday {
  date: string
  name: string
}

interface Classwork {
  id: string
  title: string
  due: string
  courseName?: string
  courseId?: string
  /** True once submitted/graded — used to show only OPEN classwork. */
  hasSubmitted?: boolean
}

type ViewMode = 'day' | 'week' | 'month' | 'year'
type LoadState = 'loading' | 'ready' | 'error'

const HOLIDAY_COLOR = '#fb923c'

/** The calendar whose visibility also gates (and colors) Canvas classwork. */
const SCHOOL_CALENDAR_ID = 'school'
/** Fallback color for classwork if the School calendar has no color. */
const SCHOOL_FALLBACK_COLOR = '#4ef0a6'

/* ── Date helpers (all local-time) ── */

const HOURS = Array.from({ length: 24 }, (_, i) => i)
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
]

function startOfDay(d: Date): Date {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

function startOfWeek(d: Date): Date {
  const x = startOfDay(d)
  x.setDate(x.getDate() - x.getDay())
  return x
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d)
  x.setDate(x.getDate() + n)
  return x
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

/** Local YYYY-MM-DD key (avoids UTC off-by-one). */
function dayKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Format a Date for a datetime-local input value (local time, no TZ suffix). */
function toLocalInput(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${y}-${m}-${day}T${hh}:${mm}`
}

/** Format a Date for a date input value (local). */
function toDateInput(d: Date): string {
  return dayKey(d)
}

function parseISO(iso: string): Date {
  return new Date(iso)
}

function hourLabel(h: number): string {
  if (h === 0) return '12 AM'
  if (h === 12) return '12 PM'
  return h < 12 ? `${h} AM` : `${h - 12} PM`
}

function timeLabel(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/** rgba() variants of a #rrggbb hue for soft fills/borders. */
function tint(hue: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hue.trim())
  if (!m) return hue
  const n = parseInt(m[1], 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return `rgba(${r},${g},${b},${alpha})`
}

/* ── Event geometry helpers ── */

/** Minutes from midnight for a Date (clamped 0..1440). */
function minutesOfDay(d: Date): number {
  return Math.max(0, Math.min(1440, d.getHours() * 60 + d.getMinutes()))
}

/** True if a timed event intersects the given day. */
function eventOnDay(e: CalEvent, day: Date): boolean {
  const s = parseISO(e.start)
  const en = parseISO(e.end)
  if (Number.isNaN(s.getTime())) return false
  const dayStart = startOfDay(day)
  const dayEnd = addDays(dayStart, 1)
  const endValid = Number.isNaN(en.getTime()) ? s : en
  return s < dayEnd && endValid > dayStart
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
  body
}: {
  title: string
  body?: string
}): JSX.Element {
  return (
    <div className="grid h-full w-full place-items-center bg-bg p-6 text-center">
      <div className="max-w-sm">
        <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-xl2 bg-bg-elevated text-txt-3">
          <svg
            viewBox="0 0 24 24"
            className="h-6 w-6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3" y="4" width="18" height="18" rx="2" />
            <path d="M16 2v4M8 2v4M3 10h18" />
          </svg>
        </div>
        <div className="text-sm font-medium text-txt-1">{title}</div>
        {body && <p className="mt-1 text-xs leading-relaxed text-txt-3">{body}</p>}
      </div>
    </div>
  )
}

/* ── A normalized item rendered in the all-day row ── */
interface AllDayItem {
  key: string
  title: string
  color: string
  kind: 'event' | 'holiday' | 'classwork'
  event?: CalEvent
  /** For classwork chips: lets the month view open the assignment in Canvas. */
  courseId?: string
  assignmentId?: string
}

/* ── A positioned timed event block ── */
interface PositionedEvent {
  event: CalEvent
  color: string
  topPct: number
  heightPct: number
  laneIndex: number
  laneCount: number
}

/** Lay out a day's timed events into non-overlapping lanes. */
function layoutDay(events: CalEvent[], colorOf: (id: string) => string): PositionedEvent[] {
  const items = events
    .map((e) => {
      const s = parseISO(e.start)
      const en = parseISO(e.end)
      const endValid = Number.isNaN(en.getTime()) || en <= s ? new Date(s.getTime() + 30 * 60000) : en
      return { event: e, start: s, end: endValid }
    })
    .filter((x) => !Number.isNaN(x.start.getTime()))
    .sort((a, b) => a.start.getTime() - b.start.getTime())

  // Greedy lane assignment within overlap clusters.
  const lanes: Array<{ end: number }> = []
  const assigned = items.map((it) => {
    const startMin = minutesOfDay(it.start)
    const endMin = it.end.getDate() !== it.start.getDate() ? 1440 : minutesOfDay(it.end)
    let lane = lanes.findIndex((l) => l.end <= startMin)
    if (lane === -1) {
      lane = lanes.length
      lanes.push({ end: endMin })
    } else {
      lanes[lane].end = endMin
    }
    return { it, startMin, endMin, lane }
  })

  // Compute a lane count per cluster (max simultaneous overlap).
  const laneCount = Math.max(1, lanes.length)
  return assigned.map((a) => ({
    event: a.it.event,
    color: colorOf(a.it.event.calendarId),
    topPct: (a.startMin / 1440) * 100,
    heightPct: Math.max(1.5, ((a.endMin - a.startMin) / 1440) * 100),
    laneIndex: a.lane,
    laneCount
  }))
}


/* ── Event editor modal ── */

interface EditorState {
  event: CalEvent
  isNew: boolean
}

function EventEditor({
  state,
  calendars,
  onSave,
  onDelete,
  onClose
}: {
  state: EditorState
  calendars: Cal[]
  onSave: (e: CalEvent) => void
  onDelete: (id: string) => void
  onClose: () => void
}): JSX.Element {
  const [title, setTitle] = useState(state.event.title)
  const [calendarId, setCalendarId] = useState(
    state.event.calendarId || calendars[0]?.id || 'personal'
  )
  const [allDay, setAllDay] = useState(!!state.event.allDay)
  const [start, setStart] = useState(state.event.start)
  const [end, setEnd] = useState(state.event.end)
  const [notes, setNotes] = useState(state.event.notes ?? '')

  const save = (): void => {
    const s = parseISO(start)
    let en = parseISO(end)
    if (Number.isNaN(s.getTime())) return
    if (Number.isNaN(en.getTime()) || en <= s) en = new Date(s.getTime() + 60 * 60000)
    onSave({
      ...state.event,
      title: title.trim() || 'Untitled',
      calendarId,
      allDay,
      start: s.toISOString(),
      end: en.toISOString(),
      notes: notes.trim() || undefined
    })
  }

  return (
    <div
      className="absolute inset-0 z-30 grid place-items-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-xl2 border border-line bg-bg-elevated p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 text-sm font-semibold text-txt-1">
          {state.isNew ? 'New Event' : 'Edit Event'}
        </div>

        <label className="mb-1 block text-[11px] font-medium text-txt-3">Title</label>
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Event title"
          className="mb-3 w-full rounded-lg border border-line bg-bg px-2.5 py-1.5 text-sm text-txt-1 outline-none focus:border-accent"
        />

        <label className="mb-1 block text-[11px] font-medium text-txt-3">Calendar</label>
        <select
          value={calendarId}
          onChange={(e) => setCalendarId(e.target.value)}
          className="mb-3 w-full rounded-lg border border-line bg-bg px-2.5 py-1.5 text-sm text-txt-1 outline-none focus:border-accent"
        >
          {calendars.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>

        <label className="mb-3 flex items-center gap-2 text-xs text-txt-2">
          <input
            type="checkbox"
            checked={allDay}
            onChange={(e) => setAllDay(e.target.checked)}
            className="accent-accent"
          />
          All-day
        </label>

        <div className="mb-3 grid grid-cols-2 gap-2">
          <div>
            <label className="mb-1 block text-[11px] font-medium text-txt-3">Start</label>
            <input
              type={allDay ? 'date' : 'datetime-local'}
              value={allDay ? toDateInput(parseISO(start)) : toLocalInput(parseISO(start))}
              onChange={(e) => {
                const d = new Date(e.target.value)
                if (!Number.isNaN(d.getTime())) setStart(d.toISOString())
              }}
              className="w-full rounded-lg border border-line bg-bg px-2 py-1.5 text-xs text-txt-1 outline-none focus:border-accent"
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-medium text-txt-3">End</label>
            <input
              type={allDay ? 'date' : 'datetime-local'}
              value={allDay ? toDateInput(parseISO(end)) : toLocalInput(parseISO(end))}
              onChange={(e) => {
                const d = new Date(e.target.value)
                if (!Number.isNaN(d.getTime())) setEnd(d.toISOString())
              }}
              className="w-full rounded-lg border border-line bg-bg px-2 py-1.5 text-xs text-txt-1 outline-none focus:border-accent"
            />
          </div>
        </div>

        <label className="mb-1 block text-[11px] font-medium text-txt-3">Notes</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          placeholder="Optional notes"
          className="mb-4 w-full resize-none rounded-lg border border-line bg-bg px-2.5 py-1.5 text-xs text-txt-1 outline-none focus:border-accent"
        />

        <div className="flex items-center justify-between gap-2">
          {!state.isNew ? (
            <button
              onClick={() => onDelete(state.event.id)}
              className="rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-err transition-colors hover:bg-err/10"
            >
              Delete
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-txt-3 transition-colors hover:text-txt-1"
            >
              Cancel
            </button>
            <button
              onClick={save}
              className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-black transition-[filter] hover:brightness-110"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ── Mini-month (sidebar nav) ── */

function MiniMonth({
  anchor,
  cursor,
  onPick
}: {
  anchor: Date
  cursor: Date
  onPick: (d: Date) => void
}): JSX.Element {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1)
  const gridStart = startOfWeek(first)
  const today = new Date()
  const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i))
  return (
    <div>
      <div className="mb-1.5 text-xs font-semibold text-txt-1">
        {MONTHS[anchor.getMonth()]} {anchor.getFullYear()}
      </div>
      <div className="grid grid-cols-7 gap-0.5 text-center">
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
          <div key={i} className="text-[9px] font-medium text-txt-4">
            {d}
          </div>
        ))}
        {cells.map((d, i) => {
          const inMonth = d.getMonth() === anchor.getMonth()
          const isToday = sameDay(d, today)
          const isCursor = sameDay(d, cursor)
          return (
            <button
              key={i}
              onClick={() => onPick(d)}
              className={`grid h-5 place-items-center rounded text-[10px] tabular-nums transition-colors ${
                isCursor
                  ? 'bg-accent font-semibold text-black'
                  : isToday
                    ? 'font-semibold text-accent'
                    : inMonth
                      ? 'text-txt-2 hover:bg-bg'
                      : 'text-txt-4 hover:bg-bg'
              }`}
            >
              {d.getDate()}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/* ── Now indicator (live) ── */
function useNow(intervalMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}

/* ── Hourly time grid (one or more day columns) ── */

function TimeGrid({
  days,
  positioned,
  classworkByDay,
  schoolColor,
  allDayByDay,
  now,
  onSlotClick,
  onEventClick,
  onOpenAssignment
}: {
  days: Date[]
  positioned: Map<string, PositionedEvent[]>
  classworkByDay: Map<string, Classwork[]>
  schoolColor: string
  allDayByDay: Map<string, AllDayItem[]>
  now: Date
  onSlotClick: (day: Date, hour: number) => void
  onEventClick: (e: CalEvent) => void
  onOpenAssignment: (courseId?: string, assignmentId?: string) => void
}): JSX.Element {
  const today = new Date()
  const nowPct = (minutesOfDay(now) / 1440) * 100
  // ONE shared grid template (a fixed 3rem time-gutter + N equal day columns) is
  // applied to the header, all-day, assignments, AND hour rows so every vertical
  // column line lines up EXACTLY — no flex rounding drift between the rows. The
  // single scroll container means a scrollbar shrinks them all identically too.
  const cols: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: `3rem repeat(${days.length}, minmax(0, 1fr))`
  }
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto">
        {/* Pinned top rows */}
        <div className="sticky top-0 z-20 bg-bg">
          {/* Column headers */}
          <div style={cols} className="border-b border-line">
            <div />
            {days.map((d) => {
              const isToday = sameDay(d, today)
              return (
                <div key={dayKey(d)} className="border-l border-line px-1 py-1.5 text-center">
                  <div className="text-[10px] font-medium uppercase tracking-wide text-txt-4">
                    {WEEKDAYS[d.getDay()]}
                  </div>
                  <div
                    className={`mx-auto mt-0.5 grid h-6 w-6 place-items-center rounded-full text-xs font-semibold tabular-nums ${
                      isToday ? 'bg-accent text-black' : 'text-txt-1'
                    }`}
                  >
                    {d.getDate()}
                  </div>
                </div>
              )
            })}
          </div>

          {/* All-day row (events + holidays) */}
          <div style={cols} className="border-b border-line bg-bg-elevated/40">
            <div className="grid place-items-center text-[9px] text-txt-4">all-day</div>
            {days.map((d) => {
              const items = allDayByDay.get(dayKey(d)) ?? []
              return (
                <div key={dayKey(d)} className="min-h-[1.75rem] space-y-0.5 border-l border-line p-0.5">
                  {items.map((it) => (
                    <button
                      key={it.key}
                      onClick={() => it.event && onEventClick(it.event)}
                      className="block w-full truncate rounded px-1 py-0.5 text-left text-[10px] font-medium"
                      style={{ backgroundColor: tint(it.color, 0.22), color: it.color }}
                      title={it.title}
                    >
                      {it.title}
                    </button>
                  ))}
                </div>
              )
            })}
          </div>

          {/* Assignments row — Canvas classwork gets its OWN top section (like
              all-day), per day, instead of being crammed at its due-time slot. */}
          <div style={cols} className="border-b border-line bg-bg-elevated/20">
            <div className="grid place-items-center text-center text-[9px] leading-tight text-txt-4">
              due
            </div>
            {days.map((d) => {
              const items = classworkByDay.get(dayKey(d)) ?? []
              return (
                <div key={dayKey(d)} className="min-h-[1.75rem] space-y-0.5 border-l border-line p-0.5">
                  {items.map((c) => (
                    <button
                      key={c.id}
                      onClick={() => onOpenAssignment(c.courseId, c.id)}
                      disabled={!c.courseId}
                      className="block w-full truncate rounded px-1 py-0.5 text-left text-[10px] font-medium transition-[filter] hover:brightness-125 disabled:cursor-default"
                      style={{ backgroundColor: tint(schoolColor, 0.18), color: schoolColor }}
                      title={`Due ${timeLabel(parseISO(c.due))} · ${c.title}${c.courseId ? ' · open in Canvas' : ''}`}
                    >
                      📌 {c.title}
                    </button>
                  ))}
                </div>
              )
            })}
          </div>
        </div>

        {/* Scrollable hourly grid — SAME column template as the rows above. */}
        <div style={{ ...cols, minHeight: '60rem' }}>
          {/* Hour gutter — each label is centered exactly on its hour gridline
              (the cell's TOP edge), so the times line up with the column rows. */}
          <div>
            {HOURS.map((h) => (
              <div key={h} className="relative h-10 border-b border-line/40">
                <span className="absolute right-1 top-0 -translate-y-1/2 text-[9px] text-txt-4">
                  {h === 0 ? '' : hourLabel(h)}
                </span>
              </div>
            ))}
          </div>

          {/* Day columns */}
          {days.map((d) => {
            const evs = positioned.get(dayKey(d)) ?? []
            const isToday = sameDay(d, today)
            return (
              <div key={dayKey(d)} className="relative border-l border-line">
                {/* Hour cells (click to create) */}
                {HOURS.map((h) => (
                  <div
                    key={h}
                    onClick={() => onSlotClick(d, h)}
                    className="h-10 cursor-pointer border-b border-line/40 transition-colors hover:bg-bg-elevated/40"
                  />
                ))}

                {/* Now line */}
                {isToday && (
                  <div
                    className="pointer-events-none absolute left-0 right-0 z-10"
                    style={{ top: `${nowPct}%` }}
                  >
                    <div className="relative">
                      <div className="absolute -left-1 -top-1 h-2 w-2 rounded-full bg-live" />
                      <div className="h-px w-full bg-live" />
                    </div>
                  </div>
                )}

                {/* Timed event blocks */}
                {evs.map((p) => {
                  const widthPct = 100 / p.laneCount
                  return (
                    <button
                      key={p.event.id}
                      onClick={(e) => {
                        e.stopPropagation()
                        onEventClick(p.event)
                      }}
                      className="absolute overflow-hidden rounded-md px-1 py-0.5 text-left text-[10px] leading-tight transition-[filter] hover:brightness-110"
                      style={{
                        top: `${p.topPct}%`,
                        height: `${p.heightPct}%`,
                        left: `${p.laneIndex * widthPct}%`,
                        width: `calc(${widthPct}% - 2px)`,
                        backgroundColor: tint(p.color, 0.22),
                        borderLeft: `2px solid ${p.color}`,
                        color: p.color
                      }}
                      title={p.event.title}
                    >
                      <div className="truncate font-semibold">{p.event.title}</div>
                      <div className="truncate opacity-80">{timeLabel(parseISO(p.event.start))}</div>
                    </button>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/* ── Month grid ── */

function MonthGrid({
  cursor,
  chipsByDay,
  onDayClick,
  onEventClick,
  onOpenAssignment
}: {
  cursor: Date
  chipsByDay: Map<string, AllDayItem[]>
  onDayClick: (d: Date) => void
  onEventClick: (e: CalEvent) => void
  onOpenAssignment: (courseId?: string, assignmentId?: string) => void
}): JSX.Element {
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1)
  const gridStart = startOfWeek(first)
  const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i))
  const today = new Date()
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="grid shrink-0 grid-cols-7 border-b border-line">
        {WEEKDAYS.map((w) => (
          <div key={w} className="px-2 py-1 text-center text-[10px] font-medium uppercase tracking-wide text-txt-4">
            {w}
          </div>
        ))}
      </div>
      <div className="grid flex-1 grid-cols-7 grid-rows-6 overflow-auto">
        {cells.map((d, i) => {
          const inMonth = d.getMonth() === cursor.getMonth()
          const isToday = sameDay(d, today)
          const chips = chipsByDay.get(dayKey(d)) ?? []
          return (
            <div
              key={i}
              onClick={() => onDayClick(d)}
              className={`min-h-[4rem] cursor-pointer border-b border-l border-line p-1 transition-colors hover:bg-bg-elevated/40 ${
                inMonth ? '' : 'bg-bg-elevated/20'
              }`}
            >
              <div
                className={`mb-0.5 inline-grid h-5 w-5 place-items-center rounded-full text-[11px] tabular-nums ${
                  isToday
                    ? 'bg-accent font-semibold text-black'
                    : inMonth
                      ? 'text-txt-2'
                      : 'text-txt-4'
                }`}
              >
                {d.getDate()}
              </div>
              <div className="space-y-0.5">
                {chips.slice(0, 3).map((c) => (
                  <button
                    key={c.key}
                    onClick={(e) => {
                      e.stopPropagation()
                      if (c.kind === 'classwork' && c.assignmentId) {
                        onOpenAssignment(c.courseId, c.assignmentId)
                      } else if (c.event) {
                        onEventClick(c.event)
                      }
                    }}
                    className="block w-full truncate rounded px-1 text-left text-[9px] font-medium"
                    style={{ backgroundColor: tint(c.color, 0.2), color: c.color }}
                    title={c.kind === 'classwork' ? `${c.title} — open in Canvas` : c.title}
                  >
                    {c.title}
                  </button>
                ))}
                {chips.length > 3 && (
                  <div className="px-1 text-[9px] text-txt-4">+{chips.length - 3} more</div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* ── Year grid (12 mini-months) ── */

function YearGrid({
  year,
  onPick
}: {
  year: number
  onPick: (d: Date) => void
}): JSX.Element {
  const today = new Date()
  return (
    <div className="grid flex-1 grid-cols-3 gap-3 overflow-auto p-3 md:grid-cols-4">
      {MONTHS.map((_, m) => {
        const first = new Date(year, m, 1)
        const gridStart = startOfWeek(first)
        const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i))
        return (
          <div
            key={m}
            className="rounded-lg border border-line bg-bg-elevated/30 p-2"
          >
            <button
              onClick={() => onPick(new Date(year, m, 1))}
              className="mb-1 block text-xs font-semibold text-accent hover:underline"
            >
              {MONTHS[m]}
            </button>
            <div className="grid grid-cols-7 gap-px text-center">
              {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
                <div key={i} className="text-[8px] text-txt-4">
                  {d}
                </div>
              ))}
              {cells.map((d, i) => {
                const inMonth = d.getMonth() === m
                const isToday = sameDay(d, today)
                return (
                  <button
                    key={i}
                    onClick={() => onPick(d)}
                    className={`grid h-4 place-items-center rounded text-[8px] tabular-nums ${
                      isToday
                        ? 'bg-accent font-semibold text-black'
                        : inMonth
                          ? 'text-txt-2 hover:bg-bg'
                          : 'text-txt-4'
                    }`}
                  >
                    {d.getDate()}
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/* ── Main deck ── */

const VIEW_MODES: Array<{ key: ViewMode; label: string }> = [
  { key: 'day', label: 'Day' },
  { key: 'week', label: 'Week' },
  { key: 'month', label: 'Month' },
  { key: 'year', label: 'Year' }
]

export default function CalendarDeck({ provider, accountId }: NativeDeckProps): JSX.Element {
  const [state, setState] = useState<LoadState>('loading')
  const [error, setError] = useState('')

  const [events, setEvents] = useState<CalEvent[]>([])
  const [calendars, setCalendars] = useState<Cal[]>([])
  const [country, setCountry] = useState('US')

  const [mode, setMode] = useState<ViewMode>('week')
  const [cursor, setCursor] = useState<Date>(() => new Date())
  // Filters (calendars + overlays + mini-month) live in a header popover now — the
  // sidebar was removed so the calendar itself gets the full width.
  const [filtersOpen, setFiltersOpen] = useState(false)
  // A top "Assignments" panel: all uncompleted classwork STACKED (so you don't
  // have to scroll the grid or squint at cluttered day cells to find a due item).
  const [assignmentsOpen, setAssignmentsOpen] = useState(false)

  // Holidays overlay (Canvas classwork is folded into the School calendar below).
  const [showHolidays, setShowHolidays] = useState(true)
  const [holidays, setHolidays] = useState<Holiday[]>([])
  const [classwork, setClasswork] = useState<Classwork[]>([])

  const [editor, setEditor] = useState<EditorState | null>(null)

  const now = useNow()

  // Year currently fetched for holidays (refetch on change).
  const holidayYear = useRef<number | null>(null)
  // Range currently fetched for classwork (refetch on change).
  const classworkRange = useRef<string>('')

  /* ── Load on mount ──
   * Calendar is our OWN local store with NO auth, so (like the RSS deck) we do
   * NOT gate on provider.status().connected. The deck-creation flow only calls
   * connect() for auth providers, so a calendar account may never have been
   * "connected" — but the provider's `load` self-seeds + persists defaults on
   * first read, so fetching 'load' directly always yields a usable store. We
   * only fall into the error state if the IPC call itself throws. */
  const load = useCallback(async (): Promise<void> => {
    setState('loading')
    setError('')
    try {
      const result = (await window.decks?.provider.fetch({
        provider,
        accountId,
        resource: 'load'
      })) as LoadResult | undefined
      setEvents(Array.isArray(result?.events) ? result!.events : [])
      setCalendars(Array.isArray(result?.calendars) ? result!.calendars : [])
      setCountry(typeof result?.country === 'string' && result.country ? result.country : 'US')
      setState('ready')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load calendar')
      setState('error')
    }
  }, [provider, accountId])

  useEffect(() => {
    void load()
  }, [load])

  /* ── Color lookup for a calendarId ── */
  const colorOf = useCallback(
    (calendarId: string): string =>
      calendars.find((c) => c.id === calendarId)?.color ?? '#6d7689',
    [calendars]
  )

  const visibleCalIds = useMemo(
    () => new Set(calendars.filter((c) => c.visible).map((c) => c.id)),
    [calendars]
  )

  /* ── School calendar drives Canvas classwork (visibility + color) ── */
  const schoolVisible = useMemo(
    () => calendars.some((c) => c.id === SCHOOL_CALENDAR_ID && c.visible),
    [calendars]
  )
  const schoolColor = useMemo(
    () =>
      calendars.find((c) => c.id === SCHOOL_CALENDAR_ID)?.color ?? SCHOOL_FALLBACK_COLOR,
    [calendars]
  )

  const visibleEvents = useMemo(
    () => events.filter((e) => visibleCalIds.has(e.calendarId)),
    [events, visibleCalIds]
  )

  /* ── The day range the current view covers ── */
  const viewDays = useMemo<Date[]>(() => {
    if (mode === 'day') return [startOfDay(cursor)]
    if (mode === 'week') {
      const ws = startOfWeek(cursor)
      return Array.from({ length: 7 }, (_, i) => addDays(ws, i))
    }
    return [] // month/year handled separately
  }, [mode, cursor])

  /* ── Holidays: refetch per visible year ── */
  useEffect(() => {
    if (state !== 'ready' || !showHolidays) return
    const year = cursor.getFullYear()
    if (holidayYear.current === year) return
    holidayYear.current = year
    let cancelled = false
    void (async () => {
      try {
        const res = (await window.decks?.provider.fetch({
          provider,
          accountId,
          resource: 'holidays',
          params: { year, country }
        })) as Holiday[] | undefined
        if (!cancelled) setHolidays(Array.isArray(res) ? res : [])
      } catch {
        if (!cancelled) setHolidays([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [state, showHolidays, cursor, country, provider, accountId])

  /* ── Classwork: refetch while the School calendar is visible + range changes.
   * Canvas due dates are part of "School" now, so this is gated on schoolVisible
   * (not a separate overlay toggle). ── */
  useEffect(() => {
    if (state !== 'ready' || !schoolVisible) return
    // Compute a generous range around the cursor for the current view.
    let rangeStart: Date
    let rangeEnd: Date
    if (mode === 'month' || mode === 'year') {
      rangeStart = new Date(cursor.getFullYear(), mode === 'year' ? 0 : cursor.getMonth() - 1, 1)
      rangeEnd = new Date(cursor.getFullYear(), mode === 'year' ? 12 : cursor.getMonth() + 2, 0, 23, 59)
    } else {
      rangeStart = addDays(startOfWeek(cursor), -7)
      rangeEnd = addDays(startOfWeek(cursor), 21)
    }
    const rangeKey = `${dayKey(rangeStart)}_${dayKey(rangeEnd)}`
    if (classworkRange.current === rangeKey) return
    classworkRange.current = rangeKey
    let cancelled = false
    void (async () => {
      try {
        const res = (await window.decks?.provider.fetch({
          provider,
          accountId,
          resource: 'classwork',
          params: { start: rangeStart.toISOString(), end: rangeEnd.toISOString() }
        })) as Classwork[] | undefined
        if (!cancelled) setClasswork(Array.isArray(res) ? res : [])
      } catch {
        if (!cancelled) setClasswork([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [state, schoolVisible, mode, cursor, provider, accountId])

  // Clear classwork when the School calendar is hidden (and reset its range guard).
  useEffect(() => {
    if (!schoolVisible) {
      setClasswork([])
      classworkRange.current = ''
    }
  }, [schoolVisible])
  useEffect(() => {
    if (!showHolidays) {
      setHolidays([])
      holidayYear.current = null
    }
  }, [showHolidays])

  /* ── Build per-day all-day items + holiday/classwork overlays ── */
  const holidaysByDay = useMemo(() => {
    const m = new Map<string, Holiday[]>()
    if (!showHolidays) return m
    for (const h of holidays) {
      const arr = m.get(h.date) ?? []
      arr.push(h)
      m.set(h.date, arr)
    }
    return m
  }, [holidays, showHolidays])

  const classworkByDay = useMemo(() => {
    const m = new Map<string, Classwork[]>()
    if (!schoolVisible) return m
    for (const c of classwork) {
      if (c.hasSubmitted) continue // show only OPEN (uncompleted) classwork
      const d = parseISO(c.due)
      if (Number.isNaN(d.getTime())) continue
      const k = dayKey(d)
      const arr = m.get(k) ?? []
      arr.push(c)
      m.set(k, arr)
    }
    return m
  }, [classwork, schoolVisible])

  /* All uncompleted classwork in range, stacked + sorted by due date — powers the
     top "Assignments" panel so you can see everything at a glance. */
  const upcomingAssignments = useMemo(() => {
    if (!schoolVisible) return [] as Classwork[]
    return classwork
      .filter((c) => !c.hasSubmitted && !Number.isNaN(parseISO(c.due).getTime()))
      .sort((a, b) => parseISO(a.due).getTime() - parseISO(b.due).getTime())
  }, [classwork, schoolVisible])

  /**
   * All-day-row items for one day (all-day events + holidays + classwork).
   * `includeClasswork` is true for the month/year chip views; the hourly
   * (day/week) grid passes false because there Canvas classwork is placed at
   * its exact due time on the time grid instead of in the all-day row.
   */
  const allDayItemsFor = useCallback(
    (day: Date, includeClasswork = true): AllDayItem[] => {
      const k = dayKey(day)
      const items: AllDayItem[] = []
      for (const e of visibleEvents) {
        if (e.allDay && eventOnDay(e, day)) {
          items.push({
            key: `e_${e.id}`,
            title: e.title,
            color: colorOf(e.calendarId),
            kind: 'event',
            event: e
          })
        }
      }
      for (const h of holidaysByDay.get(k) ?? []) {
        items.push({ key: `h_${k}_${h.name}`, title: h.name, color: HOLIDAY_COLOR, kind: 'holiday' })
      }
      // Canvas classwork: visually part of the School calendar (its color), but
      // tagged kind:'classwork' and given no `event` so it stays read-only.
      if (includeClasswork) {
        for (const c of classworkByDay.get(k) ?? []) {
          items.push({
            key: `c_${c.id}`,
            title: c.courseName ? `${c.title} · ${c.courseName}` : c.title,
            color: schoolColor,
            kind: 'classwork',
            courseId: c.courseId,
            assignmentId: c.id
          })
        }
      }
      return items
    },
    [visibleEvents, colorOf, holidaysByDay, classworkByDay, schoolColor]
  )

  /** Month/year chips include timed events too (collapsed to a single chip). */
  const monthChipsFor = useCallback(
    (day: Date): AllDayItem[] => {
      const base = allDayItemsFor(day)
      for (const e of visibleEvents) {
        if (!e.allDay && eventOnDay(e, day)) {
          base.push({
            key: `t_${e.id}`,
            title: `${timeLabel(parseISO(e.start))} ${e.title}`,
            color: colorOf(e.calendarId),
            kind: 'event',
            event: e
          })
        }
      }
      // Classwork chips first so a Canvas assignment is always among the visible
      // (slice(0,3)) chips and stays clickable — never buried in "+N more".
      base.sort((a, b) => (a.kind === 'classwork' ? -1 : 0) - (b.kind === 'classwork' ? -1 : 0))
      return base
    },
    [allDayItemsFor, visibleEvents, colorOf]
  )

  /* ── Positioned timed events per day (day/week views) ── */
  const positionedByDay = useMemo(() => {
    const m = new Map<string, PositionedEvent[]>()
    for (const d of viewDays) {
      const dayEvents = visibleEvents.filter((e) => !e.allDay && eventOnDay(e, d))
      m.set(dayKey(d), layoutDay(dayEvents, colorOf))
    }
    return m
  }, [viewDays, visibleEvents, colorOf])

  const allDayByDay = useMemo(() => {
    const m = new Map<string, AllDayItem[]>()
    // Hourly (day/week) all-day row excludes classwork — it's placed on the grid.
    for (const d of viewDays) m.set(dayKey(d), allDayItemsFor(d, false))
    return m
  }, [viewDays, allDayItemsFor])


  const monthChipsByDay = useMemo(() => {
    const m = new Map<string, AllDayItem[]>()
    if (mode !== 'month') return m
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1)
    const gridStart = startOfWeek(first)
    for (let i = 0; i < 42; i++) {
      const d = addDays(gridStart, i)
      m.set(dayKey(d), monthChipsFor(d))
    }
    return m
  }, [mode, cursor, monthChipsFor])

  /* ── Persistence helpers (through the provider only) ── */
  const persistCalendars = useCallback(
    async (next: Cal[]): Promise<void> => {
      setCalendars(next)
      try {
        await window.decks?.provider.fetch({
          provider,
          accountId,
          resource: 'setCalendars',
          params: { calendars: next }
        })
      } catch {
        /* optimistic — already reflected in UI */
      }
    },
    [provider, accountId]
  )

  const toggleCalendar = useCallback(
    (id: string): void => {
      void persistCalendars(
        calendars.map((c) => (c.id === id ? { ...c, visible: !c.visible } : c))
      )
    },
    [calendars, persistCalendars]
  )

  const saveEvent = useCallback(
    async (e: CalEvent): Promise<void> => {
      const isNew = !events.some((x) => x.id === e.id)
      // Optimistic update.
      setEvents((prev) => (isNew ? [...prev, e] : prev.map((x) => (x.id === e.id ? e : x))))
      setEditor(null)
      try {
        const res = (await window.decks?.provider.fetch({
          provider,
          accountId,
          resource: isNew ? 'addEvent' : 'updateEvent',
          params: { event: e }
        })) as { events?: CalEvent[] } | undefined
        if (Array.isArray(res?.events)) setEvents(res!.events)
      } catch {
        /* keep optimistic copy */
      }
    },
    [events, provider, accountId]
  )

  const deleteEvent = useCallback(
    async (id: string): Promise<void> => {
      setEvents((prev) => prev.filter((x) => x.id !== id))
      setEditor(null)
      try {
        const res = (await window.decks?.provider.fetch({
          provider,
          accountId,
          resource: 'deleteEvent',
          params: { id }
        })) as { events?: CalEvent[] } | undefined
        if (Array.isArray(res?.events)) setEvents(res!.events)
      } catch {
        /* keep optimistic copy */
      }
    },
    [provider, accountId]
  )

  /* ── Slot / event interaction ── */
  const openNewAt = useCallback(
    (day: Date, hour: number): void => {
      const start = new Date(day)
      start.setHours(hour, 0, 0, 0)
      const end = new Date(start.getTime() + 60 * 60000)
      setEditor({
        isNew: true,
        event: {
          id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          calendarId: calendars.find((c) => c.visible)?.id ?? calendars[0]?.id ?? 'personal',
          title: '',
          start: start.toISOString(),
          end: end.toISOString()
        }
      })
    },
    [calendars]
  )

  const openNewAllDay = useCallback(
    (day: Date): void => {
      const start = startOfDay(day)
      const end = addDays(start, 1)
      setEditor({
        isNew: true,
        event: {
          id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          calendarId: calendars.find((c) => c.visible)?.id ?? calendars[0]?.id ?? 'personal',
          title: '',
          allDay: true,
          start: start.toISOString(),
          end: end.toISOString()
        }
      })
    },
    [calendars]
  )

  const openEvent = useCallback((e: CalEvent): void => {
    setEditor({ isNew: false, event: e })
  }, [])

  /* Switch to the Canvas deck + open a specific assignment (cross-deck via the
     store; CanvasDeck consumes the request). */
  const openAssignmentInCanvas = useCallback((courseId?: string, assignmentId?: string): void => {
    if (!courseId || !assignmentId) return
    const st = useStore.getState()
    const canvasWs = st.workspaces.find((w) => w.panels.some((p) => p.provider === 'canvas'))
    if (!canvasWs) return
    st.requestCanvasAssignment(courseId, assignmentId)
    st.activateWorkspace(canvasWs.id)
  }, [])

  /* ── Navigation ── */
  const navigate = useCallback(
    (dir: -1 | 1): void => {
      setCursor((c) => {
        if (mode === 'day') return addDays(c, dir)
        if (mode === 'week') return addDays(c, dir * 7)
        if (mode === 'month') return new Date(c.getFullYear(), c.getMonth() + dir, 1)
        return new Date(c.getFullYear() + dir, c.getMonth(), 1)
      })
    },
    [mode]
  )

  const goToday = useCallback(() => setCursor(new Date()), [])

  const periodLabel = useMemo(() => {
    if (mode === 'day') {
      return cursor.toLocaleDateString(undefined, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric'
      })
    }
    if (mode === 'week') {
      const ws = startOfWeek(cursor)
      const we = addDays(ws, 6)
      const sameMonth = ws.getMonth() === we.getMonth()
      const left = ws.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      const right = we.toLocaleDateString(undefined, {
        month: sameMonth ? undefined : 'short',
        day: 'numeric',
        year: 'numeric'
      })
      return `${left} – ${right}`
    }
    if (mode === 'month') return `${MONTHS[cursor.getMonth()]} ${cursor.getFullYear()}`
    return `${cursor.getFullYear()}`
  }, [mode, cursor])

  /* ── Render states ── */
  if (state === 'loading') {
    return (
      <div className="grid h-full w-full place-items-center bg-bg">
        <Spinner />
      </div>
    )
  }
  if (state === 'error') {
    return <CenterMessage title="Couldn't load calendar" body={error} />
  }

  return (
    <div className="relative flex h-full w-full flex-col bg-bg text-txt-1">
      {/* Header (full width — sidebar removed; filters live in the popover) */}
      <header className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
          <button
            onClick={goToday}
            className="rounded-lg border border-line bg-bg-elevated px-2.5 py-1 text-xs font-medium text-txt-2 transition-colors hover:text-txt-1"
          >
            Today
          </button>
          <div className="flex items-center">
            <button
              onClick={() => navigate(-1)}
              className="grid h-7 w-7 place-items-center rounded-lg text-txt-3 transition-colors hover:bg-bg-elevated hover:text-txt-1"
              aria-label="Previous"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </button>
            <button
              onClick={() => navigate(1)}
              className="grid h-7 w-7 place-items-center rounded-lg text-txt-3 transition-colors hover:bg-bg-elevated hover:text-txt-1"
              aria-label="Next"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 18l6-6-6-6" />
              </svg>
            </button>
          </div>
          <div className="min-w-0 flex-1 truncate text-sm font-semibold text-txt-1">
            {periodLabel}
          </div>

          {/* Assignments popover — all uncompleted classwork stacked at the top */}
          <div className="relative shrink-0">
            <button
              onClick={() => setAssignmentsOpen((o) => !o)}
              className={`flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-xs font-medium transition-colors ${
                assignmentsOpen ? 'bg-accent text-black' : 'bg-bg-elevated text-txt-2 hover:text-txt-1'
              }`}
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 11l3 3L22 4" />
                <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
              </svg>
              Assignments
              {upcomingAssignments.length > 0 && (
                <span className={`rounded-full px-1.5 text-[10px] font-bold tabular-nums ${assignmentsOpen ? 'bg-black/20' : 'bg-accent text-black'}`}>
                  {upcomingAssignments.length}
                </span>
              )}
            </button>
            {assignmentsOpen && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setAssignmentsOpen(false)} />
                <div className="absolute right-0 top-full z-30 mt-1.5 max-h-[70vh] w-80 overflow-y-auto rounded-xl border border-line bg-bg-elevated p-2 shadow-2xl">
                  <div className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-txt-4">
                    Uncompleted assignments ({upcomingAssignments.length})
                  </div>
                  {upcomingAssignments.length === 0 ? (
                    <div className="px-2 py-6 text-center text-xs text-txt-4">Nothing due — all caught up 🎉</div>
                  ) : (
                    <div className="space-y-1">
                      {upcomingAssignments.map((a) => {
                        const d = parseISO(a.due)
                        return (
                          <button
                            key={a.id}
                            onClick={() => {
                              setAssignmentsOpen(false)
                              openAssignmentInCanvas(a.courseId, a.id)
                            }}
                            disabled={!a.courseId}
                            className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-bg disabled:cursor-default"
                            title={a.courseId ? 'Open in Canvas' : undefined}
                          >
                            <span className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: schoolColor }} />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-xs font-semibold text-txt-1">{a.title}</span>
                              <span className="block truncate text-[11px] text-txt-3">
                                {a.courseName ? `${a.courseName} · ` : ''}
                                {d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} · {timeLabel(d)}
                              </span>
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          {/* Filters popover (calendars + overlays + quick mini-month nav) */}
          <div className="relative shrink-0">
            <button
              onClick={() => setFiltersOpen((o) => !o)}
              className={`flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-xs font-medium transition-colors ${
                filtersOpen ? 'bg-accent text-black' : 'bg-bg-elevated text-txt-2 hover:text-txt-1'
              }`}
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 5h18M6 12h12M10 19h4" />
              </svg>
              Filters
            </button>
            {filtersOpen && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setFiltersOpen(false)} />
                <div className="absolute right-0 top-full z-30 mt-1.5 w-60 space-y-3 rounded-xl border border-line bg-bg-elevated p-3 shadow-2xl">
                  <MiniMonth
                    anchor={cursor}
                    cursor={cursor}
                    onPick={(d) => {
                      setCursor(d)
                      setFiltersOpen(false)
                    }}
                  />
                  <div>
                    <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-txt-4">
                      Calendars
                    </div>
                    <div className="space-y-1">
                      {calendars.map((c) => (
                        <label key={c.id} className="flex cursor-pointer items-center gap-2 text-xs text-txt-2">
                          <input type="checkbox" checked={c.visible} onChange={() => toggleCalendar(c.id)} className="sr-only" />
                          <span
                            className="grid h-3.5 w-3.5 place-items-center rounded-[4px] border"
                            style={{ backgroundColor: c.visible ? c.color : 'transparent', borderColor: c.color }}
                          >
                            {c.visible && (
                              <svg viewBox="0 0 24 24" className="h-2.5 w-2.5 text-black" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M20 6 9 17l-5-5" />
                              </svg>
                            )}
                          </span>
                          <span className="truncate">{c.name}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-txt-4">
                      Overlays
                    </div>
                    <label className="flex cursor-pointer items-center gap-2 text-xs text-txt-2">
                      <input type="checkbox" checked={showHolidays} onChange={(e) => setShowHolidays(e.target.checked)} className="sr-only" />
                      <span
                        className="grid h-3.5 w-3.5 place-items-center rounded-[4px] border"
                        style={{ backgroundColor: showHolidays ? HOLIDAY_COLOR : 'transparent', borderColor: HOLIDAY_COLOR }}
                      >
                        {showHolidays && (
                          <svg viewBox="0 0 24 24" className="h-2.5 w-2.5 text-black" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M20 6 9 17l-5-5" />
                          </svg>
                        )}
                      </span>
                      <span>Holidays</span>
                    </label>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* View segmented control */}
          <div className="flex shrink-0 items-center gap-0.5 rounded-lg border border-line bg-bg-elevated p-0.5">
            {VIEW_MODES.map((v) => (
              <button
                key={v.key}
                onClick={() => setMode(v.key)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  mode === v.key ? 'bg-accent text-black' : 'text-txt-3 hover:text-txt-1'
                }`}
              >
                {v.label}
              </button>
            ))}
          </div>
        </header>

        {/* View body */}
        {mode === 'day' || mode === 'week' ? (
          <TimeGrid
            days={viewDays}
            positioned={positionedByDay}
            classworkByDay={classworkByDay}
            schoolColor={schoolColor}
            allDayByDay={allDayByDay}
            now={now}
            onSlotClick={openNewAt}
            onEventClick={openEvent}
            onOpenAssignment={openAssignmentInCanvas}
          />
        ) : mode === 'month' ? (
          <MonthGrid
            cursor={cursor}
            chipsByDay={monthChipsByDay}
            onDayClick={(d) => {
              setCursor(d)
              openNewAllDay(d)
            }}
            onEventClick={openEvent}
            onOpenAssignment={openAssignmentInCanvas}
          />
        ) : (
          <YearGrid
            year={cursor.getFullYear()}
            onPick={(d) => {
              setCursor(d)
              setMode('month')
            }}
          />
        )}

      {/* Editor modal */}
      {editor && (
        <EventEditor
          state={editor}
          calendars={calendars}
          onSave={(e) => void saveEvent(e)}
          onDelete={(id) => void deleteEvent(id)}
          onClose={() => setEditor(null)}
        />
      )}
    </div>
  )
}
