/**
 * Decks — Calendar ProviderClient (main process).
 *
 * Backs the native Calendar deck. Like RSS, Calendar has NO external auth — it is
 * OUR OWN calendar: the user's events + their chosen calendars (Personal/Work/
 * School…) live in a small local JSON blob persisted PER ACCOUNT via the secure
 * token store, keyed by `accountKey('calendar', accountId)` (see ../accounts). It
 * isn't a secret, but reusing the store gives us atomic persistence for free.
 *
 * Two read-only data sources are computed at fetch time (never persisted):
 *   - National holidays — fetched in MAIN from the free, key-less Nager.Date API;
 *                          surfaced as its own "Holidays" overlay in the deck.
 *   - Canvas classwork  — assignment due dates pulled at RUNTIME from the 'canvas'
 *                          provider via the registry (getProvider). The Calendar
 *                          client owns NO Canvas credential and imports NO Canvas
 *                          file — it only depends on canvas through the registry,
 *                          so it stays compilable and tolerant of no-canvas. The
 *                          deck no longer exposes this as a standalone toggle: it
 *                          folds these due dates into the user's "School" calendar
 *                          (fetched/shown only while School is visible). The
 *                          'classwork' resource below is unchanged.
 *
 * The renderer only ever receives sanitized JSON.
 */
import { saveToken, getToken, removeToken } from '../tokens'
import {
  accountKey,
  listAccounts as listProviderAccounts,
  upsertAccount,
  removeAccount
} from '../accounts'
import { getProvider } from './registry'
import type { ProviderClient } from './types'
import type { ProviderId, ProviderStatus, AccountSummary } from '@shared/types'

const ID: ProviderId = 'calendar'

/** Default country for the holidays overlay (ISO 3166-1 alpha-2). */
const DEFAULT_COUNTRY = 'US'

/** Per-request timeout for the holidays fetch. */
const HOLIDAYS_TIMEOUT_MS = 15_000

/** A user event on one of the user's calendars. */
export interface CalendarEvent {
  id: string
  calendarId: string
  title: string
  /** ISO-8601 start. */
  start: string
  /** ISO-8601 end. */
  end: string
  allDay?: boolean
  notes?: string
  location?: string
}

/** One user calendar (a colored, toggleable collection of events). */
export interface Calendar {
  id: string
  name: string
  /** A #rrggbb hue used everywhere this calendar's events render. */
  color: string
  visible: boolean
}

/** Persisted (non-secret) blob: the user's calendars + events + chosen country. */
interface CalendarStore {
  events: CalendarEvent[]
  calendars: Calendar[]
  country?: string
}

/** The default calendars seeded for a fresh account. */
function defaultCalendars(): Calendar[] {
  return [
    { id: 'personal', name: 'Personal', color: '#35e3ff', visible: true },
    { id: 'work', name: 'Work', color: '#a78bfa', visible: true },
    { id: 'school', name: 'School', color: '#4ef0a6', visible: true }
  ]
}

/** A fresh, seeded store. */
function seededStore(): CalendarStore {
  return { events: [], calendars: defaultCalendars(), country: DEFAULT_COUNTRY }
}

/** Coerce an unknown into a trimmed string (or ''). */
function asStr(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** Validate + normalize one event from an untrusted params payload. */
function sanitizeEvent(raw: unknown): CalendarEvent | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const id = asStr(o.id)
  const calendarId = asStr(o.calendarId)
  const title = typeof o.title === 'string' ? o.title : ''
  const start = asStr(o.start)
  const end = asStr(o.end)
  if (!calendarId || !start || !end) return null
  const event: CalendarEvent = {
    id: id || `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    calendarId,
    title: title || 'Untitled',
    start,
    end
  }
  if (o.allDay === true) event.allDay = true
  if (typeof o.notes === 'string' && o.notes.trim()) event.notes = o.notes
  if (typeof o.location === 'string' && o.location.trim()) event.location = o.location
  return event
}

/** Validate + normalize a calendar list from an untrusted params payload. */
function sanitizeCalendars(raw: unknown): Calendar[] | null {
  if (!Array.isArray(raw)) return null
  const out: Calendar[] = []
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue
    const o = c as Record<string, unknown>
    const id = asStr(o.id)
    if (!id) continue
    out.push({
      id,
      name: typeof o.name === 'string' && o.name.trim() ? o.name : id,
      color: typeof o.color === 'string' && o.color.trim() ? o.color : '#6d7689',
      visible: o.visible !== false
    })
  }
  return out
}

export class CalendarClient implements ProviderClient {
  readonly id: ProviderId = ID

  // ── Store ──────────────────────────────────────────────────────────────

  /** Secure-store key for one account's calendar blob. */
  private key(accountId: string): string {
    return accountKey(this.id, accountId)
  }

  /** Read + parse one account's blob, seeding defaults when absent/unparseable. */
  private readStore(accountId: string): CalendarStore {
    const raw = getToken(this.key(accountId))
    if (!raw) return seededStore()
    try {
      const parsed = JSON.parse(raw) as Partial<CalendarStore>
      const events = Array.isArray(parsed?.events)
        ? parsed.events
            .map((e) => sanitizeEvent(e))
            .filter((e): e is CalendarEvent => e !== null)
        : []
      const calendars =
        sanitizeCalendars(parsed?.calendars) ?? defaultCalendars()
      const country =
        typeof parsed?.country === 'string' && parsed.country.trim()
          ? parsed.country.trim().toUpperCase()
          : DEFAULT_COUNTRY
      // A store with no calendars at all is unusable — re-seed defaults.
      return {
        events,
        calendars: calendars.length > 0 ? calendars : defaultCalendars(),
        country
      }
    } catch {
      return seededStore()
    }
  }

  /** Persist one account's blob. */
  private writeStore(accountId: string, store: CalendarStore): void {
    saveToken(this.key(accountId), JSON.stringify(store))
  }

  /** Ensure a store exists on disk (seed if first time), returning it. */
  private ensureStore(accountId: string): CalendarStore {
    const existing = getToken(this.key(accountId))
    const store = this.readStore(accountId)
    if (!existing) this.writeStore(accountId, store)
    return store
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  async connect(opts: {
    accountId: string
    mode: 'token' | 'oauth'
    token?: string
    fields?: Record<string, string>
  }): Promise<ProviderStatus> {
    const { accountId } = opts
    // Seed defaults on first connect; keep existing data on reconnect.
    this.ensureStore(accountId)
    const label = opts.fields?.label?.trim() || 'Calendar'
    upsertAccount(this.id, { id: accountId, label })
    // Calendar needs no auth — always "connected".
    return { provider: this.id, connected: true, account: label }
  }

  async disconnect(accountId: string): Promise<void> {
    removeToken(this.key(accountId))
    removeAccount(this.id, accountId)
  }

  async status(accountId: string): Promise<ProviderStatus> {
    const entry = listProviderAccounts(this.id).find((a) => a.id === accountId)
    const connected = !!entry || !!getToken(this.key(accountId))
    return {
      provider: this.id,
      connected,
      account: entry?.label ?? (connected ? 'Calendar' : undefined)
    }
  }

  async listAccounts(): Promise<AccountSummary[]> {
    return listProviderAccounts(this.id)
  }

  // ── Resources ──────────────────────────────────────────────────────────

  async fetch(
    accountId: string,
    resource: string,
    params?: Record<string, unknown>
  ): Promise<unknown> {
    switch (resource) {
      case 'load':
        return this.load(accountId)
      case 'addEvent':
        return this.addEvent(accountId, params)
      case 'updateEvent':
        return this.updateEvent(accountId, params)
      case 'deleteEvent':
        return this.deleteEvent(accountId, params)
      case 'setCalendars':
        return this.setCalendars(accountId, params)
      case 'holidays':
        return this.holidays(params)
      case 'classwork':
        return this.classwork(params)
      default:
        return this.load(accountId)
    }
  }

  /** Full load: events + calendars + country (seeds defaults if empty). */
  private load(accountId: string): {
    events: CalendarEvent[]
    calendars: Calendar[]
    country: string
  } {
    const store = this.ensureStore(accountId)
    return {
      events: store.events,
      calendars: store.calendars,
      country: store.country ?? DEFAULT_COUNTRY
    }
  }

  /** Create one event, persist, return the updated event list. */
  private addEvent(
    accountId: string,
    params?: Record<string, unknown>
  ): { events: CalendarEvent[] } {
    const event = sanitizeEvent(params?.event)
    if (!event) throw new Error('Invalid event')
    const store = this.readStore(accountId)
    const events = [...store.events.filter((e) => e.id !== event.id), event]
    this.writeStore(accountId, { ...store, events })
    return { events }
  }

  /** Update one event (by id), persist, return the updated event list. */
  private updateEvent(
    accountId: string,
    params?: Record<string, unknown>
  ): { events: CalendarEvent[] } {
    const event = sanitizeEvent(params?.event)
    if (!event) throw new Error('Invalid event')
    const store = this.readStore(accountId)
    if (!store.events.some((e) => e.id === event.id)) {
      throw new Error('Event not found')
    }
    const events = store.events.map((e) => (e.id === event.id ? event : e))
    this.writeStore(accountId, { ...store, events })
    return { events }
  }

  /** Delete one event (by id), persist, return the updated event list. */
  private deleteEvent(
    accountId: string,
    params?: Record<string, unknown>
  ): { events: CalendarEvent[] } {
    const id = asStr(params?.id)
    if (!id) throw new Error('Missing event id')
    const store = this.readStore(accountId)
    const events = store.events.filter((e) => e.id !== id)
    this.writeStore(accountId, { ...store, events })
    return { events }
  }

  /** Replace the calendar list / visibility, persist, return it. */
  private setCalendars(
    accountId: string,
    params?: Record<string, unknown>
  ): { calendars: Calendar[] } {
    const calendars = sanitizeCalendars(params?.calendars)
    if (!calendars || calendars.length === 0) throw new Error('Invalid calendars')
    const store = this.readStore(accountId)
    this.writeStore(accountId, { ...store, calendars })
    return { calendars }
  }

  /**
   * Public holidays for a year/country from the free, key-less Nager.Date API.
   * 15s abort timeout; any failure (offline, bad country, non-2xx) → []. Returns
   * `[{ date: 'yyyy-mm-dd', name }]`.
   */
  private async holidays(
    params?: Record<string, unknown>
  ): Promise<Array<{ date: string; name: string }>> {
    const year =
      typeof params?.year === 'number' && Number.isFinite(params.year)
        ? Math.trunc(params.year)
        : new Date().getFullYear()
    const country = (asStr(params?.country) || DEFAULT_COUNTRY).toUpperCase()

    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), HOLIDAYS_TIMEOUT_MS)
    try {
      const res = await fetch(
        `https://date.nager.at/api/v3/PublicHolidays/${year}/${encodeURIComponent(country)}`,
        { signal: ctrl.signal, headers: { Accept: 'application/json' } }
      )
      if (!res.ok) return []
      const data = (await res.json()) as unknown
      if (!Array.isArray(data)) return []
      const out: Array<{ date: string; name: string }> = []
      for (const h of data) {
        const o = h as { date?: unknown; localName?: unknown; name?: unknown }
        const date = asStr(o.date)
        const name =
          (typeof o.localName === 'string' && o.localName.trim()
            ? o.localName
            : typeof o.name === 'string'
              ? o.name
              : '') || 'Holiday'
        if (date) out.push({ date, name })
      }
      return out
    } catch {
      return []
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Canvas classwork overlay: assignment due dates within [start, end]. Resolved
   * at RUNTIME via the registry — the Calendar client owns no Canvas credential.
   * Uses the first connected Canvas account. Any absence/failure → []. Returns
   * `[{ id, title, due(ISO), courseName }]`.
   */
  private async classwork(
    params?: Record<string, unknown>
  ): Promise<
    Array<{
      id: string
      title: string
      due: string
      courseName?: string
      courseId?: string
      hasSubmitted?: boolean
    }>
  > {
    const startMs = Date.parse(asStr(params?.start))
    const endMs = Date.parse(asStr(params?.end))
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) return []

    try {
      const canvas = getProvider('canvas')
      if (!canvas) return []
      const accounts = await canvas.listAccounts()
      const first = Array.isArray(accounts) ? accounts[0] : undefined
      if (!first?.id) return []

      const raw = await canvas.fetch(first.id, 'assignments')
      if (!Array.isArray(raw)) return []

      const out: Array<{
        id: string
        title: string
        due: string
        courseName?: string
        courseId?: string
        hasSubmitted?: boolean
      }> = []
      for (let i = 0; i < raw.length; i++) {
        const a = raw[i] as {
          id?: unknown
          name?: unknown
          dueAt?: unknown
          courseName?: unknown
          courseId?: unknown
          hasSubmitted?: unknown
        }
        const due = asStr(a.dueAt)
        if (!due) continue
        const t = Date.parse(due)
        if (Number.isNaN(t) || t < startMs || t > endMs) continue
        const id = asStr(a.id) || `canvas_${i}`
        out.push({
          id,
          title: typeof a.name === 'string' && a.name.trim() ? a.name : 'Assignment',
          due: new Date(t).toISOString(),
          courseName: typeof a.courseName === 'string' ? a.courseName : undefined,
          courseId: typeof a.courseId === 'string' ? a.courseId : undefined,
          // Pass through completion so the calendar can show only OPEN classwork.
          hasSubmitted: a.hasSubmitted === true
        })
      }
      return out
    } catch {
      return []
    }
  }
}
