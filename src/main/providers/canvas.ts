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
import { saveToken, getToken, removeToken } from '../tokens'

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

/** Read and parse the stored creds blob, or null if absent/unparseable. */
function readCreds(): CanvasCreds | null {
  const raw = getToken(PROVIDER)
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

export class CanvasClient implements ProviderClient {
  readonly id: ProviderId = PROVIDER

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

  async connect(opts: {
    mode: 'token' | 'oauth'
    token?: string
    fields?: Record<string, string>
  }): Promise<ProviderStatus> {
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
      saveToken(PROVIDER, JSON.stringify(creds))

      return { provider: PROVIDER, connected: true, account }
    } catch (err) {
      return {
        provider: PROVIDER,
        connected: false,
        error: `Could not reach Canvas: ${safeError(err)}`
      }
    }
  }

  async fetch(resource: string, _params?: Record<string, unknown>): Promise<unknown> {
    const creds = readCreds()
    if (!creds) throw new Error('Canvas not connected')

    switch (resource) {
      case 'courses':
        return this.fetchCourses(creds)
      case 'todo':
        return this.fetchTodo(creds)
      case 'upcoming':
        return this.fetchUpcoming(creds)
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

  async disconnect(): Promise<void> {
    removeToken(PROVIDER)
  }

  async status(): Promise<ProviderStatus> {
    const creds = readCreds()
    if (creds) {
      return { provider: PROVIDER, connected: true, account: creds.account }
    }
    return { provider: PROVIDER, connected: false }
  }
}
