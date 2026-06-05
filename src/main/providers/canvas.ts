/**
 * Decks — Canvas ProviderClient (main process).
 *
 * Adapter for the Canvas LMS REST API. Owns all I/O for the 'canvas' provider:
 * reads/writes its OWN credential blob via ../tokens, talks to the school's
 * Canvas instance, and returns SANITIZED JSON to the renderer (never the token,
 * never raw responses with secrets).
 *
 * Credential blob shape (one JSON string stored under the 'canvas' token slot):
 *   { instanceUrl: string; token: string; account?: string }
 *   - instanceUrl: the school's Canvas base origin (https, no trailing slash).
 *   - token:       a Canvas personal access token (Bearer).
 *   - account:     the user's display name, cached at connect so status() is
 *                  offline-cheap (no network round-trip).
 *
 * SECURITY: the token never leaves main and is never logged or returned to the
 * renderer. fetch() returns only mapped, sanitized fields.
 */
import type { ProviderClient } from './types'
import type { ProviderId, ProviderStatus } from '@shared/types'
import type { AccountSummary } from '@shared/types'
import { saveToken, getToken, removeToken } from '../tokens'
import { accountKey, listAccounts as listProviderAccounts, upsertAccount, removeAccount } from '../accounts'

const PROVIDER: ProviderId = 'canvas'

/** Persisted credential blob (stored JSON-encoded under the 'canvas' slot). */
interface CanvasCreds {
  instanceUrl: string
  token: string
  /** Cached account label so status() needs no network. */
  account?: string
}

/** Normalize a user-entered Canvas base URL: ensure https, strip trailing slash. */
function normalizeInstanceUrl(raw: string): string {
  let url = raw.trim()
  if (!url) return ''
  // Strip any path/query, keep just origin-ish; add https if no scheme.
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`
  }
  // Force https (Canvas is https-only).
  url = url.replace(/^http:\/\//i, 'https://')
  // Strip trailing slashes.
  url = url.replace(/\/+$/, '')
  return url
}

/** Read and parse the stored creds blob for one account, or null if absent/unparseable. */
function readCreds(key: string): CanvasCreds | null {
  const raw = getToken(key)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<CanvasCreds>
    if (parsed && typeof parsed.instanceUrl === 'string' && typeof parsed.token === 'string') {
      return { instanceUrl: parsed.instanceUrl, token: parsed.token, account: parsed.account }
    }
    return null
  } catch {
    return null
  }
}

/** A short, user-safe error string (never includes the token). */
function safeError(err: unknown): string {
  if (err instanceof Error) return err.message
  return 'Request failed'
}

/** Best-effort string coercion for ids that may arrive as number or string. */
function asId(v: unknown): string | undefined {
  if (typeof v === 'number') return String(v)
  if (typeof v === 'string') return v
  return undefined
}

/** Best-effort number coercion (Canvas sends scores as number|string|null). */
function asNum(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

/** Strip HTML tags + collapse whitespace, then truncate to `max` chars. */
function stripHtml(html: unknown, max = 200): string | undefined {
  if (typeof html !== 'string') return undefined
  const text = html
    .replace(/<br\s*\/?>(?=\S)/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return undefined
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

/** Lightweight active-course descriptor used to drive the per-course fetches. */
interface ActiveCourse {
  id: string
  name?: string
  courseCode?: string
}

export class CanvasClient implements ProviderClient {
  readonly id: ProviderId = PROVIDER

  /** Secure-store key for one account's credential blob. */
  private key(accountId: string): string {
    return accountKey(this.id, accountId)
  }

  /** Authenticated GET against the configured instance; returns parsed JSON. */
  private async apiGet(creds: CanvasCreds, path: string): Promise<unknown> {
    const url = `${creds.instanceUrl}${path}`
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${creds.token}`,
        Accept: 'application/json'
      }
    })
    if (!res.ok) {
      throw new Error(`Canvas API error (${res.status})`)
    }
    return (await res.json()) as unknown
  }

  /** Like apiGet but swallows per-call failures, returning null instead. */
  private async apiGetSafe(creds: CanvasCreds, path: string): Promise<unknown> {
    try {
      return await this.apiGet(creds, path)
    } catch {
      return null
    }
  }

  /** Resolve the user's active courses as id/name/code triples (best-effort). */
  private async activeCourses(creds: CanvasCreds): Promise<ActiveCourse[]> {
    const data = (await this.apiGetSafe(
      creds,
      '/api/v1/courses?enrollment_state=active&per_page=50'
    )) as unknown
    if (!Array.isArray(data)) return []
    const out: ActiveCourse[] = []
    for (const c of data) {
      const course = c as { id?: unknown; name?: unknown; course_code?: unknown }
      const id = asId(course.id)
      if (!id) continue
      out.push({
        id,
        name: typeof course.name === 'string' ? course.name : undefined,
        courseCode: typeof course.course_code === 'string' ? course.course_code : undefined
      })
    }
    return out
  }

  async connect(opts: {
    accountId: string
    mode: 'token' | 'oauth'
    token?: string
    fields?: Record<string, string>
  }): Promise<ProviderStatus> {
    const { accountId } = opts
    const token = (opts.token ?? '').trim()
    const rawInstance = opts.fields?.instanceUrl ?? ''
    const instanceUrl = normalizeInstanceUrl(rawInstance)

    if (!instanceUrl) {
      return { provider: PROVIDER, connected: false, error: 'Canvas URL is required' }
    }
    if (!token) {
      return { provider: PROVIDER, connected: false, error: 'Access token is required' }
    }

    try {
      const res = await fetch(`${instanceUrl}/api/v1/users/self`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json'
        }
      })
      if (!res.ok) {
        const msg =
          res.status === 401
            ? 'Invalid token — check your Canvas access token'
            : `Could not reach Canvas (${res.status})`
        return { provider: PROVIDER, connected: false, error: msg }
      }
      const user = (await res.json()) as { name?: string; short_name?: string }
      const account = user.name ?? user.short_name ?? 'Canvas'

      const creds: CanvasCreds = { instanceUrl, token, account }
      saveToken(this.key(accountId), JSON.stringify(creds))
      upsertAccount(this.id, { id: accountId, label: account })

      return { provider: PROVIDER, connected: true, account }
    } catch (err) {
      return {
        provider: PROVIDER,
        connected: false,
        error: `Could not reach Canvas: ${safeError(err)}`
      }
    }
  }

  async fetch(
    accountId: string,
    resource: string,
    _params?: Record<string, unknown>
  ): Promise<unknown> {
    const creds = readCreds(this.key(accountId))
    if (!creds) throw new Error('Canvas not connected')

    switch (resource) {
      case 'courses':
        return this.fetchCourses(creds)
      case 'todo':
        return this.fetchTodo(creds)
      case 'upcoming':
        return this.fetchUpcoming(creds)
      case 'grades':
        return this.fetchGrades(creds)
      case 'assignments':
        return this.fetchAssignments(creds)
      case 'announcements':
        return this.fetchAnnouncements(creds)
      case 'calendar':
        return this.fetchCalendar(creds)
      case 'dashboard':
      default: {
        const [courses, todo, upcoming] = await Promise.all([
          this.fetchCourses(creds),
          this.fetchTodo(creds),
          this.fetchUpcoming(creds)
        ])
        return { courses, todo, upcoming }
      }
    }
  }

  private async fetchCourses(
    creds: CanvasCreds
  ): Promise<Array<{ id?: string; name?: string; courseCode?: string }>> {
    const data = (await this.apiGet(
      creds,
      '/api/v1/courses?enrollment_state=active&per_page=50'
    )) as unknown
    if (!Array.isArray(data)) return []
    return data.map((c) => {
      const course = c as { id?: unknown; name?: unknown; course_code?: unknown }
      return {
        id: asId(course.id),
        name: typeof course.name === 'string' ? course.name : undefined,
        courseCode: typeof course.course_code === 'string' ? course.course_code : undefined
      }
    })
  }

  private async fetchTodo(
    creds: CanvasCreds
  ): Promise<
    Array<{
      type?: string
      title?: string
      courseId?: string
      dueAt?: string
      htmlUrl?: string
    }>
  > {
    const data = (await this.apiGet(creds, '/api/v1/users/self/todo')) as unknown
    if (!Array.isArray(data)) return []
    return data.map((t) => {
      const item = t as {
        type?: unknown
        assignment?: { name?: unknown; due_at?: unknown; html_url?: unknown }
        course_id?: unknown
        html_url?: unknown
        context_name?: unknown
      }
      const assignment = item.assignment ?? {}
      return {
        type: typeof item.type === 'string' ? item.type : undefined,
        title:
          typeof assignment.name === 'string'
            ? assignment.name
            : typeof item.context_name === 'string'
              ? item.context_name
              : undefined,
        courseId: asId(item.course_id),
        dueAt: typeof assignment.due_at === 'string' ? assignment.due_at : undefined,
        htmlUrl:
          typeof assignment.html_url === 'string'
            ? assignment.html_url
            : typeof item.html_url === 'string'
              ? item.html_url
              : undefined
      }
    })
  }

  private async fetchUpcoming(
    creds: CanvasCreds
  ): Promise<
    Array<{ id?: string; title?: string; startAt?: string; type?: string; htmlUrl?: string }>
  > {
    const data = (await this.apiGet(creds, '/api/v1/users/self/upcoming_events')) as unknown
    if (!Array.isArray(data)) return []
    return data.map((e) => {
      const ev = e as {
        id?: unknown
        title?: unknown
        start_at?: unknown
        type?: unknown
        html_url?: unknown
      }
      return {
        id: asId(ev.id),
        title: typeof ev.title === 'string' ? ev.title : undefined,
        startAt: typeof ev.start_at === 'string' ? ev.start_at : undefined,
        type: typeof ev.type === 'string' ? ev.type : undefined,
        htmlUrl: typeof ev.html_url === 'string' ? ev.html_url : undefined
      }
    })
  }

  /** Per-course current grade/score (reads enrollments[0] totals). */
  private async fetchGrades(creds: CanvasCreds): Promise<
    Array<{
      courseId?: string
      name?: string
      courseCode?: string
      score?: number
      grade?: string
    }>
  > {
    const data = (await this.apiGet(
      creds,
      '/api/v1/courses?enrollment_state=active&include[]=total_scores&include[]=current_grading_period_scores&per_page=50'
    )) as unknown
    if (!Array.isArray(data)) return []
    return data.map((c) => {
      const course = c as {
        id?: unknown
        name?: unknown
        course_code?: unknown
        enrollments?: Array<{
          computed_current_score?: unknown
          computed_current_grade?: unknown
        }>
      }
      const enr = Array.isArray(course.enrollments) ? course.enrollments[0] : undefined
      return {
        courseId: asId(course.id),
        name: typeof course.name === 'string' ? course.name : undefined,
        courseCode: typeof course.course_code === 'string' ? course.course_code : undefined,
        score: asNum(enr?.computed_current_score),
        grade: typeof enr?.computed_current_grade === 'string' ? enr.computed_current_grade : undefined
      }
    })
  }

  /** Upcoming assignments merged across active courses, sorted by due date. */
  private async fetchAssignments(creds: CanvasCreds): Promise<
    Array<{
      id?: string
      courseId?: string
      courseName?: string
      name?: string
      dueAt?: string
      pointsPossible?: number
      htmlUrl?: string
      hasSubmitted?: boolean
    }>
  > {
    type AssignmentRow = {
      id?: string
      courseId?: string
      courseName?: string
      name?: string
      dueAt?: string
      pointsPossible?: number
      htmlUrl?: string
      hasSubmitted?: boolean
    }

    const courses = await this.activeCourses(creds)
    if (courses.length === 0) return []

    const settled = await Promise.allSettled(
      courses.map(async (course): Promise<AssignmentRow[]> => {
        const data = (await this.apiGet(
          creds,
          `/api/v1/users/self/courses/${course.id}/assignments?order_by=due_at&per_page=20&bucket=upcoming`
        )) as unknown
        if (!Array.isArray(data)) return []
        return data.map((a): AssignmentRow => {
          const item = a as {
            id?: unknown
            name?: unknown
            due_at?: unknown
            points_possible?: unknown
            html_url?: unknown
            submission?: { workflow_state?: unknown }
          }
          const wf = item.submission?.workflow_state
          return {
            id: asId(item.id),
            courseId: course.id,
            courseName: course.name ?? course.courseCode,
            name: typeof item.name === 'string' ? item.name : undefined,
            dueAt: typeof item.due_at === 'string' ? item.due_at : undefined,
            pointsPossible: asNum(item.points_possible),
            htmlUrl: typeof item.html_url === 'string' ? item.html_url : undefined,
            hasSubmitted: typeof wf === 'string' && wf !== 'unsubmitted'
          }
        })
      })
    )

    const merged: AssignmentRow[] = []
    for (const r of settled) {
      if (r.status === 'fulfilled') merged.push(...r.value)
    }

    merged.sort((a, b) => {
      const ta = a.dueAt ? new Date(a.dueAt).getTime() : Number.POSITIVE_INFINITY
      const tb = b.dueAt ? new Date(b.dueAt).getTime() : Number.POSITIVE_INFINITY
      return ta - tb
    })

    return merged.slice(0, 60)
  }

  /** Recent announcements across active courses, newest first. */
  private async fetchAnnouncements(creds: CanvasCreds): Promise<
    Array<{
      id?: string
      title?: string
      courseId?: string
      postedAt?: string
      message?: string
      htmlUrl?: string
    }>
  > {
    const courses = await this.activeCourses(creds)
    if (courses.length === 0) return []

    const contextParams = courses.map((c) => `context_codes[]=course_${c.id}`).join('&')
    const data = (await this.apiGetSafe(
      creds,
      `/api/v1/announcements?${contextParams}&per_page=30`
    )) as unknown
    if (!Array.isArray(data)) return []

    const byCourse = new Map(courses.map((c) => [c.id, c]))
    const items = data.map((a) => {
      const item = a as {
        id?: unknown
        title?: unknown
        posted_at?: unknown
        created_at?: unknown
        message?: unknown
        html_url?: unknown
        context_code?: unknown
      }
      const ctx = typeof item.context_code === 'string' ? item.context_code : ''
      const courseId = ctx.startsWith('course_') ? ctx.slice('course_'.length) : undefined
      const posted =
        typeof item.posted_at === 'string'
          ? item.posted_at
          : typeof item.created_at === 'string'
            ? item.created_at
            : undefined
      return {
        id: asId(item.id),
        title:
          typeof item.title === 'string' && item.title.trim()
            ? item.title
            : byCourse.get(courseId ?? '')?.name ?? 'Announcement',
        courseId,
        postedAt: posted,
        message: stripHtml(item.message, 200),
        htmlUrl: typeof item.html_url === 'string' ? item.html_url : undefined
      }
    })

    items.sort((a, b) => {
      const ta = a.postedAt ? new Date(a.postedAt).getTime() : 0
      const tb = b.postedAt ? new Date(b.postedAt).getTime() : 0
      return tb - ta
    })

    return items
  }

  /** Calendar events + assignment due dates for the next 30 days. */
  private async fetchCalendar(creds: CanvasCreds): Promise<
    Array<{
      id?: string
      title?: string
      startAt?: string
      endAt?: string
      type?: string
      courseId?: string
      htmlUrl?: string
    }>
  > {
    const courses = await this.activeCourses(creds)
    if (courses.length === 0) return []

    const now = new Date()
    const end = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)
    const startDate = now.toISOString().slice(0, 10)
    const endDate = end.toISOString().slice(0, 10)
    const contextParams = courses.map((c) => `context_codes[]=course_${c.id}`).join('&')
    const window = `start_date=${startDate}&end_date=${endDate}&per_page=50&${contextParams}`

    const mapEvent = (
      e: unknown
    ): {
      id?: string
      title?: string
      startAt?: string
      endAt?: string
      type?: string
      courseId?: string
      htmlUrl?: string
    } => {
      const ev = e as {
        id?: unknown
        title?: unknown
        start_at?: unknown
        end_at?: unknown
        type?: unknown
        context_code?: unknown
        html_url?: unknown
        assignment?: { html_url?: unknown }
      }
      const ctx = typeof ev.context_code === 'string' ? ev.context_code : ''
      return {
        id: asId(ev.id),
        title: typeof ev.title === 'string' ? ev.title : undefined,
        startAt: typeof ev.start_at === 'string' ? ev.start_at : undefined,
        endAt: typeof ev.end_at === 'string' ? ev.end_at : undefined,
        type: typeof ev.type === 'string' ? ev.type : undefined,
        courseId: ctx.startsWith('course_') ? ctx.slice('course_'.length) : undefined,
        htmlUrl:
          typeof ev.html_url === 'string'
            ? ev.html_url
            : typeof ev.assignment?.html_url === 'string'
              ? ev.assignment.html_url
              : undefined
      }
    }

    const [eventsRaw, assignmentsRaw] = await Promise.all([
      this.apiGetSafe(creds, `/api/v1/calendar_events?type=event&${window}`),
      this.apiGetSafe(creds, `/api/v1/calendar_events?type=assignment&${window}`)
    ])

    const events = Array.isArray(eventsRaw) ? eventsRaw.map(mapEvent) : []
    const assignments = Array.isArray(assignmentsRaw) ? assignmentsRaw.map(mapEvent) : []
    const all = [...events, ...assignments]

    all.sort((a, b) => {
      const ta = a.startAt ? new Date(a.startAt).getTime() : Number.POSITIVE_INFINITY
      const tb = b.startAt ? new Date(b.startAt).getTime() : Number.POSITIVE_INFINITY
      return ta - tb
    })

    return all
  }

  async disconnect(accountId: string): Promise<void> {
    removeToken(this.key(accountId))
    removeAccount(this.id, accountId)
  }

  async status(accountId: string): Promise<ProviderStatus> {
    const creds = readCreds(this.key(accountId))
    if (creds) {
      return { provider: PROVIDER, connected: true, account: creds.account }
    }
    return { provider: PROVIDER, connected: false }
  }

  async listAccounts(): Promise<AccountSummary[]> {
    return listProviderAccounts(this.id)
  }
}
