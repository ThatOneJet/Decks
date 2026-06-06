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
import { dialog, BrowserWindow } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
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

/**
 * A sanitized, viewable file attachment surfaced to the renderer. `url` is a
 * directly-fetchable Canvas URL (it carries a `verifier` token when fetched via
 * the API, so it's viewable without the Bearer token). Never includes secrets.
 */
interface CanvasAttachment {
  id?: string
  displayName?: string
  fileName?: string
  contentType?: string
  url?: string
  previewUrl?: string
  sizeBytes?: number
  mimeClass?: string
  /**
   * Set when this entry is an EMBEDDED media/video (Canvas Studio, a YouTube/
   * Vimeo/other iframe, a `<video>`/`<source>` tag, or a Canvas media_object).
   * The renderer shows a video icon and opens `url` in an embedded web deck so
   * the media player / Studio iframe plays in the sandboxed browser (it can't be
   * rendered inline). Not a downloadable file — it has no file id/size.
   */
  isMedia?: boolean
}

/** Map a Canvas file object (from /files endpoints or an `attachments[]` entry). */
function mapAttachment(raw: unknown, instanceUrl: string): CanvasAttachment | null {
  if (!raw || typeof raw !== 'object') return null
  const f = raw as {
    id?: unknown
    display_name?: unknown
    filename?: unknown
    'content-type'?: unknown
    content_type?: unknown
    mime_class?: unknown
    url?: unknown
    preview_url?: unknown
    size?: unknown
  }
  const id = asId(f.id)
  const url = typeof f.url === 'string' && f.url ? f.url : undefined
  const displayName =
    typeof f.display_name === 'string'
      ? f.display_name
      : typeof f.filename === 'string'
        ? f.filename
        : undefined
  // Nothing usable without at least a url or an id we can resolve later.
  if (!url && !id) return null
  const previewUrlRaw = typeof f.preview_url === 'string' ? f.preview_url : undefined
  const previewUrl = previewUrlRaw
    ? previewUrlRaw.startsWith('http')
      ? previewUrlRaw
      : `${instanceUrl}${previewUrlRaw.startsWith('/') ? '' : '/'}${previewUrlRaw}`
    : undefined
  return {
    id,
    displayName,
    fileName: typeof f.filename === 'string' ? f.filename : undefined,
    contentType:
      typeof f['content-type'] === 'string'
        ? (f['content-type'] as string)
        : typeof f.content_type === 'string'
          ? (f.content_type as string)
          : undefined,
    url,
    previewUrl,
    sizeBytes: asNum(f.size),
    mimeClass: typeof f.mime_class === 'string' ? f.mime_class : undefined
  }
}

/**
 * Scrape embedded Canvas file references out of a body/description HTML string.
 * Canvas renders attachments as `<a class="instructure_file_link" href=".../files/{id}...">`,
 * `<img src=".../files/{id}/preview...">`, and `<iframe src=".../files/{id}/...">`.
 * Returns the unique file ids referenced (best-effort; tolerant of any HTML).
 */
function fileIdsFromHtml(html: unknown): string[] {
  if (typeof html !== 'string' || !html) return []
  const ids = new Set<string>()
  // Match /files/{id} or /courses/{c}/files/{id} anywhere in the markup.
  const re = /\/files\/(\d+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    if (m[1]) ids.add(m[1])
  }
  return [...ids]
}

/** Decode the handful of HTML entities that appear inside attribute urls. */
function decodeAttr(s: string): string {
  return s
    .replace(/&amp;/gi, '&')
    .replace(/&#38;/g, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
}

/** Resolve a possibly-relative media url against the instance origin. */
function absolutize(url: string, instanceUrl: string): string {
  const u = decodeAttr(url.trim())
  if (!u) return ''
  if (/^https?:\/\//i.test(u)) return u
  if (u.startsWith('//')) return `https:${u}`
  return `${instanceUrl}${u.startsWith('/') ? '' : '/'}${u}`
}

/** A short, human label for an embedded media item (from the host, best-effort). */
function mediaLabelFor(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '')
    if (/youtu/.test(host)) return 'YouTube video'
    if (/vimeo/.test(host)) return 'Vimeo video'
    if (/instructuremedia|studio/.test(host)) return 'Canvas Studio video'
    return 'Embedded video'
  } catch {
    return 'Embedded video'
  }
}

/**
 * Scrape EMBEDDED media (video) references out of a body/description HTML string.
 * Canvas videos are usually not plain file links — they're Studio embeds, external
 * `<iframe>`s (YouTube/Vimeo/embed), `<video>`/`<source>` tags, or links to
 * `/media_objects/` / `/media_attachments_iframe/`. Returns each as a media
 * attachment (with a video icon flag) whose `url` is openable in a web deck so it
 * plays in the embedded browser. Best-effort; tolerant of any/no HTML. Deduped.
 */
function mediaEmbedsFromHtml(html: unknown, instanceUrl: string): CanvasAttachment[] {
  if (typeof html !== 'string' || !html) return []
  const out: CanvasAttachment[] = []
  const seen = new Set<string>()

  const add = (rawUrl: string, label?: string): void => {
    const url = absolutize(rawUrl, instanceUrl)
    if (!url || seen.has(url)) return
    // Skip obvious non-video iframes (Office viewer, docs previews) and the
    // file-preview iframes already surfaced via fileIdsFromHtml.
    if (/\/files\/\d+/.test(url)) return
    seen.add(url)
    out.push({ url, displayName: label ?? mediaLabelFor(url), isMedia: true })
  }

  // <iframe src="..."> — Studio / YouTube / Vimeo / generic embeds.
  const iframeRe = /<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi
  let m: RegExpExecArray | null
  while ((m = iframeRe.exec(html)) !== null) {
    const src = m[1] ?? ''
    if (!src) continue
    // Only treat as media when it looks like a video host / Canvas media embed.
    if (
      /(youtu|vimeo|instructuremedia|studio|media_objects|media_attachments|\/embed\b|player|wistia|kaltura|dailymotion|loom)/i.test(
        src
      )
    ) {
      add(src)
    }
  }

  // <video ... src="..."> and nested <source src="...">.
  const videoTagRe = /<video\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi
  while ((m = videoTagRe.exec(html)) !== null) {
    if (m[1]) add(m[1])
  }
  const sourceRe = /<source\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi
  while ((m = sourceRe.exec(html)) !== null) {
    if (m[1]) add(m[1])
  }

  // Canvas media links: /media_objects/{id}, /media_attachments_iframe/{id},
  // /media_attachments/{id} (also caught via href on <a class="instructure_..">).
  const mediaPathRe = /(https?:\/\/[^\s"'<>]*)?(\/media_(?:objects|attachments(?:_iframe)?)\/[\w-]+)/gi
  while ((m = mediaPathRe.exec(html)) !== null) {
    const full = `${m[1] ?? ''}${m[2] ?? ''}`
    if (full) add(full)
  }

  return out
}

/** One threaded discussion entry (recursive: replies are the same shape). */
interface DiscussionEntry {
  id?: string
  userId?: string
  authorName?: string
  message?: string
  createdAt?: string
  parentId: string | null
  replies: DiscussionEntry[]
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
    // Bound every request so a slow/unreachable instance can't hang the deck.
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 15_000)
    try {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${creds.token}`,
          Accept: 'application/json'
        },
        signal: ctrl.signal
      })
      if (!res.ok) {
        throw new Error(`Canvas API error (${res.status})`)
      }
      return (await res.json()) as unknown
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Authenticated write (POST/PUT/DELETE) against the configured instance.
   * Mirrors apiGet (Bearer auth, Accept json, 15s timeout). When `body` is a
   * URLSearchParams it's sent as application/x-www-form-urlencoded — Canvas
   * accepts bracketed keys like `submission[submission_type]`. On a non-2xx
   * response throws `Canvas API error (status)` augmented with the response
   * body's message/error when one is present (never the token).
   */
  private async apiSend(
    creds: CanvasCreds,
    method: 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: URLSearchParams
  ): Promise<unknown> {
    const url = `${creds.instanceUrl}${path}`
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 15_000)
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${creds.token}`,
        Accept: 'application/json'
      }
      if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded'
      const res = await fetch(url, {
        method,
        headers,
        body: body ? body.toString() : undefined,
        signal: ctrl.signal
      })
      const text = await res.text()
      let parsed: unknown = undefined
      if (text) {
        try {
          parsed = JSON.parse(text)
        } catch {
          parsed = undefined
        }
      }
      if (!res.ok) {
        const detail = this.extractErrorMessage(parsed)
        throw new Error(detail ? `Canvas API error (${res.status}): ${detail}` : `Canvas API error (${res.status})`)
      }
      return parsed
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Authenticated JSON write (POST/PUT). Mirrors apiSend (Bearer auth, Accept
   * json, 15s timeout) but sends `body` as application/json — needed for the
   * quiz endpoints that expect nested arrays like `quiz_questions:[{ id, answer }]`
   * which can't be expressed cleanly as form-encoded brackets. Same clean error
   * surface (status + Canvas message, never the token).
   */
  private async apiSendJson(
    creds: CanvasCreds,
    method: 'POST' | 'PUT',
    path: string,
    body: unknown
  ): Promise<unknown> {
    const url = `${creds.instanceUrl}${path}`
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 15_000)
    try {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${creds.token}`,
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body ?? {}),
        signal: ctrl.signal
      })
      const text = await res.text()
      let parsed: unknown = undefined
      if (text) {
        try {
          parsed = JSON.parse(text)
        } catch {
          parsed = undefined
        }
      }
      if (!res.ok) {
        const detail = this.extractErrorMessage(parsed)
        throw new Error(detail ? `Canvas API error (${res.status}): ${detail}` : `Canvas API error (${res.status})`)
      }
      return parsed
    } finally {
      clearTimeout(timer)
    }
  }

  /** Pull a human message out of a Canvas error body (errors[].message, message, error). */
  private extractErrorMessage(body: unknown): string | undefined {
    if (!body || typeof body !== 'object') return undefined
    const b = body as { message?: unknown; error?: unknown; errors?: unknown }
    if (typeof b.message === 'string' && b.message.trim()) return b.message.trim()
    if (typeof b.error === 'string' && b.error.trim()) return b.error.trim()
    const errs = b.errors
    if (Array.isArray(errs)) {
      for (const e of errs) {
        if (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string') {
          const m = (e as { message: string }).message.trim()
          if (m) return m
        }
      }
    } else if (errs && typeof errs === 'object') {
      // Canvas sometimes returns { errors: { base: [{ message }] } }.
      for (const v of Object.values(errs as Record<string, unknown>)) {
        if (Array.isArray(v)) {
          for (const e of v) {
            if (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string') {
              const m = (e as { message: string }).message.trim()
              if (m) return m
            }
          }
        }
      }
    }
    return undefined
  }

  /** Like apiGet but swallows per-call failures, returning null instead. */
  private async apiGetSafe(creds: CanvasCreds, path: string): Promise<unknown> {
    try {
      return await this.apiGet(creds, path)
    } catch {
      return null
    }
  }

  /**
   * Resolve viewable attachments for a piece of content. Combines:
   *  - any explicit `attachments[]` already on the payload (mapped directly), and
   *  - file ids scraped from the content HTML (description/body), each resolved
   *    via GET /api/v1/courses/{courseId}/files/{id} so the returned `url` carries
   *    a `verifier` token (directly fetchable/viewable without the Bearer token).
   * Best-effort and de-duplicated by file id (then url). Tolerates failures.
   */
  private async resolveAttachments(
    creds: CanvasCreds,
    courseId: string | undefined,
    html: unknown,
    explicit: unknown
  ): Promise<CanvasAttachment[]> {
    const out: CanvasAttachment[] = []
    const seenIds = new Set<string>()
    const seenUrls = new Set<string>()

    const push = (att: CanvasAttachment | null): void => {
      if (!att) return
      if (att.id && seenIds.has(att.id)) return
      if (att.url && seenUrls.has(att.url)) return
      if (att.id) seenIds.add(att.id)
      if (att.url) seenUrls.add(att.url)
      out.push(att)
    }

    // 1) Explicit attachments array, if present (Canvas sends these as file objects).
    if (Array.isArray(explicit)) {
      for (const a of explicit) push(mapAttachment(a, creds.instanceUrl))
    }

    // 2) File ids embedded in the HTML → resolve each to get a verifier url.
    if (courseId) {
      const ids = fileIdsFromHtml(html).filter((id) => !seenIds.has(id))
      if (ids.length > 0) {
        const resolved = await Promise.allSettled(
          ids.slice(0, 30).map((id) =>
            this.apiGetSafe(creds, `/api/v1/courses/${courseId}/files/${id}`)
          )
        )
        for (const r of resolved) {
          if (r.status === 'fulfilled' && r.value) push(mapAttachment(r.value, creds.instanceUrl))
        }
      }
    }

    // 3) Embedded media/video (Studio, iframes, <video>, media_objects). These
    //    aren't file links so they're scraped separately and opened in a web deck.
    for (const media of mediaEmbedsFromHtml(html, creds.instanceUrl)) push(media)

    return out
  }

  /** One file's sanitized, directly-viewable metadata (verifier url included). */
  private async fetchFile(
    creds: CanvasCreds,
    params?: Record<string, unknown>
  ): Promise<{
    id?: string
    displayName?: string
    fileName?: string
    contentType?: string
    url?: string
    mimeClass?: string
  }> {
    const courseId = asId(params?.courseId)
    const fileId = asId(params?.fileId)
    if (!courseId || !fileId) throw new Error('Missing course or file id')
    const data = (await this.apiGet(
      creds,
      `/api/v1/courses/${courseId}/files/${fileId}`
    )) as unknown
    const att = mapAttachment(data, creds.instanceUrl) ?? {}
    return {
      id: att.id ?? fileId,
      displayName: att.displayName,
      fileName: att.fileName,
      contentType: att.contentType,
      url: att.url,
      mimeClass: att.mimeClass
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
      case 'assignment':
        return this.fetchAssignment(creds, _params)
      case 'course':
        return this.fetchCourse(creds, _params)
      case 'announcements':
        return this.fetchAnnouncements(creds)
      case 'calendar':
        return this.fetchCalendar(creds)
      case 'discussions':
        return this.fetchDiscussions(creds, _params)
      case 'discussionView':
        return this.fetchDiscussionView(creds, _params)
      case 'pages':
        return this.fetchPages(creds, _params)
      case 'page':
        return this.fetchPage(creds, _params)
      case 'file':
        return this.fetchFile(creds, _params)
      case 'modules':
        return this.fetchModules(creds, _params)
      case 'quizzes':
        return this.fetchQuizzes(creds, _params)
      case 'submit':
        return this.submitAssignment(creds, _params)
      case 'submitFile':
        return this.submitFile(creds, _params)
      case 'comment':
        return this.postComment(creds, _params)
      case 'postReply':
        return this.postReply(creds, _params)
      case 'markModuleItem':
        return this.markModuleItem(creds, _params)
      case 'quizStart':
        return this.quizStart(creds, _params)
      case 'quizQuestions':
        return this.quizQuestions(creds, _params)
      case 'quizAnswer':
        return this.quizAnswer(creds, _params)
      case 'quizSubmit':
        return this.quizSubmit(creds, _params)
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
  ): Promise<Array<{ id?: string; name?: string; courseCode?: string; htmlUrl?: string }>> {
    const data = (await this.apiGet(
      creds,
      '/api/v1/courses?enrollment_state=active&per_page=50'
    )) as unknown
    if (!Array.isArray(data)) return []
    return data.map((c) => {
      const course = c as { id?: unknown; name?: unknown; course_code?: unknown }
      const id = asId(course.id)
      return {
        id,
        name: typeof course.name === 'string' ? course.name : undefined,
        courseCode: typeof course.course_code === 'string' ? course.course_code : undefined,
        htmlUrl: id ? `${creds.instanceUrl}/courses/${id}` : undefined
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
    Array<{
      id?: string
      title?: string
      startAt?: string
      type?: string
      courseId?: string
      htmlUrl?: string
    }>
  > {
    const data = (await this.apiGet(creds, '/api/v1/users/self/upcoming_events')) as unknown
    if (!Array.isArray(data)) return []
    return data.map((e) => {
      const ev = e as {
        id?: unknown
        title?: unknown
        start_at?: unknown
        type?: unknown
        context_code?: unknown
        html_url?: unknown
      }
      const ctx = typeof ev.context_code === 'string' ? ev.context_code : ''
      return {
        id: asId(ev.id),
        title: typeof ev.title === 'string' ? ev.title : undefined,
        startAt: typeof ev.start_at === 'string' ? ev.start_at : undefined,
        type: typeof ev.type === 'string' ? ev.type : undefined,
        courseId: ctx.startsWith('course_') ? ctx.slice('course_'.length) : undefined,
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
      htmlUrl?: string
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
      const courseId = asId(course.id)
      return {
        courseId,
        name: typeof course.name === 'string' ? course.name : undefined,
        courseCode: typeof course.course_code === 'string' ? course.course_code : undefined,
        score: asNum(enr?.computed_current_score),
        grade: typeof enr?.computed_current_grade === 'string' ? enr.computed_current_grade : undefined,
        htmlUrl: courseId ? `${creds.instanceUrl}/courses/${courseId}` : undefined
      }
    })
  }

  /**
   * Assignments merged across active courses, sorted by due date. Covers BOTH
   * past and upcoming (no `bucket=upcoming` restriction) so the renderer can
   * show overdue/missing/past items above today and upcoming below. Capped at
   * ~120 of the most temporally-relevant rows (nearest to now, kept undated).
   */
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
      submissionState?: string
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
      submissionState?: string
    }

    const courses = await this.activeCourses(creds)
    if (courses.length === 0) return []

    const settled = await Promise.allSettled(
      courses.map(async (course): Promise<AssignmentRow[]> => {
        // No bucket filter → includes past-due assignments too. include[]=submission
        // gives us each item's submission workflow_state for missing/done logic.
        const data = (await this.apiGet(
          creds,
          `/api/v1/users/self/courses/${course.id}/assignments?order_by=due_at&per_page=40&include[]=submission`
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
          const submissionState = typeof wf === 'string' ? wf : undefined
          return {
            id: asId(item.id),
            courseId: course.id,
            courseName: course.name ?? course.courseCode,
            name: typeof item.name === 'string' ? item.name : undefined,
            dueAt: typeof item.due_at === 'string' ? item.due_at : undefined,
            pointsPossible: asNum(item.points_possible),
            htmlUrl: typeof item.html_url === 'string' ? item.html_url : undefined,
            hasSubmitted:
              submissionState !== undefined &&
              submissionState !== 'unsubmitted',
            submissionState
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

    // Cap ~120 keeping items nearest to "now" (so we don't drop near-term past
    // or upcoming in favour of far-future/far-past items).
    if (merged.length <= 120) return merged
    const now = Date.now()
    const ranked = [...merged].sort((a, b) => {
      const da = a.dueAt ? Math.abs(new Date(a.dueAt).getTime() - now) : Number.POSITIVE_INFINITY
      const db = b.dueAt ? Math.abs(new Date(b.dueAt).getTime() - now) : Number.POSITIVE_INFINITY
      return da - db
    })
    const keep = new Set(ranked.slice(0, 120))
    return merged.filter((m) => keep.has(m))
  }

  /** Full detail for one assignment (lazy-loaded by the detail view). */
  private async fetchAssignment(
    creds: CanvasCreds,
    params?: Record<string, unknown>
  ): Promise<{
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
    submissionTypes?: string[]
    allowedAttempts?: number
    quizId?: string
    quizType?: string
    timeLimit?: number
    comments?: Array<{ authorName?: string; comment?: string; createdAt?: string }>
    attachments?: CanvasAttachment[]
  }> {
    const courseId = asId(params?.courseId)
    const assignmentId = asId(params?.assignmentId)
    if (!courseId || !assignmentId) {
      throw new Error('Missing course or assignment id')
    }
    const data = (await this.apiGet(
      creds,
      `/api/v1/courses/${courseId}/assignments/${assignmentId}?include[]=submission&include[]=submission_comments`
    )) as unknown
    const item = (data ?? {}) as {
      id?: unknown
      name?: unknown
      due_at?: unknown
      points_possible?: unknown
      html_url?: unknown
      description?: unknown
      submission_types?: unknown
      allowed_attempts?: unknown
      quiz_id?: unknown
      attachments?: unknown
      submission?: {
        workflow_state?: unknown
        score?: unknown
        submitted_at?: unknown
        submission_comments?: unknown
      }
    }
    const sub = item.submission ?? {}
    const submissionTypes = Array.isArray(item.submission_types)
      ? item.submission_types.filter((t): t is string => typeof t === 'string')
      : undefined
    const rawComments = sub.submission_comments
    const comments = Array.isArray(rawComments)
      ? rawComments.map((c) => {
          const com = c as {
            author_name?: unknown
            author?: { display_name?: unknown }
            comment?: unknown
            created_at?: unknown
          }
          return {
            authorName:
              typeof com.author_name === 'string'
                ? com.author_name
                : typeof com.author?.display_name === 'string'
                  ? com.author.display_name
                  : undefined,
            comment: typeof com.comment === 'string' ? com.comment : undefined,
            createdAt: typeof com.created_at === 'string' ? com.created_at : undefined
          }
        })
      : undefined
    // If this assignment is backed by a quiz, fetch the quiz to learn its type
    // (classic vs New Quizzes) + time limit so the renderer can decide whether to
    // offer the in-app take flow. Best-effort — never blocks the assignment view.
    const quizId = asId(item.quiz_id)
    let quizType: string | undefined
    let timeLimit: number | undefined
    if (quizId) {
      const quizRaw = (await this.apiGetSafe(
        creds,
        `/api/v1/courses/${courseId}/quizzes/${quizId}`
      )) as { quiz_type?: unknown; time_limit?: unknown } | null
      if (quizRaw) {
        quizType = typeof quizRaw.quiz_type === 'string' ? quizRaw.quiz_type : undefined
        timeLimit = asNum(quizRaw.time_limit)
      }
    }

    // Viewable file attachments: any explicit attachments[] + files embedded in
    // the description HTML, each resolved to a verifier url. Best-effort.
    const attachments = await this.resolveAttachments(
      creds,
      courseId,
      item.description,
      item.attachments
    )

    return {
      id: asId(item.id) ?? assignmentId,
      name: typeof item.name === 'string' ? item.name : undefined,
      courseId,
      dueAt: typeof item.due_at === 'string' ? item.due_at : undefined,
      pointsPossible: asNum(item.points_possible),
      htmlUrl:
        typeof item.html_url === 'string'
          ? item.html_url
          : `${creds.instanceUrl}/courses/${courseId}/assignments/${assignmentId}`,
      // Pass through the raw HTML; renderer strips it safely (no innerHTML).
      description: typeof item.description === 'string' ? item.description : undefined,
      submissionState: typeof sub.workflow_state === 'string' ? sub.workflow_state : undefined,
      score: asNum(sub.score),
      submittedAt: typeof sub.submitted_at === 'string' ? sub.submitted_at : undefined,
      submissionTypes,
      allowedAttempts: asNum(item.allowed_attempts),
      quizId,
      quizType,
      timeLimit,
      comments,
      attachments
    }
  }

  /** Course header + current grade for the course detail view. */
  private async fetchCourse(
    creds: CanvasCreds,
    params?: Record<string, unknown>
  ): Promise<{
    id?: string
    name?: string
    courseCode?: string
    htmlUrl?: string
    score?: number
    grade?: string
  }> {
    const courseId = asId(params?.courseId)
    if (!courseId) throw new Error('Missing course id')
    const data = (await this.apiGet(
      creds,
      `/api/v1/courses/${courseId}?include[]=total_scores`
    )) as unknown
    const course = (data ?? {}) as {
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
      id: asId(course.id) ?? courseId,
      name: typeof course.name === 'string' ? course.name : undefined,
      courseCode: typeof course.course_code === 'string' ? course.course_code : undefined,
      htmlUrl: `${creds.instanceUrl}/courses/${courseId}`,
      score: asNum(enr?.computed_current_score),
      grade: typeof enr?.computed_current_grade === 'string' ? enr.computed_current_grade : undefined
    }
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

  // ───────────────────────────── Discussions ──────────────────────────────

  /** Discussion topics for one course, newest first. */
  private async fetchDiscussions(
    creds: CanvasCreds,
    params?: Record<string, unknown>
  ): Promise<
    Array<{
      id?: string
      title?: string
      postedAt?: string
      htmlUrl?: string
      isAnnouncement: boolean
      requireInitialPost: boolean
      unreadCount?: number
    }>
  > {
    const courseId = asId(params?.courseId)
    if (!courseId) throw new Error('Missing course id')
    const data = (await this.apiGet(
      creds,
      `/api/v1/courses/${courseId}/discussion_topics?per_page=40`
    )) as unknown
    if (!Array.isArray(data)) return []
    const items = data.map((d) => {
      const t = d as {
        id?: unknown
        title?: unknown
        posted_at?: unknown
        created_at?: unknown
        html_url?: unknown
        is_announcement?: unknown
        require_initial_post?: unknown
        unread_count?: unknown
      }
      const posted =
        typeof t.posted_at === 'string'
          ? t.posted_at
          : typeof t.created_at === 'string'
            ? t.created_at
            : undefined
      return {
        id: asId(t.id),
        title: typeof t.title === 'string' ? t.title : undefined,
        postedAt: posted,
        htmlUrl: typeof t.html_url === 'string' ? t.html_url : undefined,
        isAnnouncement: !!t.is_announcement,
        requireInitialPost: !!t.require_initial_post,
        unreadCount: asNum(t.unread_count)
      }
    })
    items.sort((a, b) => {
      const ta = a.postedAt ? new Date(a.postedAt).getTime() : 0
      const tb = b.postedAt ? new Date(b.postedAt).getTime() : 0
      return tb - ta
    })
    return items
  }

  /**
   * One discussion topic with its threaded entries. Combines the topic detail
   * (title/message/author) with the /view endpoint (nested entries +
   * participants map for author display names).
   */
  private async fetchDiscussionView(
    creds: CanvasCreds,
    params?: Record<string, unknown>
  ): Promise<{
    id?: string
    title?: string
    message?: string
    postedAt?: string
    entries: DiscussionEntry[]
  }> {
    const courseId = asId(params?.courseId)
    const topicId = asId(params?.topicId)
    if (!courseId || !topicId) throw new Error('Missing course or topic id')

    const [topicRaw, viewRaw] = await Promise.all([
      this.apiGet(creds, `/api/v1/courses/${courseId}/discussion_topics/${topicId}`),
      this.apiGetSafe(creds, `/api/v1/courses/${courseId}/discussion_topics/${topicId}/view`)
    ])

    const topic = (topicRaw ?? {}) as {
      id?: unknown
      title?: unknown
      message?: unknown
      posted_at?: unknown
      created_at?: unknown
      author?: { display_name?: unknown }
      user_name?: unknown
    }
    const posted =
      typeof topic.posted_at === 'string'
        ? topic.posted_at
        : typeof topic.created_at === 'string'
          ? topic.created_at
          : undefined

    // Build participant id → display name map from the /view payload.
    const participants = new Map<string, string>()
    const view = (viewRaw ?? {}) as { view?: unknown; participants?: unknown }
    if (Array.isArray(view.participants)) {
      for (const p of view.participants) {
        const pp = p as { id?: unknown; display_name?: unknown }
        const pid = asId(pp.id)
        if (pid && typeof pp.display_name === 'string') participants.set(pid, pp.display_name)
      }
    }

    const mapEntry = (raw: unknown): DiscussionEntry => {
      const e = raw as {
        id?: unknown
        user_id?: unknown
        message?: unknown
        created_at?: unknown
        parent_id?: unknown
        deleted?: unknown
        replies?: unknown
      }
      const userId = asId(e.user_id)
      const deleted = !!e.deleted
      const replies = Array.isArray(e.replies) ? e.replies.map(mapEntry) : []
      return {
        id: asId(e.id),
        userId,
        authorName: userId ? participants.get(userId) : undefined,
        message: deleted ? '' : typeof e.message === 'string' ? e.message : undefined,
        createdAt: typeof e.created_at === 'string' ? e.created_at : undefined,
        parentId: asId(e.parent_id) ?? null,
        replies
      }
    }

    const entries = Array.isArray(view.view) ? view.view.map(mapEntry) : []

    return {
      id: asId(topic.id) ?? topicId,
      title: typeof topic.title === 'string' ? topic.title : undefined,
      message: typeof topic.message === 'string' ? topic.message : undefined,
      postedAt: posted,
      entries
    }
  }

  // ─────────────────────────── Pages & Modules ────────────────────────────

  /** Wiki pages for one course (most-recently-updated first). */
  private async fetchPages(
    creds: CanvasCreds,
    params?: Record<string, unknown>
  ): Promise<Array<{ url?: string; title?: string; updatedAt?: string; published: boolean }>> {
    const courseId = asId(params?.courseId)
    if (!courseId) throw new Error('Missing course id')
    const data = (await this.apiGet(
      creds,
      `/api/v1/courses/${courseId}/pages?sort=updated_at&order=desc&per_page=40`
    )) as unknown
    if (!Array.isArray(data)) return []
    return data.map((p) => {
      const page = p as { url?: unknown; title?: unknown; updated_at?: unknown; published?: unknown }
      return {
        url: typeof page.url === 'string' ? page.url : undefined,
        title: typeof page.title === 'string' ? page.title : undefined,
        updatedAt: typeof page.updated_at === 'string' ? page.updated_at : undefined,
        published: !!page.published
      }
    })
  }

  /** Full body of one wiki page. */
  private async fetchPage(
    creds: CanvasCreds,
    params?: Record<string, unknown>
  ): Promise<{ title?: string; body?: string; updatedAt?: string; attachments?: CanvasAttachment[] }> {
    const courseId = asId(params?.courseId)
    const pageUrl = typeof params?.pageUrl === 'string' ? params.pageUrl : asId(params?.pageUrl)
    if (!courseId || !pageUrl) throw new Error('Missing course or page id')
    const data = (await this.apiGet(
      creds,
      `/api/v1/courses/${courseId}/pages/${encodeURIComponent(pageUrl)}`
    )) as unknown
    const page = (data ?? {}) as { title?: unknown; body?: unknown; updated_at?: unknown }
    // Files embedded in the page body, resolved to verifier urls. Best-effort.
    const attachments = await this.resolveAttachments(creds, courseId, page.body, undefined)
    return {
      title: typeof page.title === 'string' ? page.title : undefined,
      // Raw HTML body; renderer is responsible for safe rendering.
      body: typeof page.body === 'string' ? page.body : undefined,
      updatedAt: typeof page.updated_at === 'string' ? page.updated_at : undefined,
      attachments
    }
  }

  /** Modules for one course, each with its items. */
  private async fetchModules(
    creds: CanvasCreds,
    params?: Record<string, unknown>
  ): Promise<
    Array<{
      id?: string
      name?: string
      position?: number
      items: Array<{
        id?: string
        title?: string
        type?: string
        htmlUrl?: string
        pageUrl?: string
        contentId?: string
        completed: boolean
        requirementType?: string
      }>
    }>
  > {
    const courseId = asId(params?.courseId)
    if (!courseId) throw new Error('Missing course id')
    const data = (await this.apiGet(
      creds,
      `/api/v1/courses/${courseId}/modules?include[]=items&per_page=50`
    )) as unknown
    if (!Array.isArray(data)) return []
    return data.map((m) => {
      const mod = m as { id?: unknown; name?: unknown; position?: unknown; items?: unknown }
      const items = Array.isArray(mod.items)
        ? mod.items.map((i) => {
            const it = i as {
              id?: unknown
              title?: unknown
              type?: unknown
              html_url?: unknown
              page_url?: unknown
              content_id?: unknown
              completion_requirement?: { type?: unknown; completed?: unknown }
            }
            const cr = it.completion_requirement
            return {
              id: asId(it.id),
              title: typeof it.title === 'string' ? it.title : undefined,
              type: typeof it.type === 'string' ? it.type : undefined,
              htmlUrl: typeof it.html_url === 'string' ? it.html_url : undefined,
              pageUrl: typeof it.page_url === 'string' ? it.page_url : undefined,
              contentId: asId(it.content_id),
              completed: !!cr?.completed,
              requirementType: typeof cr?.type === 'string' ? cr.type : undefined
            }
          })
        : []
      return {
        id: asId(mod.id),
        name: typeof mod.name === 'string' ? mod.name : undefined,
        position: asNum(mod.position),
        items
      }
    })
  }

  /** Quizzes for one course, sorted by due date. */
  private async fetchQuizzes(
    creds: CanvasCreds,
    params?: Record<string, unknown>
  ): Promise<
    Array<{
      id?: string
      title?: string
      dueAt?: string
      pointsPossible?: number
      questionCount?: number
      htmlUrl?: string
      quizType?: string
      allowedAttempts?: number
      locked: boolean
    }>
  > {
    const courseId = asId(params?.courseId)
    if (!courseId) throw new Error('Missing course id')
    const data = (await this.apiGet(
      creds,
      `/api/v1/courses/${courseId}/quizzes?per_page=40`
    )) as unknown
    if (!Array.isArray(data)) return []
    const items = data.map((q) => {
      const quiz = q as {
        id?: unknown
        title?: unknown
        due_at?: unknown
        points_possible?: unknown
        question_count?: unknown
        html_url?: unknown
        quiz_type?: unknown
        allowed_attempts?: unknown
        locked_for_user?: unknown
      }
      return {
        id: asId(quiz.id),
        title: typeof quiz.title === 'string' ? quiz.title : undefined,
        dueAt: typeof quiz.due_at === 'string' ? quiz.due_at : undefined,
        pointsPossible: asNum(quiz.points_possible),
        questionCount: asNum(quiz.question_count),
        htmlUrl: typeof quiz.html_url === 'string' ? quiz.html_url : undefined,
        quizType: typeof quiz.quiz_type === 'string' ? quiz.quiz_type : undefined,
        allowedAttempts: asNum(quiz.allowed_attempts),
        locked: !!quiz.locked_for_user
      }
    })
    items.sort((a, b) => {
      const ta = a.dueAt ? new Date(a.dueAt).getTime() : Number.POSITIVE_INFINITY
      const tb = b.dueAt ? new Date(b.dueAt).getTime() : Number.POSITIVE_INFINITY
      return ta - tb
    })
    return items
  }

  // ──────────────────────────────── Writes ────────────────────────────────

  /** Submit an assignment as text entry or URL. */
  private async submitAssignment(
    creds: CanvasCreds,
    params?: Record<string, unknown>
  ): Promise<{ ok: true; submittedAt?: string; state?: string }> {
    const courseId = asId(params?.courseId)
    const assignmentId = asId(params?.assignmentId)
    const kind = params?.kind
    const value = typeof params?.value === 'string' ? params.value : ''
    if (!courseId || !assignmentId) throw new Error('Missing course or assignment id')
    if (kind !== 'text' && kind !== 'url') throw new Error('Invalid submission kind')
    if (!value.trim()) throw new Error('Submission is empty')

    const form = new URLSearchParams()
    if (kind === 'text') {
      form.set('submission[submission_type]', 'online_text_entry')
      form.set('submission[body]', value)
    } else {
      form.set('submission[submission_type]', 'online_url')
      form.set('submission[url]', value)
    }
    const res = (await this.apiSend(
      creds,
      'POST',
      `/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions`,
      form
    )) as { submitted_at?: unknown; workflow_state?: unknown } | null
    return {
      ok: true,
      submittedAt: typeof res?.submitted_at === 'string' ? res.submitted_at : undefined,
      state: typeof res?.workflow_state === 'string' ? res.workflow_state : undefined
    }
  }

  /**
   * Submit a file to an assignment via Canvas's 3-step upload flow:
   * 1) reserve an upload slot, 2) POST the file bytes to the returned URL,
   * 3) attach the resulting file id to a new submission.
   */
  private async submitFile(
    creds: CanvasCreds,
    params?: Record<string, unknown>
  ): Promise<{ ok: true; fileName: string } | { cancelled: true }> {
    const courseId = asId(params?.courseId)
    const assignmentId = asId(params?.assignmentId)
    if (!courseId || !assignmentId) throw new Error('Missing course or assignment id')

    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const picked = win
      ? await dialog.showOpenDialog(win, { properties: ['openFile'] })
      : await dialog.showOpenDialog({ properties: ['openFile'] })
    if (picked.canceled || !picked.filePaths.length) return { cancelled: true }

    const filePath = picked.filePaths[0]
    const fileName = path.basename(filePath)

    try {
      const bytes = await fs.promises.readFile(filePath)

      // Step 1 — reserve the upload slot.
      const reserveForm = new URLSearchParams()
      reserveForm.set('name', fileName)
      reserveForm.set('size', String(bytes.byteLength))
      const reservation = (await this.apiSend(
        creds,
        'POST',
        `/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions/self/files`,
        reserveForm
      )) as { upload_url?: unknown; upload_params?: unknown } | null
      const uploadUrl = typeof reservation?.upload_url === 'string' ? reservation.upload_url : ''
      if (!uploadUrl) throw new Error('Canvas did not return an upload URL')
      const uploadParams =
        reservation?.upload_params && typeof reservation.upload_params === 'object'
          ? (reservation.upload_params as Record<string, unknown>)
          : {}

      // Step 2 — POST the file as multipart/form-data. Params first, file last.
      const multipart = new FormData()
      for (const [k, v] of Object.entries(uploadParams)) {
        multipart.append(k, v == null ? '' : String(v))
      }
      multipart.append('file', new Blob([bytes]), fileName)

      const uploadCtrl = new AbortController()
      const uploadTimer = setTimeout(() => uploadCtrl.abort(), 15_000)
      let fileId: string | undefined
      try {
        const uploadRes = await fetch(uploadUrl, {
          method: 'POST',
          body: multipart,
          redirect: 'manual',
          signal: uploadCtrl.signal
        })
        // Canvas may 201 with the file JSON, or 3xx with a Location to confirm.
        if (uploadRes.status >= 300 && uploadRes.status < 400) {
          const location = uploadRes.headers.get('location')
          if (!location) throw new Error('Upload confirmation URL missing')
          const confirmed = (await this.apiGet(
            creds,
            location.startsWith('http') ? location.replace(creds.instanceUrl, '') : location
          )) as { id?: unknown } | null
          fileId = asId(confirmed?.id)
        } else if (uploadRes.ok) {
          const text = await uploadRes.text()
          try {
            const parsed = JSON.parse(text) as { id?: unknown }
            fileId = asId(parsed?.id)
          } catch {
            fileId = undefined
          }
        } else {
          throw new Error(`File upload failed (${uploadRes.status})`)
        }
      } finally {
        clearTimeout(uploadTimer)
      }

      if (!fileId) throw new Error('Could not resolve uploaded file id')

      // Step 3 — attach the file to a submission.
      const submitForm = new URLSearchParams()
      submitForm.set('submission[submission_type]', 'online_upload')
      submitForm.append('submission[file_ids][]', fileId)
      await this.apiSend(
        creds,
        'POST',
        `/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions`,
        submitForm
      )

      return { ok: true, fileName }
    } catch (err) {
      throw new Error(`File submission failed: ${safeError(err)}`)
    }
  }

  /** Add a submission comment to an assignment. */
  private async postComment(
    creds: CanvasCreds,
    params?: Record<string, unknown>
  ): Promise<{ ok: true }> {
    const courseId = asId(params?.courseId)
    const assignmentId = asId(params?.assignmentId)
    const text = typeof params?.text === 'string' ? params.text : ''
    if (!courseId || !assignmentId) throw new Error('Missing course or assignment id')
    if (!text.trim()) throw new Error('Comment is empty')
    const form = new URLSearchParams()
    form.set('comment[text_comment]', text)
    await this.apiSend(
      creds,
      'PUT',
      `/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions/self`,
      form
    )
    return { ok: true }
  }

  /** Post a discussion entry, or a reply to an existing entry. */
  private async postReply(
    creds: CanvasCreds,
    params?: Record<string, unknown>
  ): Promise<{ ok: true; id?: string; createdAt?: string }> {
    const courseId = asId(params?.courseId)
    const topicId = asId(params?.topicId)
    const message = typeof params?.message === 'string' ? params.message : ''
    const parentEntryId = asId(params?.parentEntryId)
    if (!courseId || !topicId) throw new Error('Missing course or topic id')
    if (!message.trim()) throw new Error('Reply is empty')

    const form = new URLSearchParams()
    form.set('message', message)
    const path = parentEntryId
      ? `/api/v1/courses/${courseId}/discussion_topics/${topicId}/entries/${parentEntryId}/replies`
      : `/api/v1/courses/${courseId}/discussion_topics/${topicId}/entries`
    const res = (await this.apiSend(creds, 'POST', path, form)) as {
      id?: unknown
      created_at?: unknown
    } | null
    return {
      ok: true,
      id: asId(res?.id),
      createdAt: typeof res?.created_at === 'string' ? res.created_at : undefined
    }
  }

  /** Mark a module item done/not-done. Tolerates 404 (item has no requirement). */
  private async markModuleItem(
    creds: CanvasCreds,
    params?: Record<string, unknown>
  ): Promise<{ ok: true }> {
    const courseId = asId(params?.courseId)
    const moduleId = asId(params?.moduleId)
    const itemId = asId(params?.itemId)
    const done = !!params?.done
    if (!courseId || !moduleId || !itemId) throw new Error('Missing course, module, or item id')
    const path = `/api/v1/courses/${courseId}/modules/${moduleId}/items/${itemId}/done`
    try {
      await this.apiSend(creds, done ? 'PUT' : 'DELETE', path)
    } catch (err) {
      // Not every item supports completion-marking; swallow 404s.
      const msg = safeError(err)
      if (!/\(404\)/.test(msg)) throw err
    }
    return { ok: true }
  }

  // ──────────────────────── Classic quiz taking ──────────────────────────
  //
  // Canvas's CLASSIC quiz-submissions API (quiz_type assignment/practice_quiz/
  // graded_survey/survey). New Quizzes have no public take API → the renderer
  // keeps its "Open in Canvas" fallback for those. Each in-progress attempt is
  // identified by a {attempt, validation_token} pair the renderer threads back
  // through quizAnswer/quizSubmit. The token never leaves main.

  /**
   * Start (or resume) a classic-quiz submission. POSTs a new submission; if one
   * is already in progress Canvas 4xx's, so we GET the existing list and reuse
   * the in-progress (`untaken`) attempt. Returns the ids + validation token the
   * renderer must echo back on subsequent answer/submit calls.
   */
  private async quizStart(
    creds: CanvasCreds,
    params?: Record<string, unknown>
  ): Promise<{
    submissionId: string
    attempt: number
    validationToken: string
    workflowState?: string
  }> {
    const courseId = asId(params?.courseId)
    const quizId = asId(params?.quizId)
    if (!courseId || !quizId) throw new Error('Missing course or quiz id')

    const pickSubmission = (
      raw: unknown,
      preferUntaken: boolean
    ): {
      submissionId?: string
      attempt?: number
      validationToken?: string
      workflowState?: string
    } | null => {
      const body = (raw ?? {}) as { quiz_submissions?: unknown }
      const list = Array.isArray(body.quiz_submissions) ? body.quiz_submissions : []
      if (list.length === 0) return null
      const mapped = list.map((s) => {
        const sub = s as {
          id?: unknown
          attempt?: unknown
          validation_token?: unknown
          workflow_state?: unknown
        }
        return {
          submissionId: asId(sub.id),
          attempt: asNum(sub.attempt),
          validationToken:
            typeof sub.validation_token === 'string' ? sub.validation_token : undefined,
          workflowState: typeof sub.workflow_state === 'string' ? sub.workflow_state : undefined
        }
      })
      if (preferUntaken) {
        const untaken = mapped.find((m) => m.workflowState === 'untaken')
        if (untaken) return untaken
      }
      return mapped[mapped.length - 1] ?? null
    }

    let chosen: ReturnType<typeof pickSubmission> = null
    try {
      const started = await this.apiSend(
        creds,
        'POST',
        `/api/v1/courses/${courseId}/quizzes/${quizId}/submissions`
      )
      chosen = pickSubmission(started, false)
    } catch {
      // Likely "already in progress" → resume the existing untaken attempt.
      const existing = await this.apiGet(
        creds,
        `/api/v1/courses/${courseId}/quizzes/${quizId}/submissions`
      )
      chosen = pickSubmission(existing, true)
    }

    if (!chosen?.submissionId || !chosen.validationToken || typeof chosen.attempt !== 'number') {
      throw new Error('Could not start this quiz')
    }
    return {
      submissionId: chosen.submissionId,
      attempt: chosen.attempt,
      validationToken: chosen.validationToken,
      workflowState: chosen.workflowState
    }
  }

  /** Questions for an in-progress quiz submission (sanitized). */
  private async quizQuestions(
    creds: CanvasCreds,
    params?: Record<string, unknown>
  ): Promise<
    Array<{
      id?: string
      name?: string
      text?: string
      type?: string
      answers: Array<{ id?: string; text?: string }>
    }>
  > {
    const submissionId = asId(params?.submissionId)
    if (!submissionId) throw new Error('Missing submission id')
    const data = (await this.apiGet(
      creds,
      `/api/v1/quiz_submissions/${submissionId}/questions`
    )) as { quiz_submission_questions?: unknown } | null
    const list = Array.isArray(data?.quiz_submission_questions)
      ? data!.quiz_submission_questions
      : []
    return list.map((q) => {
      const question = q as {
        id?: unknown
        question_name?: unknown
        question_text?: unknown
        question_type?: unknown
        answers?: unknown
      }
      const answers = Array.isArray(question.answers)
        ? question.answers.map((a) => {
            const ans = a as { id?: unknown; text?: unknown; html?: unknown }
            const html = typeof ans.html === 'string' && ans.html.trim() ? ans.html : undefined
            return {
              id: asId(ans.id),
              // Prefer the richer HTML answer when present (passed through raw;
              // renderer renders it safely), else the plain text.
              text: html ?? (typeof ans.text === 'string' ? ans.text : undefined)
            }
          })
        : []
      return {
        id: asId(question.id),
        name: typeof question.question_name === 'string' ? question.question_name : undefined,
        // Raw HTML question body; renderer renders it safely (no innerHTML).
        text: typeof question.question_text === 'string' ? question.question_text : undefined,
        type: typeof question.question_type === 'string' ? question.question_type : undefined,
        answers
      }
    })
  }

  /**
   * Save an answer for one question, mapping the renderer's value to Canvas's
   * per-type expected shape. Uses the JSON write because some answers are arrays
   * (multiple-answers) or objects (multiple-blanks).
   */
  private async quizAnswer(
    creds: CanvasCreds,
    params?: Record<string, unknown>
  ): Promise<{ ok: true }> {
    const submissionId = asId(params?.submissionId)
    const attempt = asNum(params?.attempt)
    const validationToken =
      typeof params?.validationToken === 'string' ? params.validationToken : undefined
    const questionId = asNum(params?.questionId)
    const questionType =
      typeof params?.questionType === 'string' ? params.questionType : undefined
    if (!submissionId || typeof attempt !== 'number' || !validationToken) {
      throw new Error('Missing submission, attempt, or token')
    }
    if (typeof questionId !== 'number') throw new Error('Missing question id')

    const raw = params?.answer
    let answer: unknown
    switch (questionType) {
      case 'multiple_choice_question':
      case 'true_false_question': {
        // A single answer id.
        const n = asNum(raw)
        answer = typeof n === 'number' ? n : null
        break
      }
      case 'multiple_answers_question': {
        // An array of selected answer ids.
        const arr = Array.isArray(raw) ? raw : []
        answer = arr.map((v) => asNum(v)).filter((v): v is number => typeof v === 'number')
        break
      }
      case 'numerical_question': {
        const n = asNum(raw)
        answer = typeof n === 'number' ? n : null
        break
      }
      case 'short_answer_question':
      case 'essay_question': {
        answer = typeof raw === 'string' ? raw : ''
        break
      }
      case 'fill_in_multiple_blanks_question': {
        // A map of blank-name → text. Pass through plain objects only.
        answer = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
        break
      }
      default: {
        // Best-effort pass-through for any other classic type.
        answer = raw ?? ''
      }
    }

    await this.apiSendJson(
      creds,
      'POST',
      `/api/v1/quiz_submissions/${submissionId}/questions`,
      {
        attempt,
        validation_token: validationToken,
        quiz_questions: [{ id: questionId, answer }]
      }
    )
    return { ok: true }
  }

  /** Complete (submit) a classic-quiz attempt; returns the graded result. */
  private async quizSubmit(
    creds: CanvasCreds,
    params?: Record<string, unknown>
  ): Promise<{ ok: true; score?: number; keptScore?: number; workflowState?: string }> {
    const courseId = asId(params?.courseId)
    const quizId = asId(params?.quizId)
    const submissionId = asId(params?.submissionId)
    const attempt = asNum(params?.attempt)
    const validationToken =
      typeof params?.validationToken === 'string' ? params.validationToken : undefined
    if (!courseId || !quizId || !submissionId) {
      throw new Error('Missing course, quiz, or submission id')
    }
    if (typeof attempt !== 'number' || !validationToken) {
      throw new Error('Missing attempt or token')
    }
    const res = (await this.apiSendJson(
      creds,
      'POST',
      `/api/v1/courses/${courseId}/quizzes/${quizId}/submissions/${submissionId}/complete`,
      { attempt, validation_token: validationToken }
    )) as { quiz_submissions?: unknown } | null
    const list =
      res && Array.isArray((res as { quiz_submissions?: unknown }).quiz_submissions)
        ? (res as { quiz_submissions: unknown[] }).quiz_submissions
        : []
    const graded = (list[0] ?? res ?? {}) as {
      score?: unknown
      kept_score?: unknown
      workflow_state?: unknown
    }
    return {
      ok: true,
      score: asNum(graded.score),
      keptScore: asNum(graded.kept_score),
      workflowState: typeof graded.workflow_state === 'string' ? graded.workflow_state : undefined
    }
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
