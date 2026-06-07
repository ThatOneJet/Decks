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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { NativeDeckProps } from '../types'
import { useStore } from '../../store'
import type { Workspace } from '@shared/types'

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

/** A single submission comment on an assignment. */
interface CanvasComment {
  authorName?: string
  comment?: string
  createdAt?: string
}

/**
 * A viewable file attachment / embedded file (from the `assignment` and `page`
 * resources). `url` is a directly-fetchable Canvas URL carrying a verifier token.
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
  /** True for embedded media/video (Studio, iframe, <video>, media_object). */
  isMedia?: boolean
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
  submissionTypes?: string[]
  allowedAttempts?: number
  quizId?: string
  quizType?: string
  timeLimit?: number
  comments?: CanvasComment[]
  attachments?: CanvasAttachment[]
}

/** One question of an in-progress classic-quiz submission. */
interface CanvasQuizQuestion {
  id?: string
  name?: string
  text?: string
  type?: string
  answers?: Array<{ id?: string; text?: string }>
}

/** A started/resumed classic-quiz submission handle. */
interface CanvasQuizStart {
  submissionId: string
  attempt: number
  validationToken: string
  workflowState?: string
}

/** The graded result of a completed classic-quiz submission. */
interface CanvasQuizResult {
  ok: true
  score?: number
  keptScore?: number
  workflowState?: string
}

/** A discussion / announcement topic (from the `discussions` resource). */
interface CanvasDiscussion {
  id?: string
  title?: string
  postedAt?: string
  htmlUrl?: string
  isAnnouncement?: boolean
  requireInitialPost?: boolean
  unreadCount?: number
}

/** A nested discussion entry (reply). */
interface CanvasDiscussionEntry {
  id?: string
  authorName?: string
  message?: string
  createdAt?: string
  parentId?: string
  replies?: CanvasDiscussionEntry[]
}

/** A full discussion thread (from the `discussionView` resource). */
interface CanvasDiscussionThread {
  id?: string
  title?: string
  message?: string
  postedAt?: string
  entries?: CanvasDiscussionEntry[]
}

/** A full page (from the `page` resource). */
interface CanvasPage {
  title?: string
  body?: string
  updatedAt?: string
  attachments?: CanvasAttachment[]
}

/** A module item (from the `modules` resource). */
interface CanvasModuleItem {
  id?: string
  title?: string
  type?: string
  htmlUrl?: string
  pageUrl?: string
  contentId?: string
  completed?: boolean
  requirementType?: string
}

/** A course module with items (from the `modules` resource). */
interface CanvasModule {
  id?: string
  name?: string
  items?: CanvasModuleItem[]
}

/** A quiz (from the `quizzes` resource). */
interface CanvasQuiz {
  id?: string
  title?: string
  dueAt?: string
  pointsPossible?: number
  questionCount?: number
  htmlUrl?: string
  quizType?: string
  allowedAttempts?: number
  locked?: boolean
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
  | { type: 'discussions'; courseId: string }
  | { type: 'discussion'; courseId: string; topicId: string }
  | { type: 'page'; courseId: string; pageUrl: string }
  | { type: 'settings' }

/**
 * Canvas-style sequential navigation context for a detail view: the ORDERED list
 * of sibling items the current item belongs to (captured at the moment the user
 * clicked it) plus the current index. Drives the ‹ Previous / Next › controls so
 * the user can step through the same list they came from without going back.
 *
 * Each item carries its `courseId` because some source lists (the agenda, the
 * Assignments tab) span multiple courses. `id` is the assignmentId / topicId /
 * pageUrl depending on `kind`.
 */
interface NavItem {
  courseId: string
  id: string
}
interface NavContext {
  kind: 'assignment' | 'discussion' | 'page'
  items: NavItem[]
  index: number
}

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
 * Open `url` in a NEW embedded WEB deck (its own workspace with a single web
 * panel), mirroring AddDeckModal's addWebDeck pattern. Used to view files Decks
 * can't render inline (Office docs, etc.) without leaving the app.
 */
function addWebDeck(url: string, label: string): void {
  if (!url) return
  const { addWorkspace, activateWorkspace } = useStore.getState()
  const id = `ws_${crypto.randomUUID().slice(0, 8)}`
  const pid = crypto.randomUUID()
  const name = label.trim() || 'File'
  const ws: Workspace = {
    id,
    name,
    subtitle: '1 deck',
    color: '#35e3ff',
    glyph: name.charAt(0).toUpperCase() || 'F',
    partition: `persist:${id}`,
    live: { status: 'idle' },
    panels: [{ id: pid, title: name, url }],
    layout: { type: 'leaf', panelId: pid }
  }
  addWorkspace(ws)
  activateWorkspace(id)
}

/* ── Attachment / embedded-file viewing ── */

/** A coarse viewer category derived from an attachment's content type / name. */
type FileKind = 'image' | 'pdf' | 'video' | 'audio' | 'office' | 'other'

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|heic|avif)$/i
const VIDEO_EXT = /\.(mp4|webm|ogv|mov|m4v)$/i
const AUDIO_EXT = /\.(mp3|wav|ogg|m4a|aac|flac)$/i
const OFFICE_EXT = /\.(docx?|xlsx?|pptx?|odt|ods|odp)$/i

/** Classify an attachment into a viewer category (content type first, name fallback). */
function fileKind(att: CanvasAttachment): FileKind {
  // Embedded media (Studio/iframe/<video>/media_object) is always a video.
  if (att.isMedia) return 'video'
  const ct = (att.contentType ?? '').toLowerCase()
  const mc = (att.mimeClass ?? '').toLowerCase()
  const name = (att.fileName ?? att.displayName ?? '').toLowerCase()
  if (ct.startsWith('image/') || mc === 'image' || IMAGE_EXT.test(name)) return 'image'
  if (ct === 'application/pdf' || mc === 'pdf' || /\.pdf$/i.test(name)) return 'pdf'
  if (ct.startsWith('video/') || mc === 'video' || VIDEO_EXT.test(name)) return 'video'
  if (ct.startsWith('audio/') || mc === 'audio' || AUDIO_EXT.test(name)) return 'audio'
  if (
    mc === 'doc' ||
    mc === 'ppt' ||
    mc === 'xls' ||
    /(msword|officedocument|ms-excel|ms-powerpoint|opendocument)/.test(ct) ||
    OFFICE_EXT.test(name)
  ) {
    return 'office'
  }
  return 'other'
}

/** Microsoft Office Online embed URL for a publicly-reachable office file. */
function officeViewerUrl(url: string): string {
  return `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(url)}`
}

/** Human-readable file size, e.g. "1.4 MB". */
function formatSize(bytes?: number): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let n = bytes
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${i === 0 ? n : n.toFixed(1)} ${units[i]}`
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

/**
 * Render Canvas content HTML as SAFE, styled rich text (markdown-like, the way
 * Canvas shows it) WITHOUT dangerouslySetInnerHTML: parse with DOMParser, then
 * map a whitelist of elements to styled React nodes (headings, lists, bold,
 * links, quotes, code, tables, images). Unknown tags render their children only,
 * so no scripts/attributes ever execute.
 */
function renderHtmlNodes(nodes: NodeListOf<ChildNode>): React.ReactNode[] {
  return Array.from(nodes).map((n, i) => renderHtmlNode(n, i))
}

function renderHtmlNode(node: ChildNode, key: number): React.ReactNode {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent
  if (node.nodeType !== Node.ELEMENT_NODE) return null
  const el = node as HTMLElement
  const tag = el.tagName.toLowerCase()
  const kids = renderHtmlNodes(el.childNodes)
  switch (tag) {
    case 'p':
      return <p key={key} className="mb-2.5">{kids}</p>
    case 'br':
      return <br key={key} />
    case 'strong':
    case 'b':
      return <strong key={key} className="font-semibold text-txt-1">{kids}</strong>
    case 'em':
    case 'i':
      return <em key={key} className="italic">{kids}</em>
    case 'u':
      return <u key={key}>{kids}</u>
    case 'h1':
    case 'h2':
    case 'h3':
      return <div key={key} className="mb-1.5 mt-3.5 text-sm font-semibold text-txt-1">{kids}</div>
    case 'h4':
    case 'h5':
    case 'h6':
      return <div key={key} className="mb-1 mt-3 text-[13px] font-semibold text-txt-1">{kids}</div>
    case 'ul':
      return <ul key={key} className="mb-2.5 ml-4 list-disc space-y-1 marker:text-txt-4">{kids}</ul>
    case 'ol':
      return <ol key={key} className="mb-2.5 ml-4 list-decimal space-y-1 marker:text-txt-4">{kids}</ol>
    case 'li':
      return <li key={key} className="pl-1">{kids}</li>
    case 'a': {
      const href = el.getAttribute('href') || ''
      return (
        <a
          key={key}
          onClick={(e) => {
            e.preventDefault()
            if (/^https?:/i.test(href)) window.open(href, '_blank', 'noopener,noreferrer')
          }}
          className="cursor-pointer text-accent underline-offset-2 hover:underline"
        >
          {kids}
        </a>
      )
    }
    case 'blockquote':
      return (
        <blockquote key={key} className="my-2.5 border-l-2 border-accent-ring/40 pl-3 text-txt-3">
          {kids}
        </blockquote>
      )
    case 'code':
      return (
        <code key={key} className="rounded bg-bg px-1 py-0.5 font-mono text-[11px] text-txt-1">
          {kids}
        </code>
      )
    case 'pre':
      return (
        <pre key={key} className="my-2.5 overflow-auto rounded-lg bg-bg p-2.5 font-mono text-[11px] text-txt-2">
          {kids}
        </pre>
      )
    case 'hr':
      return <hr key={key} className="my-3 border-line" />
    case 'img': {
      const src = el.getAttribute('src') || ''
      if (!/^https?:/i.test(src)) return null
      return (
        <img
          key={key}
          src={src}
          alt={el.getAttribute('alt') || ''}
          className="my-2 max-w-full rounded-lg border border-line"
        />
      )
    }
    case 'table':
      return (
        <div key={key} className="my-2.5 overflow-auto">
          <table className="w-full border-collapse text-[11px]">{kids}</table>
        </div>
      )
    case 'thead':
      return <thead key={key}>{kids}</thead>
    case 'tbody':
      return <tbody key={key}>{kids}</tbody>
    case 'tr':
      return <tr key={key}>{kids}</tr>
    case 'th':
      return <th key={key} className="border border-line px-2 py-1 text-left font-semibold text-txt-1">{kids}</th>
    case 'td':
      return <td key={key} className="border border-line px-2 py-1 align-top">{kids}</td>
    case 'span':
      return <span key={key}>{kids}</span>
    case 'div':
    case 'section':
    case 'article':
      return <div key={key}>{kids}</div>
    default:
      return <span key={key}>{kids}</span>
  }
}

/** Canvas content rendered as styled rich text (safe — no innerHTML). */
function RichHtml({ html, className }: { html?: string; className?: string }): JSX.Element | null {
  const body = useMemo(() => {
    if (!html || !html.trim()) return null
    return new DOMParser().parseFromString(html, 'text/html').body
  }, [html])
  if (!body) return null
  return <div className={className}>{renderHtmlNodes(body.childNodes)}</div>
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

// ── User-chosen course colors ────────────────────────────────────────────────
// Persisted overrides keyed by courseId. Backed by localStorage + a tiny listener
// set so the deck re-renders (via useCourseColorsVersion) when a color changes.
const COURSE_COLOR_LS = 'decks.canvasCourseColors'
const courseColorOverrides = new Map<string, string>()
try {
  const raw = localStorage.getItem(COURSE_COLOR_LS)
  if (raw) for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, string>)) {
    if (typeof v === 'string') courseColorOverrides.set(k, v)
  }
} catch {
  /* ignore malformed cache */
}
const courseColorListeners = new Set<() => void>()
function setCourseColorOverride(courseId: string, hex: string | null): void {
  if (hex) courseColorOverrides.set(courseId, hex)
  else courseColorOverrides.delete(courseId)
  try {
    localStorage.setItem(COURSE_COLOR_LS, JSON.stringify(Object.fromEntries(courseColorOverrides)))
  } catch {
    /* storage full / unavailable — keep the in-memory override anyway */
  }
  courseColorListeners.forEach((fn) => fn())
}
/** Re-render subscriber: bumps whenever any course color override changes. */
function useCourseColorsVersion(): number {
  const [v, setV] = useState(0)
  useEffect(() => {
    const fn = (): void => setV((n) => n + 1)
    courseColorListeners.add(fn)
    return () => {
      courseColorListeners.delete(fn)
    }
  }, [])
  return v
}

/** Build CourseColor tokens from a #rrggbb hue. */
function colorTokensFor(hue: string): CourseColor {
  const r = parseInt(hue.slice(1, 3), 16)
  const g = parseInt(hue.slice(3, 5), 16)
  const b = parseInt(hue.slice(5, 7), 16)
  return {
    hue,
    soft: `rgba(${r},${g},${b},0.13)`,
    border: `rgba(${r},${g},${b},0.40)`
  }
}

/** Deterministic, stable color for a course keyed by courseId (name fallback),
 *  unless the user has chosen an override for that courseId. */
function courseColor(key?: string): CourseColor {
  if (!key) {
    return { hue: '#6d7689', soft: 'rgba(109,118,137,0.12)', border: 'rgba(109,118,137,0.30)' }
  }
  const override = courseColorOverrides.get(key)
  if (override) return colorTokensFor(override)
  let hash = 0
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0
  return colorTokensFor(COURSE_HUES[Math.abs(hash) % COURSE_HUES.length])
}

/** Settings view: pick a color for each class. Persists via setCourseColorOverride. */
function CourseColorsView({ courses }: { courses: CanvasCourse[] }): JSX.Element {
  useCourseColorsVersion()
  return (
    <div className="flex-1 overflow-auto px-4 py-4">
      <SectionHeading count={courses.length || undefined}>Course colors</SectionHeading>
      <p className="mb-3 text-xs leading-relaxed text-txt-3">
        Pick a color for each class — it’s used everywhere that course appears: dots, chips,
        assignment accents, and the calendar overlay.
      </p>
      {courses.length === 0 ? (
        <p className="text-xs text-txt-4">No courses yet — refresh once your Canvas loads.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {courses.map((co, i) => {
            const id = co.id ?? co.name ?? `course-${i}`
            const c = courseColor(co.id ?? co.name)
            const overridden = !!(co.id && courseColorOverrides.has(co.id))
            return (
              <div
                key={id}
                className="flex items-center gap-3 rounded-lg border border-line bg-bg-elevated px-3 py-2.5"
                style={{ borderLeft: `3px solid ${c.hue}` }}
              >
                <span className="h-4 w-4 shrink-0 rounded-full" style={{ backgroundColor: c.hue }} />
                <span className="min-w-0 flex-1 truncate text-sm text-txt-1">{co.name ?? 'Course'}</span>
                {overridden && (
                  <button
                    type="button"
                    onClick={() => co.id && setCourseColorOverride(co.id, null)}
                    className="shrink-0 rounded-md border border-line px-2 py-1 text-[11px] text-txt-3 transition-colors hover:text-txt-1"
                  >
                    Reset
                  </button>
                )}
                <label className="relative shrink-0 cursor-pointer" title="Pick a color">
                  <span
                    className="block h-7 w-7 rounded-md border border-line"
                    style={{ backgroundColor: c.hue }}
                  />
                  <input
                    type="color"
                    value={c.hue}
                    disabled={!co.id}
                    onChange={(e) => co.id && setCourseColorOverride(co.id, e.target.value)}
                    className="absolute inset-0 cursor-pointer opacity-0 disabled:cursor-not-allowed"
                  />
                </label>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
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

/* ── Detail Prev/Next navigation (Canvas-style) ──
 *
 * Steps sequentially through the ordered list the detail item was opened from.
 * Prev is disabled at index 0, Next at the end, with a compact "{n} of {N}".
 */
function DetailNav({
  index,
  total,
  onPrev,
  onNext
}: {
  index: number
  total: number
  onPrev: () => void
  onNext: () => void
}): JSX.Element {
  const atStart = index <= 0
  const atEnd = index >= total - 1
  const btn =
    'grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-line bg-bg-elevated text-txt-3 transition-colors enabled:hover:text-txt-1 disabled:opacity-40 disabled:cursor-default'
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <button
        type="button"
        onClick={onPrev}
        disabled={atStart}
        className={btn}
        aria-label="Previous"
        title="Previous"
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
      <span className="shrink-0 whitespace-nowrap text-[11px] font-medium tabular-nums text-txt-3">
        {index + 1} of {total}
      </span>
      <button
        type="button"
        onClick={onNext}
        disabled={atEnd}
        className={btn}
        aria-label="Next"
        title="Next"
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
          <path d="M9 18l6-6-6-6" />
        </svg>
      </button>
    </div>
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
  // Re-render the whole deck whenever a course-color override changes so every
  // courseColor() call below picks up the new hue.
  useCourseColorsVersion()
  // Canvas-style Prev/Next context for the active detail view (null = no list to
  // step through, e.g. opened from a course header or a single item).
  const [nav, setNav] = useState<NavContext | null>(null)

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

  // Course-scoped lazy caches for reading/discussion features (keyed by courseId).
  const [discussionLists, setDiscussionLists] = useState<
    Record<string, DetailCache<CanvasDiscussion[]>>
  >({})
  const [moduleLists, setModuleLists] = useState<Record<string, DetailCache<CanvasModule[]>>>({})
  const [quizLists, setQuizLists] = useState<Record<string, DetailCache<CanvasQuiz[]>>>({})
  // Discussion threads keyed by `${courseId}/${topicId}`.
  const [discussionThreads, setDiscussionThreads] = useState<
    Record<string, DetailCache<CanvasDiscussionThread>>
  >({})
  // Pages keyed by `${courseId}/${pageUrl}`.
  const [pageDetails, setPageDetails] = useState<Record<string, DetailCache<CanvasPage>>>({})

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
      setDiscussionLists({})
      setModuleLists({})
      setQuizLists({})
      setDiscussionThreads({})
      setPageDetails({})
      setMeta({
        overview: { state: 'ready', error: '' },
        // The Overview agenda is driven by the `assignments` resource — mark it
        // idle so the effect below loads it for the agenda.
        assignments: IDLE_TAB,
        grades: IDLE_TAB,
        announcements: IDLE_TAB
      })
      setView({ type: 'list' })
      setNav(null)
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
    async (courseId: string, assignmentId: string, force = false): Promise<void> => {
      const k = `${courseId}/${assignmentId}`
      setAssignmentDetails((m) => {
        const cur = m[k]
        if (!force && cur && (cur.state === 'ready' || cur.state === 'loading')) return m
        // Preserve existing data while re-fetching so the view doesn't flash.
        return { ...m, [k]: { state: 'loading', error: '', data: cur?.data ?? null } }
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

  /** Lazy-fetch a course's discussions list (cached by courseId). */
  const loadDiscussions = useCallback(
    async (courseId: string, force = false): Promise<void> => {
      setDiscussionLists((m) => {
        const cur = m[courseId]
        if (!force && cur && (cur.state === 'ready' || cur.state === 'loading')) return m
        return { ...m, [courseId]: { state: 'loading', error: '', data: null } }
      })
      try {
        const result = await window.decks?.provider.fetch({
          provider,
          accountId,
          resource: 'discussions',
          params: { courseId }
        })
        const arr = Array.isArray(result) ? (result as CanvasDiscussion[]) : []
        setDiscussionLists((m) => ({ ...m, [courseId]: { state: 'ready', error: '', data: arr } }))
      } catch (err) {
        setDiscussionLists((m) => ({
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

  /** Lazy-fetch a course's modules list (cached by courseId). */
  const loadModules = useCallback(
    async (courseId: string, force = false): Promise<void> => {
      setModuleLists((m) => {
        const cur = m[courseId]
        if (!force && cur && (cur.state === 'ready' || cur.state === 'loading')) return m
        return { ...m, [courseId]: { state: 'loading', error: '', data: null } }
      })
      try {
        const result = await window.decks?.provider.fetch({
          provider,
          accountId,
          resource: 'modules',
          params: { courseId }
        })
        const arr = Array.isArray(result) ? (result as CanvasModule[]) : []
        setModuleLists((m) => ({ ...m, [courseId]: { state: 'ready', error: '', data: arr } }))
      } catch (err) {
        setModuleLists((m) => ({
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

  /** Lazy-fetch a course's quizzes list (cached by courseId). */
  const loadQuizzes = useCallback(
    async (courseId: string, force = false): Promise<void> => {
      setQuizLists((m) => {
        const cur = m[courseId]
        if (!force && cur && (cur.state === 'ready' || cur.state === 'loading')) return m
        return { ...m, [courseId]: { state: 'loading', error: '', data: null } }
      })
      try {
        const result = await window.decks?.provider.fetch({
          provider,
          accountId,
          resource: 'quizzes',
          params: { courseId }
        })
        const arr = Array.isArray(result) ? (result as CanvasQuiz[]) : []
        setQuizLists((m) => ({ ...m, [courseId]: { state: 'ready', error: '', data: arr } }))
      } catch (err) {
        setQuizLists((m) => ({
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

  /** Lazy-fetch a discussion thread (cached by `${courseId}/${topicId}`). */
  const loadDiscussionThread = useCallback(
    async (courseId: string, topicId: string): Promise<void> => {
      const k = `${courseId}/${topicId}`
      setDiscussionThreads((m) => {
        const cur = m[k]
        if (cur && cur.state === 'loading') return m
        return { ...m, [k]: { state: 'loading', error: '', data: null } }
      })
      try {
        const result = (await window.decks?.provider.fetch({
          provider,
          accountId,
          resource: 'discussionView',
          params: { courseId, topicId }
        })) as CanvasDiscussionThread | undefined
        setDiscussionThreads((m) => ({
          ...m,
          [k]: { state: 'ready', error: '', data: result ?? {} }
        }))
      } catch (err) {
        setDiscussionThreads((m) => ({
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

  /** Lazy-fetch a page (cached by `${courseId}/${pageUrl}`). */
  const loadPage = useCallback(
    async (courseId: string, pageUrl: string): Promise<void> => {
      const k = `${courseId}/${pageUrl}`
      setPageDetails((m) => {
        const cur = m[k]
        if (cur && (cur.state === 'ready' || cur.state === 'loading')) return m
        return { ...m, [k]: { state: 'loading', error: '', data: null } }
      })
      try {
        const result = (await window.decks?.provider.fetch({
          provider,
          accountId,
          resource: 'page',
          params: { courseId, pageUrl }
        })) as CanvasPage | undefined
        setPageDetails((m) => ({ ...m, [k]: { state: 'ready', error: '', data: result ?? {} } }))
      } catch (err) {
        setPageDetails((m) => ({
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

  /** Perform a write action against Canvas, then return ok. Throws on failure. */
  const submitAssignment = useCallback(
    async (
      courseId: string,
      assignmentId: string,
      kind: 'text' | 'url',
      value: string
    ): Promise<void> => {
      await window.decks?.provider.fetch({
        provider,
        accountId,
        resource: 'submit',
        params: { courseId, assignmentId, kind, value }
      })
      await loadAssignmentDetail(courseId, assignmentId, true)
    },
    [provider, accountId, loadAssignmentDetail]
  )

  /** Open a native file picker and submit the chosen file. Returns the result. */
  const submitFile = useCallback(
    async (
      courseId: string,
      assignmentId: string
    ): Promise<{ cancelled?: boolean; fileName?: string }> => {
      const result = (await window.decks?.provider.fetch({
        provider,
        accountId,
        resource: 'submitFile',
        params: { courseId, assignmentId }
      })) as { cancelled?: boolean; fileName?: string } | undefined
      const out = result ?? {}
      if (!out.cancelled) await loadAssignmentDetail(courseId, assignmentId, true)
      return out
    },
    [provider, accountId, loadAssignmentDetail]
  )

  /** Add a submission comment to an assignment, then re-fetch it. */
  const addComment = useCallback(
    async (courseId: string, assignmentId: string, text: string): Promise<void> => {
      await window.decks?.provider.fetch({
        provider,
        accountId,
        resource: 'comment',
        params: { courseId, assignmentId, text }
      })
      await loadAssignmentDetail(courseId, assignmentId, true)
    },
    [provider, accountId, loadAssignmentDetail]
  )

  /** Start (or resume) a classic-quiz submission for the given quiz. */
  const quizStart = useCallback(
    async (qCourseId: string, quizId: string): Promise<CanvasQuizStart> => {
      const res = (await window.decks?.provider.fetch({
        provider,
        accountId,
        resource: 'quizStart',
        params: { courseId: qCourseId, quizId }
      })) as CanvasQuizStart | undefined
      if (!res?.submissionId) throw new Error('Could not start this quiz')
      return res
    },
    [provider, accountId]
  )

  /** Fetch the questions for an in-progress quiz submission. */
  const quizQuestions = useCallback(
    async (submissionId: string): Promise<CanvasQuizQuestion[]> => {
      const res = await window.decks?.provider.fetch({
        provider,
        accountId,
        resource: 'quizQuestions',
        params: { submissionId }
      })
      return Array.isArray(res) ? (res as CanvasQuizQuestion[]) : []
    },
    [provider, accountId]
  )

  /** Save one quiz answer (per-type shape handled in main). */
  const quizAnswer = useCallback(
    async (args: {
      submissionId: string
      attempt: number
      validationToken: string
      questionId: string
      questionType?: string
      answer: unknown
    }): Promise<void> => {
      await window.decks?.provider.fetch({
        provider,
        accountId,
        resource: 'quizAnswer',
        params: { ...args }
      })
    },
    [provider, accountId]
  )

  /** Submit (complete) a classic-quiz attempt; returns the graded result. */
  const quizSubmit = useCallback(
    async (args: {
      courseId: string
      quizId: string
      submissionId: string
      attempt: number
      validationToken: string
      assignmentId: string
    }): Promise<CanvasQuizResult> => {
      const { assignmentId, ...rest } = args
      const res = (await window.decks?.provider.fetch({
        provider,
        accountId,
        resource: 'quizSubmit',
        params: { ...rest }
      })) as CanvasQuizResult | undefined
      // Refresh the assignment so its submission state/score update.
      await loadAssignmentDetail(args.courseId, assignmentId, true)
      return res ?? { ok: true }
    },
    [provider, accountId, loadAssignmentDetail]
  )

  /** Post a discussion reply (top-level or nested), then re-fetch the thread. */
  const postReply = useCallback(
    async (
      courseId: string,
      topicId: string,
      message: string,
      parentEntryId?: string
    ): Promise<void> => {
      await window.decks?.provider.fetch({
        provider,
        accountId,
        resource: 'postReply',
        params: { courseId, topicId, message, parentEntryId }
      })
      await loadDiscussionThread(courseId, topicId)
    },
    [provider, accountId, loadDiscussionThread]
  )

  /** Toggle a module item's completion requirement, then re-fetch modules. */
  const markModuleItem = useCallback(
    async (courseId: string, moduleId: string, itemId: string, done: boolean): Promise<void> => {
      await window.decks?.provider.fetch({
        provider,
        accountId,
        resource: 'markModuleItem',
        params: { courseId, moduleId, itemId, done }
      })
      await loadModules(courseId, true)
    },
    [provider, accountId, loadModules]
  )

  /** Navigate into a discussions list for a course. */
  const openDiscussions = useCallback(
    (courseId: string): void => {
      setView({ type: 'discussions', courseId })
      setNav(null)
      void loadDiscussions(courseId)
    },
    [loadDiscussions]
  )

  /**
   * Navigate into a single discussion thread. `nextNav` (optional) captures the
   * ordered sibling list + index so Prev/Next can step through it.
   */
  const openDiscussion = useCallback(
    (courseId: string, topicId?: string, nextNav?: NavContext | null): void => {
      if (!topicId) return
      setView({ type: 'discussion', courseId, topicId })
      setNav(nextNav ?? null)
      void loadDiscussionThread(courseId, topicId)
    },
    [loadDiscussionThread]
  )

  /** Navigate into a single page. `nextNav` (optional) drives Prev/Next stepping. */
  const openPage = useCallback(
    (courseId: string, pageUrl?: string, nextNav?: NavContext | null): void => {
      if (!pageUrl) return
      setView({ type: 'page', courseId, pageUrl })
      setNav(nextNav ?? null)
      void loadPage(courseId, pageUrl)
    },
    [loadPage]
  )

  /** Navigate into a course detail (also loads its assignments/announcements). */
  const openCourse = useCallback(
    (courseId?: string): void => {
      if (!courseId) return
      setView({ type: 'course', courseId })
      setNav(null)
      void loadCourseDetail(courseId)
      void loadDiscussions(courseId)
      void loadModules(courseId)
      void loadQuizzes(courseId)
      if (meta.assignments.state === 'idle') void loadTab('assignments')
      if (meta.announcements.state === 'idle') void loadTab('announcements')
    },
    [
      loadCourseDetail,
      loadDiscussions,
      loadModules,
      loadQuizzes,
      loadTab,
      meta.assignments.state,
      meta.announcements.state
    ]
  )

  /**
   * Navigate into an assignment detail. `nextNav` (optional) captures the ordered
   * sibling list + index it was opened from so Prev/Next can step through it.
   */
  const openAssignment = useCallback(
    (courseId?: string, assignmentId?: string, nextNav?: NavContext | null): void => {
      if (!courseId || !assignmentId) return
      setView({ type: 'assignment', courseId, assignmentId })
      setNav(nextNav ?? null)
      void loadAssignmentDetail(courseId, assignmentId)
    },
    [loadAssignmentDetail]
  )

  // Cross-deck: when the Calendar deck requests an assignment, open it here.
  // IMPORTANT: wait until the initial load() has finished (state === 'ready').
  // load() resets the view to 'list' when it completes, so consuming the request
  // earlier would open the assignment and then immediately get clobbered back to
  // the home list — which is exactly the "took me to the Canvas home page" bug.
  const pendingCanvasAction = useStore((s) => s.pendingCanvasAction)
  const clearCanvasAction = useStore((s) => s.clearCanvasAction)
  useEffect(() => {
    if (!pendingCanvasAction || state !== 'ready') return
    openAssignment(pendingCanvasAction.courseId, pendingCanvasAction.assignmentId)
    clearCanvasAction()
  }, [pendingCanvasAction, state, openAssignment, clearCanvasAction])

  /** Back from a detail view → its logical parent (course/discussions/list). */
  const back = useCallback((): void => {
    setNav(null)
    setView((v) => {
      if (v.type === 'discussion') return { type: 'discussions', courseId: v.courseId }
      if (v.type === 'discussions') return { type: 'course', courseId: v.courseId }
      if (v.type === 'page') return { type: 'course', courseId: v.courseId }
      return { type: 'list' }
    })
  }, [])

  /**
   * Step the active detail view to the adjacent sibling (Canvas-style Prev/Next).
   * Reuses the existing open* handlers with the SAME nav context at the new index,
   * so the lazy fetch + view swap happen exactly as a normal click would.
   */
  const stepNav = useCallback(
    (delta: -1 | 1): void => {
      if (!nav) return
      const next = nav.index + delta
      if (next < 0 || next >= nav.items.length) return
      const target = nav.items[next]
      if (!target) return
      const movedNav: NavContext = { ...nav, index: next }
      if (nav.kind === 'assignment') openAssignment(target.courseId, target.id, movedNav)
      else if (nav.kind === 'discussion') openDiscussion(target.courseId, target.id, movedNav)
      else if (nav.kind === 'page') openPage(target.courseId, target.id, movedNav)
    },
    [nav, openAssignment, openDiscussion, openPage]
  )

  /** Refresh: reload current view/tab (overview reloads everything). */
  const refresh = useCallback((): void => {
    if (view.type === 'assignment') {
      void loadAssignmentDetail(view.courseId, view.assignmentId)
      return
    }
    if (view.type === 'course') {
      void loadCourseDetail(view.courseId)
      void loadDiscussions(view.courseId, true)
      void loadModules(view.courseId, true)
      void loadQuizzes(view.courseId, true)
      void loadTab('assignments', true)
      void loadTab('announcements', true)
      return
    }
    if (view.type === 'discussions') {
      void loadDiscussions(view.courseId, true)
      return
    }
    if (view.type === 'discussion') {
      void loadDiscussionThread(view.courseId, view.topicId)
      return
    }
    if (view.type === 'page') {
      void loadPage(view.courseId, view.pageUrl)
      return
    }
    if (tab === 'overview') void load()
    else if (tab === 'assignments' || tab === 'grades' || tab === 'announcements')
      void loadTab(tab, true)
  }, [
    view,
    tab,
    load,
    loadTab,
    loadCourseDetail,
    loadAssignmentDetail,
    loadDiscussions,
    loadModules,
    loadQuizzes,
    loadDiscussionThread,
    loadPage
  ])

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
          {inDetail && nav && nav.items.length > 1 && (
            <DetailNav
              index={nav.index}
              total={nav.items.length}
              onPrev={() => stepNav(-1)}
              onNext={() => stepNav(1)}
            />
          )}
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
          <button
            onClick={() => setView({ type: 'settings' })}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-line bg-bg-elevated text-txt-3 transition-colors hover:text-txt-1"
            aria-label="Course colors & settings"
            title="Course colors"
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
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
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
          discussions={discussionLists[view.courseId]}
          modules={moduleLists[view.courseId]}
          quizzes={quizLists[view.courseId]}
          courseName={courseName}
          onOpenAssignment={openAssignment}
          onOpenDiscussions={openDiscussions}
          onOpenDiscussion={openDiscussion}
          onOpenPage={openPage}
          onMarkModuleItem={markModuleItem}
        />
      ) : view.type === 'assignment' ? (
        <AssignmentDetailView
          detail={assignmentDetails[`${view.courseId}/${view.assignmentId}`]}
          courseId={view.courseId}
          assignmentId={view.assignmentId}
          courseName={courseName}
          onOpenCourse={openCourse}
          onSubmit={submitAssignment}
          onSubmitFile={submitFile}
          onAddComment={addComment}
          onQuizStart={quizStart}
          onQuizQuestions={quizQuestions}
          onQuizAnswer={quizAnswer}
          onQuizSubmit={quizSubmit}
        />
      ) : view.type === 'discussions' ? (
        <DiscussionsView
          list={discussionLists[view.courseId]}
          courseId={view.courseId}
          courseName={courseName}
          onOpenDiscussion={openDiscussion}
        />
      ) : view.type === 'discussion' ? (
        <DiscussionThreadView
          thread={discussionThreads[`${view.courseId}/${view.topicId}`]}
          courseId={view.courseId}
          topicId={view.topicId}
          courseName={courseName}
          onPostReply={postReply}
        />
      ) : view.type === 'page' ? (
        <PageView
          page={pageDetails[`${view.courseId}/${view.pageUrl}`]}
          courseId={view.courseId}
          courseName={courseName}
        />
      ) : view.type === 'settings' ? (
        <CourseColorsView courses={data.courses} />
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

/**
 * Build an assignment nav context (ordered courseId/id pairs + the clicked
 * index) from a display-ordered list, for Canvas-style Prev/Next. Returns null
 * when there's nothing to step through.
 */
function assignmentNav(ordered: CanvasAssignment[], a: CanvasAssignment): NavContext | null {
  const items: NavItem[] = ordered
    .filter((x) => x.courseId && x.id)
    .map((x) => ({ courseId: x.courseId!, id: x.id! }))
  if (items.length < 2) return null
  const index = items.findIndex((x) => x.courseId === a.courseId && x.id === a.id)
  if (index < 0) return null
  return { kind: 'assignment', items, index }
}

/**
 * Build a discussion nav context from a display-ordered topic list (all in the
 * same course). Returns null when there's nothing to step through.
 */
function discussionNav(
  ordered: CanvasDiscussion[],
  courseId: string,
  t: CanvasDiscussion
): NavContext | null {
  const items: NavItem[] = ordered.filter((x) => x.id).map((x) => ({ courseId, id: x.id! }))
  if (items.length < 2) return null
  const index = items.findIndex((x) => x.id === t.id)
  if (index < 0) return null
  return { kind: 'discussion', items, index }
}

/** An agenda assignment row (course-colored, missing-aware, → assignment detail). */
function AgendaAssignmentRow({
  a,
  label,
  nav,
  onOpenAssignment
}: {
  a: CanvasAssignment
  label?: string
  /** Ordered sibling list this row belongs to, for Prev/Next stepping. */
  nav?: NavContext | null
  onOpenAssignment: (
    courseId?: string,
    assignmentId?: string,
    nav?: NavContext | null
  ) => void
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
      onClick={() => onOpenAssignment(a.courseId, a.id, nav ?? null)}
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
  onOpenAssignment: (
    courseId?: string,
    assignmentId?: string,
    nav?: NavContext | null
  ) => void
}): JSX.Element {
  const todayRef = useRef<HTMLDivElement | null>(null)
  const { dated, undated } = groupAgendaByDay(assignments)
  const todayKey = dayKey(new Date())
  // Flattened agenda display order (dated groups oldest→newest, then undated) —
  // the list Prev/Next steps through when an agenda item is opened.
  const agendaOrder = useMemo(
    () => [...dated.flatMap((g) => g.items), ...undated],
    [dated, undated]
  )

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
                        nav={assignmentNav(agendaOrder, a)}
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
                      nav={assignmentNav(agendaOrder, a)}
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
  onOpenAssignment: (
    courseId?: string,
    assignmentId?: string,
    nav?: NavContext | null
  ) => void
}): JSX.Element {
  if (meta.state === 'loading' || meta.state === 'idle')
    return <TabStatus kind="loading" message="Loading assignments…" />
  if (meta.state === 'error') return <TabStatus kind="error" message={meta.error} />
  if (items.length === 0)
    return <TabStatus kind="empty" message="No assignments found." />

  return <AssignmentsTabBody items={items} courseName={courseName} onOpenAssignment={onOpenAssignment} />
}

/** Body of the Assignments tab: due-bucket sections + a jump-to TOC side rail. */
function AssignmentsTabBody({
  items,
  courseName,
  onOpenAssignment
}: {
  items: CanvasAssignment[]
  courseName: (id?: string) => string | undefined
  onOpenAssignment: (courseId?: string, assignmentId?: string, nav?: NavContext | null) => void
}): JSX.Element {
  // Group into due buckets (items arrive pre-sorted by due date from main).
  const grouped = new Map<DueBucket, CanvasAssignment[]>()
  for (const a of items) {
    const b = dueBucket(a)
    const arr = grouped.get(b)
    if (arr) arr.push(a)
    else grouped.set(b, [a])
  }
  // Flattened display order across buckets — the list Prev/Next steps through.
  const order = DUE_BUCKETS.flatMap(({ key }) => grouped.get(key) ?? [])

  // Jump-to TOC — only the buckets that actually have items.
  const rootRef = useRef<HTMLDivElement | null>(null)
  const present = DUE_BUCKETS.filter(({ key }) => (grouped.get(key)?.length ?? 0) > 0)
  const scrollToToc = (key: string): void => {
    rootRef.current
      ?.querySelector(`[data-toc="bucket-${key}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div className="flex gap-3">
      <aside className="sticky top-0 hidden w-40 shrink-0 self-start md:block">
        <div className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-txt-4">
          Jump to
        </div>
        {present.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => scrollToToc(key)}
            className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs text-txt-2 transition-colors hover:bg-bg-elevated hover:text-txt-1"
          >
            <span className="truncate">{label}</span>
            <span className="shrink-0 text-[10px] tabular-nums text-txt-4">
              {grouped.get(key)?.length}
            </span>
          </button>
        ))}
      </aside>

      <div ref={rootRef} className="flex min-w-0 flex-1 flex-col gap-5">
        {DUE_BUCKETS.map(({ key, label, tone }) => {
          const group = grouped.get(key)
          if (!group || group.length === 0) return null
          return (
            <section key={key} data-toc={`bucket-${key}`} className="scroll-mt-2">
              <SectionHeading count={group.length} tone={tone}>
                {label}
              </SectionHeading>
              <div className="flex flex-col gap-2">
                {group.map((a, i) => (
                  <AgendaAssignmentRow
                    key={a.id ?? `${a.name ?? 'a'}-${i}`}
                    a={a}
                    label={a.courseName ?? courseName(a.courseId)}
                    nav={assignmentNav(order, a)}
                    onOpenAssignment={onOpenAssignment}
                  />
                ))}
              </div>
            </section>
          )
        })}
      </div>
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

/* ── Attachments / embedded files section ──
 *
 * Lists each file/video with a type icon + name and a single "View" action that
 * ALWAYS opens the item in a new embedded WEB deck (a WebContentsView — its own
 * sandboxed process). We deliberately NEVER embed files inline in this renderer:
 * loading a remote file into an <iframe>/<embed>/<video>/<audio> inside the app's
 * own renderer can crash that renderer (and reload the whole app). The embedded
 * web deck has native viewers for PDF/image/video/audio/text and isolates any
 * crash from the app. "View" targets per type:
 *  - pdf / image / video / audio / text / embedded media → the direct Canvas
 *    (verifier) url, or the media embed url (Studio/YouTube/Vimeo iframes play
 *    there).
 *  - office (Word/Excel/PowerPoint/OpenDocument) → the Microsoft Office Online
 *    viewer url (Canvas verifier urls are publicly reachable).
 *  - anything else → the direct url (view/download).
 */

/** A small type glyph for an attachment (image/pdf/video/audio/office/file). */
function FileIcon({ kind }: { kind: FileKind }): JSX.Element {
  if (kind === 'image') {
    return (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <path d="m21 15-5-5L5 21" />
      </svg>
    )
  }
  if (kind === 'video') {
    return (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="5" width="14" height="14" rx="2" />
        <path d="m16 9 6-3v12l-6-3z" />
      </svg>
    )
  }
  if (kind === 'audio') {
    return (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 18V5l12-2v13" />
        <circle cx="6" cy="18" r="3" />
        <circle cx="18" cy="16" r="3" />
      </svg>
    )
  }
  // pdf / office / other → a document glyph (office gets a tint via text color).
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  )
}

/** One attachment row with a type icon, name/size, and a "View" action. */
function AttachmentRow({ att }: { att: CanvasAttachment }): JSX.Element {
  const kind = fileKind(att)
  const name = att.displayName ?? att.fileName ?? (att.isMedia ? 'Video' : 'File')
  const url = att.url
  const size = formatSize(att.sizeBytes)

  // Every attachment opens in a NEW embedded web deck — we never embed files in
  // this renderer (an inline <iframe>/<embed>/<video> can crash it). Office docs
  // go through the Office Online viewer; everything else (PDF/image/video/audio/
  // text/embedded media/other) opens its direct/embed url, which the embedded
  // browser renders with its native viewers / media player.
  const openInWebDeck = useCallback((): void => {
    if (!url) return
    if (kind === 'office') addWebDeck(officeViewerUrl(url), name)
    else addWebDeck(url, name)
  }, [url, kind, name])

  // Label: media/video → its kind; office → "office"; other → "file".
  const typeLabel = att.isMedia ? 'video' : kind === 'other' ? 'file' : kind

  return (
    <div className="rounded-lg border border-line bg-bg-elevated">
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <span
          className={`shrink-0 ${kind === 'office' ? 'text-accent' : att.isMedia ? 'text-warn' : 'text-txt-3'}`}
        >
          <FileIcon kind={kind} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-txt-1">{name}</div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-txt-4">
            <span className="uppercase">{typeLabel}</span>
            {size && <span>· {size}</span>}
          </div>
        </div>
        <button
          type="button"
          onClick={openInWebDeck}
          disabled={!url}
          className="shrink-0 rounded-md border border-accent-ring px-2.5 py-1 text-[11px] font-semibold text-accent transition-colors hover:bg-accent/10 disabled:opacity-50"
        >
          {att.isMedia ? 'Play' : 'View'}
        </button>
      </div>
    </div>
  )
}

/** "Attachments" / "Files" section listing every viewable attachment. */
function AttachmentsSection({
  attachments,
  title = 'Attachments'
}: {
  attachments?: CanvasAttachment[]
  title?: string
}): JSX.Element | null {
  const list = (attachments ?? []).filter((a) => a.url || a.id)
  if (list.length === 0) return null
  return (
    <div className="mt-5">
      <SectionHeading count={list.length}>{title}</SectionHeading>
      <div className="flex flex-col gap-2">
        {list.map((a, i) => (
          <AttachmentRow key={a.id ?? a.url ?? `att-${i}`} att={a} />
        ))}
      </div>
    </div>
  )
}

/** Quiz-taking callbacks threaded down to the in-app classic-quiz take flow. */
interface QuizActions {
  onQuizStart: (courseId: string, quizId: string) => Promise<CanvasQuizStart>
  onQuizQuestions: (submissionId: string) => Promise<CanvasQuizQuestion[]>
  onQuizAnswer: (args: {
    submissionId: string
    attempt: number
    validationToken: string
    questionId: string
    questionType?: string
    answer: unknown
  }) => Promise<void>
  onQuizSubmit: (args: {
    courseId: string
    quizId: string
    submissionId: string
    attempt: number
    validationToken: string
    assignmentId: string
  }) => Promise<CanvasQuizResult>
}

function AssignmentDetailView({
  detail,
  courseId,
  assignmentId,
  courseName,
  onOpenCourse,
  onSubmit,
  onSubmitFile,
  onAddComment,
  onQuizStart,
  onQuizQuestions,
  onQuizAnswer,
  onQuizSubmit
}: {
  detail?: DetailCache<CanvasAssignmentDetail>
  courseId: string
  assignmentId: string
  courseName: (id?: string) => string | undefined
  onOpenCourse: (courseId?: string) => void
  onSubmit: (
    courseId: string,
    assignmentId: string,
    kind: 'text' | 'url',
    value: string
  ) => Promise<void>
  onSubmitFile: (
    courseId: string,
    assignmentId: string
  ) => Promise<{ cancelled?: boolean; fileName?: string }>
  onAddComment: (courseId: string, assignmentId: string, text: string) => Promise<void>
} & QuizActions): JSX.Element {
  // Show the spinner only on the very first load (no data yet); re-fetches after
  // an action keep the previous data visible while loading.
  if (detail && detail.state === 'loading' && !detail.data) {
    return (
      <div className="flex-1 overflow-auto px-4 py-4">
        <TabStatus kind="loading" message="Loading assignment…" />
      </div>
    )
  }
  if (!detail || detail.state === 'idle') {
    return (
      <div className="flex-1 overflow-auto px-4 py-4">
        <TabStatus kind="loading" message="Loading assignment…" />
      </div>
    )
  }
  if (detail.state === 'error' && !detail.data) {
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
  const hasDescription = !!a.description && a.description.trim().length > 0
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

      {/* Description — rendered as Canvas-style rich text (safe, no innerHTML) */}
      <div className="mt-4">
        <SectionHeading>Description</SectionHeading>
        {hasDescription ? (
          <RichHtml html={a.description} className="text-xs leading-relaxed text-txt-2" />
        ) : (
          <p className="text-xs text-txt-4">No description.</p>
        )}
      </div>

      {/* Attachments / embedded files */}
      <AttachmentsSection attachments={a.attachments} />

      {/* Submit section (driven by submissionTypes) */}
      <div className="mt-5">
        <SectionHeading tone="accent">Submit</SectionHeading>
        <SubmitSection
          courseId={courseId}
          assignmentId={assignmentId}
          submissionTypes={a.submissionTypes}
          allowedAttempts={a.allowedAttempts}
          htmlUrl={a.htmlUrl}
          quizId={a.quizId}
          quizType={a.quizType}
          timeLimit={a.timeLimit}
          pointsPossible={a.pointsPossible}
          onSubmit={onSubmit}
          onSubmitFile={onSubmitFile}
          onQuizStart={onQuizStart}
          onQuizQuestions={onQuizQuestions}
          onQuizAnswer={onQuizAnswer}
          onQuizSubmit={onQuizSubmit}
        />
      </div>

      {/* Comments */}
      <div className="mt-5">
        <CommentsSection
          courseId={courseId}
          assignmentId={assignmentId}
          comments={a.comments}
          onAddComment={onAddComment}
        />
      </div>

      <div className="mt-5">
        <OpenInCanvasLink url={a.htmlUrl} />
      </div>
    </div>
  )
}

/* ── Assignment submission ──
 *
 * Renders a submission control per allowed type (text / url / upload). Real
 * submissions use a 2-step confirm. After a successful action the parent
 * re-fetches the assignment so status/score update.
 */

/** True if `types` contains an upload/text/url submission type. */
function hasType(types: string[] | undefined, name: string): boolean {
  return Array.isArray(types) && types.includes(name)
}

/**
 * Classic-quiz engine types we can take in-app via the quiz-submissions API.
 * Anything else (esp. New Quizzes, which report no/`'quizzes.next'` type and
 * have no public take API) falls back to "Open in Canvas".
 */
const CLASSIC_QUIZ_TYPES = new Set([
  'assignment',
  'practice_quiz',
  'graded_survey',
  'survey'
])

function isClassicQuiz(quizType?: string): boolean {
  return typeof quizType === 'string' && CLASSIC_QUIZ_TYPES.has(quizType)
}

function SubmitSection({
  courseId,
  assignmentId,
  submissionTypes,
  allowedAttempts,
  htmlUrl,
  quizId,
  quizType,
  timeLimit,
  pointsPossible,
  onSubmit,
  onSubmitFile,
  onQuizStart,
  onQuizQuestions,
  onQuizAnswer,
  onQuizSubmit
}: {
  courseId: string
  assignmentId: string
  submissionTypes?: string[]
  allowedAttempts?: number
  htmlUrl?: string
  quizId?: string
  quizType?: string
  timeLimit?: number
  pointsPossible?: number
  onSubmit: (
    courseId: string,
    assignmentId: string,
    kind: 'text' | 'url',
    value: string
  ) => Promise<void>
  onSubmitFile: (
    courseId: string,
    assignmentId: string
  ) => Promise<{ cancelled?: boolean; fileName?: string }>
} & QuizActions): JSX.Element {
  const allowsText = hasType(submissionTypes, 'online_text_entry')
  const allowsUrl = hasType(submissionTypes, 'online_url')
  const allowsUpload = hasType(submissionTypes, 'online_upload')
  const isQuiz = hasType(submissionTypes, 'online_quiz')
  const isExternalTool = hasType(submissionTypes, 'external_tool')
  const isDiscussion = hasType(submissionTypes, 'discussion_topic')
  const anyOnline = allowsText || allowsUrl || allowsUpload

  const [text, setText] = useState('')
  const [url, setUrl] = useState('')
  // Per-control 2-step confirm + busy + result state.
  const [confirm, setConfirm] = useState<'text' | 'url' | 'file' | null>(null)
  const [busy, setBusy] = useState<'text' | 'url' | 'file' | null>(null)
  const [error, setError] = useState('')
  const [done, setDone] = useState('')
  const [fileName, setFileName] = useState('')

  const run = useCallback(
    async (which: 'text' | 'url' | 'file'): Promise<void> => {
      setError('')
      setDone('')
      setBusy(which)
      try {
        if (which === 'text') {
          await onSubmit(courseId, assignmentId, 'text', text)
          setDone('Text submitted.')
          setText('')
        } else if (which === 'url') {
          await onSubmit(courseId, assignmentId, 'url', url)
          setDone('Link submitted.')
          setUrl('')
        } else {
          const res = await onSubmitFile(courseId, assignmentId)
          if (res.cancelled) {
            setBusy(null)
            setConfirm(null)
            return
          }
          setFileName(res.fileName ?? '')
          setDone(res.fileName ? `Submitted ${res.fileName}.` : 'File submitted.')
        }
        setConfirm(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Submission failed.')
      } finally {
        setBusy(null)
      }
    },
    [courseId, assignmentId, text, url, onSubmit, onSubmitFile]
  )

  // A quiz. CLASSIC quizzes (assignment/practice_quiz/graded_survey/survey) get a
  // real in-app take flow via the quiz-submissions API. New Quizzes and anything
  // else have no public take API → keep the "Take it in Canvas" fallback.
  if (isQuiz) {
    if (quizId && isClassicQuiz(quizType)) {
      return (
        <QuizTakeSection
          courseId={courseId}
          assignmentId={assignmentId}
          quizId={quizId}
          allowedAttempts={allowedAttempts}
          timeLimit={timeLimit}
          pointsPossible={pointsPossible}
          htmlUrl={htmlUrl}
          onQuizStart={onQuizStart}
          onQuizQuestions={onQuizQuestions}
          onQuizAnswer={onQuizAnswer}
          onQuizSubmit={onQuizSubmit}
        />
      )
    }
    return (
      <div className="rounded-lg border px-3 py-3" style={{ borderColor: 'var(--accent-ring)', background: 'var(--accent-soft)' }}>
        <div className="flex items-center gap-2 text-xs font-semibold text-accent">
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 11l3 3L22 4" />
            <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
          </svg>
          Quiz
        </div>
        <p className="mt-1.5 text-xs leading-relaxed text-txt-2">
          This is a Canvas quiz
          {typeof allowedAttempts === 'number' && allowedAttempts > 0
            ? ` · ${allowedAttempts} attempt${allowedAttempts === 1 ? '' : 's'}`
            : ''}
          . Take it in Canvas — this quiz type can’t be taken in-app.
        </p>
        <button
          type="button"
          onClick={() => openExternal(htmlUrl)}
          disabled={!htmlUrl}
          className="mt-2.5 inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-[#04222b] transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          Take quiz in Canvas
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M7 17 17 7M9 7h8v8" />
          </svg>
        </button>
      </div>
    )
  }

  if (!anyOnline) {
    const note = isExternalTool
      ? 'This assignment uses an external tool.'
      : isDiscussion
        ? 'This assignment is a graded discussion — reply from the Discussions tab.'
        : 'This assignment is submitted outside Decks (on paper or no online submission).'
    return (
      <div className="rounded-lg border border-line bg-bg-elevated px-3 py-2.5">
        <p className="text-xs text-txt-3">{note}</p>
        <div className="mt-2">
          <OpenInCanvasLink url={htmlUrl} />
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {typeof allowedAttempts === 'number' && allowedAttempts > 0 && (
        <p className="text-[11px] text-txt-4">
          {allowedAttempts} attempt{allowedAttempts === 1 ? '' : 's'} allowed
        </p>
      )}

      {allowsText && (
        <div className="rounded-lg border border-line bg-bg-elevated p-3">
          <label className="mb-1.5 block text-[11px] font-medium text-txt-3">Text entry</label>
          <textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              if (confirm === 'text') setConfirm(null)
            }}
            rows={4}
            placeholder="Type your submission…"
            disabled={busy !== null}
            className="w-full resize-y rounded-md border border-line bg-bg px-2.5 py-2 text-xs text-txt-1 placeholder:text-txt-4 focus:border-accent-ring focus:outline-none disabled:opacity-60"
          />
          <div className="mt-2 flex items-center justify-end gap-2">
            {confirm === 'text' && (
              <button
                type="button"
                onClick={() => setConfirm(null)}
                disabled={busy !== null}
                className="rounded-md px-2.5 py-1.5 text-xs font-medium text-txt-3 transition-colors hover:text-txt-1"
              >
                Cancel
              </button>
            )}
            <button
              type="button"
              disabled={busy !== null || text.trim().length === 0}
              onClick={() => (confirm === 'text' ? void run('text') : setConfirm('text'))}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-50 ${
                confirm === 'text'
                  ? 'bg-accent text-bg hover:brightness-110'
                  : 'border border-accent-ring text-accent hover:bg-accent/10'
              }`}
            >
              {busy === 'text' && <Spinner />}
              {confirm === 'text' ? 'Confirm submit' : 'Submit text'}
            </button>
          </div>
        </div>
      )}

      {allowsUrl && (
        <div className="rounded-lg border border-line bg-bg-elevated p-3">
          <label className="mb-1.5 block text-[11px] font-medium text-txt-3">Website URL</label>
          <input
            type="url"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value)
              if (confirm === 'url') setConfirm(null)
            }}
            placeholder="https://…"
            disabled={busy !== null}
            className="w-full rounded-md border border-line bg-bg px-2.5 py-2 text-xs text-txt-1 placeholder:text-txt-4 focus:border-accent-ring focus:outline-none disabled:opacity-60"
          />
          <div className="mt-2 flex items-center justify-end gap-2">
            {confirm === 'url' && (
              <button
                type="button"
                onClick={() => setConfirm(null)}
                disabled={busy !== null}
                className="rounded-md px-2.5 py-1.5 text-xs font-medium text-txt-3 transition-colors hover:text-txt-1"
              >
                Cancel
              </button>
            )}
            <button
              type="button"
              disabled={busy !== null || url.trim().length === 0}
              onClick={() => (confirm === 'url' ? void run('url') : setConfirm('url'))}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-50 ${
                confirm === 'url'
                  ? 'bg-accent text-bg hover:brightness-110'
                  : 'border border-accent-ring text-accent hover:bg-accent/10'
              }`}
            >
              {busy === 'url' && <Spinner />}
              {confirm === 'url' ? 'Confirm submit' : 'Submit link'}
            </button>
          </div>
        </div>
      )}

      {allowsUpload && (
        <div className="rounded-lg border border-line bg-bg-elevated p-3">
          <label className="mb-1.5 block text-[11px] font-medium text-txt-3">File upload</label>
          {fileName && <p className="mb-2 text-xs text-txt-2">Selected: {fileName}</p>}
          <div className="flex items-center justify-end gap-2">
            {confirm === 'file' && (
              <button
                type="button"
                onClick={() => setConfirm(null)}
                disabled={busy !== null}
                className="rounded-md px-2.5 py-1.5 text-xs font-medium text-txt-3 transition-colors hover:text-txt-1"
              >
                Cancel
              </button>
            )}
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => (confirm === 'file' ? void run('file') : setConfirm('file'))}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-50 ${
                confirm === 'file'
                  ? 'bg-accent text-bg hover:brightness-110'
                  : 'border border-accent-ring text-accent hover:bg-accent/10'
              }`}
            >
              {busy === 'file' && <Spinner />}
              {confirm === 'file' ? 'Confirm: pick file & submit' : 'Attach a file & submit'}
            </button>
          </div>
        </div>
      )}

      {done && <p className="text-xs font-medium text-ok">{done}</p>}
      {error && <p className="text-xs text-err">{error}</p>}
    </div>
  )
}

/* ── Classic quiz: in-app take flow ──
 *
 * For CLASSIC Canvas quizzes only (assignment/practice_quiz/graded_survey/survey).
 * Phases: intro → taking → done.
 *  - intro  : title meta + Start button → POST a submission, GET its questions.
 *  - taking : one card per question with the right input per type; answers save
 *             as the user goes (text/number debounced, choices on change), then a
 *             confirm-gated Submit → POST .../complete.
 *  - done   : the graded score/result.
 * Any API failure shows the error AND keeps the "Open in Canvas" escape hatch.
 */

type QuizPhase = 'intro' | 'taking' | 'done'

function QuizTakeSection({
  courseId,
  assignmentId,
  quizId,
  allowedAttempts,
  timeLimit,
  pointsPossible,
  htmlUrl,
  onQuizStart,
  onQuizQuestions,
  onQuizAnswer,
  onQuizSubmit
}: {
  courseId: string
  assignmentId: string
  quizId: string
  allowedAttempts?: number
  timeLimit?: number
  pointsPossible?: number
  htmlUrl?: string
} & QuizActions): JSX.Element {
  const [phase, setPhase] = useState<QuizPhase>('intro')
  const [starting, setStarting] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [confirmSubmit, setConfirmSubmit] = useState(false)
  const [error, setError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [start, setStart] = useState<CanvasQuizStart | null>(null)
  const [questions, setQuestions] = useState<CanvasQuizQuestion[]>([])
  const [result, setResult] = useState<CanvasQuizResult | null>(null)

  // Persist one save() so question cards can call it without re-renders churning.
  const saveAnswer = useCallback(
    async (q: CanvasQuizQuestion, answer: unknown): Promise<void> => {
      if (!start || !q.id) return
      setSaveError('')
      try {
        await onQuizAnswer({
          submissionId: start.submissionId,
          attempt: start.attempt,
          validationToken: start.validationToken,
          questionId: q.id,
          questionType: q.type,
          answer
        })
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : 'Could not save that answer.')
      }
    },
    [start, onQuizAnswer]
  )

  const begin = useCallback(async (): Promise<void> => {
    setError('')
    setStarting(true)
    try {
      const s = await onQuizStart(courseId, quizId)
      setStart(s)
      const qs = await onQuizQuestions(s.submissionId)
      setQuestions(qs)
      setPhase('taking')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start this quiz.')
    } finally {
      setStarting(false)
    }
  }, [courseId, quizId, onQuizStart, onQuizQuestions])

  const finish = useCallback(async (): Promise<void> => {
    if (!start) return
    setError('')
    setSubmitting(true)
    try {
      const res = await onQuizSubmit({
        courseId,
        quizId,
        submissionId: start.submissionId,
        attempt: start.attempt,
        validationToken: start.validationToken,
        assignmentId
      })
      setResult(res)
      setPhase('done')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not submit this quiz.')
    } finally {
      setSubmitting(false)
      setConfirmSubmit(false)
    }
  }, [start, courseId, quizId, assignmentId, onQuizSubmit])

  // ── Done: graded result ──
  if (phase === 'done') {
    const score = result?.score ?? result?.keptScore
    return (
      <div className="rounded-lg border border-line bg-bg-elevated px-3 py-3">
        <div className="flex items-center gap-2 text-xs font-semibold text-ok">
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6 9 17l-5-5" />
          </svg>
          Quiz submitted
        </div>
        <p className="mt-2 text-sm font-semibold text-txt-1">
          {typeof score === 'number'
            ? `Score: ${score}${typeof pointsPossible === 'number' ? ` / ${pointsPossible}` : ''} pts`
            : 'Your attempt was submitted.'}
        </p>
        {result?.workflowState && (
          <p className="mt-1 text-[11px] capitalize text-txt-4">
            {result.workflowState.replace(/_/g, ' ')}
          </p>
        )}
        {typeof score !== 'number' && (
          <p className="mt-1 text-[11px] text-txt-4">
            Some questions may need manual grading — check Canvas for the final score.
          </p>
        )}
        <div className="mt-3">
          <OpenInCanvasLink url={htmlUrl} />
        </div>
      </div>
    )
  }

  // ── Intro ──
  if (phase === 'intro') {
    return (
      <div className="rounded-lg border px-3 py-3" style={{ borderColor: 'var(--accent-ring)', background: 'var(--accent-soft)' }}>
        <div className="flex items-center gap-2 text-xs font-semibold text-accent">
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 11l3 3L22 4" />
            <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
          </svg>
          Quiz
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-txt-3">
          {typeof pointsPossible === 'number' && <span>{pointsPossible} pts</span>}
          {typeof allowedAttempts === 'number' && allowedAttempts > 0 && (
            <span>· {allowedAttempts} attempt{allowedAttempts === 1 ? '' : 's'}</span>
          )}
          {typeof timeLimit === 'number' && timeLimit > 0 && (
            <span>· {timeLimit} min limit</span>
          )}
        </div>
        <p className="mt-1.5 text-xs leading-relaxed text-txt-2">
          Take this quiz right here. Your answers save as you go, then submit to
          record your attempt in Canvas.
        </p>
        <div className="mt-2.5 flex items-center gap-3">
          <button
            type="button"
            onClick={() => void begin()}
            disabled={starting}
            className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-[#04222b] transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {starting && <Spinner />}
            {starting ? 'Starting…' : 'Start quiz'}
          </button>
          <OpenInCanvasLink url={htmlUrl} />
        </div>
        {error && <p className="mt-2 text-xs text-err">{error}</p>}
      </div>
    )
  }

  // ── Taking ──
  return (
    <div className="flex flex-col gap-3">
      {questions.length === 0 ? (
        <div className="rounded-lg border border-line bg-bg-elevated px-3 py-2.5">
          <p className="text-xs text-txt-3">This quiz has no questions to display here.</p>
          <div className="mt-2">
            <OpenInCanvasLink url={htmlUrl} />
          </div>
        </div>
      ) : (
        questions.map((q, i) => (
          <QuizQuestionCard
            key={q.id ?? `q-${i}`}
            index={i}
            question={q}
            disabled={submitting}
            onSave={saveAnswer}
          />
        ))
      )}

      {saveError && <p className="text-xs text-warn">{saveError}</p>}
      {error && <p className="text-xs text-err">{error}</p>}

      {questions.length > 0 && (
        <div className="flex items-center justify-end gap-2">
          {confirmSubmit && (
            <button
              type="button"
              onClick={() => setConfirmSubmit(false)}
              disabled={submitting}
              className="rounded-md px-2.5 py-1.5 text-xs font-medium text-txt-3 transition-colors hover:text-txt-1"
            >
              Cancel
            </button>
          )}
          <button
            type="button"
            disabled={submitting}
            onClick={() => (confirmSubmit ? void finish() : setConfirmSubmit(true))}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-50 ${
              confirmSubmit
                ? 'bg-accent text-bg hover:brightness-110'
                : 'border border-accent-ring text-accent hover:bg-accent/10'
            }`}
          >
            {submitting && <Spinner />}
            {confirmSubmit ? 'Confirm submit' : 'Submit quiz'}
          </button>
        </div>
      )}

      <div>
        <OpenInCanvasLink url={htmlUrl} />
      </div>
    </div>
  )
}

/** A single quiz question card with the right input control for its type. */
function QuizQuestionCard({
  index,
  question,
  disabled,
  onSave
}: {
  index: number
  question: CanvasQuizQuestion
  disabled: boolean
  onSave: (q: CanvasQuizQuestion, answer: unknown) => Promise<void>
}): JSX.Element {
  const type = question.type
  const answers = question.answers ?? []
  // Local answer state (kept in sync with what we last sent to Canvas).
  const [single, setSingle] = useState<string>('')
  const [multi, setMulti] = useState<string[]>([])
  const [text, setText] = useState<string>('')
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Debounced text/number save (on pause + on blur).
  const queueTextSave = useCallback(
    (value: string): void => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => {
        void onSave(question, value)
      }, 700)
    },
    [question, onSave]
  )
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  const card = (inner: React.ReactNode): JSX.Element => (
    <div className="rounded-lg border border-line bg-bg-elevated p-3">
      <div className="mb-1.5 flex items-baseline gap-2">
        <span className="text-[11px] font-semibold text-txt-4">Q{index + 1}</span>
        {question.name && <span className="text-[11px] text-txt-4">{question.name}</span>}
      </div>
      {question.text && (
        <RichHtml html={question.text} className="mb-2.5 text-xs leading-relaxed text-txt-1" />
      )}
      {inner}
    </div>
  )

  if (type === 'multiple_choice_question' || type === 'true_false_question') {
    return card(
      <div className="flex flex-col gap-1.5">
        {answers.map((a, i) => (
          <label
            key={a.id ?? `a-${i}`}
            className="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 text-xs text-txt-2 hover:bg-bg"
          >
            <input
              type="radio"
              name={`q-${question.id ?? index}`}
              checked={single === (a.id ?? '')}
              disabled={disabled || !a.id}
              onChange={() => {
                const id = a.id ?? ''
                setSingle(id)
                void onSave(question, id)
              }}
              className="mt-0.5 accent-[var(--accent)]"
            />
            <RichHtml html={a.text} className="leading-relaxed" />
          </label>
        ))}
      </div>
    )
  }

  if (type === 'multiple_answers_question') {
    return card(
      <div className="flex flex-col gap-1.5">
        {answers.map((a, i) => {
          const id = a.id ?? ''
          const checked = multi.includes(id)
          return (
            <label
              key={a.id ?? `a-${i}`}
              className="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 text-xs text-txt-2 hover:bg-bg"
            >
              <input
                type="checkbox"
                checked={checked}
                disabled={disabled || !a.id}
                onChange={() => {
                  const next = checked ? multi.filter((m) => m !== id) : [...multi, id]
                  setMulti(next)
                  void onSave(question, next)
                }}
                className="mt-0.5 accent-[var(--accent)]"
              />
              <RichHtml html={a.text} className="leading-relaxed" />
            </label>
          )
        })}
      </div>
    )
  }

  if (type === 'essay_question') {
    return card(
      <textarea
        value={text}
        rows={5}
        disabled={disabled}
        placeholder="Write your answer…"
        onChange={(e) => {
          setText(e.target.value)
          queueTextSave(e.target.value)
        }}
        onBlur={() => void onSave(question, text)}
        className="w-full resize-y rounded-md border border-line bg-bg px-2.5 py-2 text-xs text-txt-1 placeholder:text-txt-4 focus:border-accent-ring focus:outline-none disabled:opacity-60"
      />
    )
  }

  if (type === 'numerical_question') {
    return card(
      <input
        type="number"
        value={text}
        disabled={disabled}
        placeholder="Enter a number…"
        onChange={(e) => {
          setText(e.target.value)
          queueTextSave(e.target.value)
        }}
        onBlur={() => void onSave(question, text)}
        className="w-full rounded-md border border-line bg-bg px-2.5 py-2 text-xs text-txt-1 placeholder:text-txt-4 focus:border-accent-ring focus:outline-none disabled:opacity-60"
      />
    )
  }

  // short_answer_question + any other text-ish classic type.
  return card(
    <input
      type="text"
      value={text}
      disabled={disabled}
      placeholder="Your answer…"
      onChange={(e) => {
        setText(e.target.value)
        queueTextSave(e.target.value)
      }}
      onBlur={() => void onSave(question, text)}
      className="w-full rounded-md border border-line bg-bg px-2.5 py-2 text-xs text-txt-1 placeholder:text-txt-4 focus:border-accent-ring focus:outline-none disabled:opacity-60"
    />
  )
}

/* ── Assignment comments ── */

function CommentsSection({
  courseId,
  assignmentId,
  comments,
  onAddComment
}: {
  courseId: string
  assignmentId: string
  comments?: CanvasComment[]
  onAddComment: (courseId: string, assignmentId: string, text: string) => Promise<void>
}): JSX.Element {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const list = Array.isArray(comments) ? comments : []

  const send = useCallback(async (): Promise<void> => {
    if (text.trim().length === 0) return
    setError('')
    setBusy(true)
    try {
      await onAddComment(courseId, assignmentId, text)
      setText('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add comment.')
    } finally {
      setBusy(false)
    }
  }, [courseId, assignmentId, text, onAddComment])

  return (
    <>
      <SectionHeading count={list.length || undefined}>Comments</SectionHeading>
      {list.length === 0 ? (
        <p className="text-xs text-txt-4">No comments yet.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {list.map((c, i) => (
            <div
              key={`${c.authorName ?? 'c'}-${i}`}
              className="rounded-lg border border-line bg-bg-elevated px-3 py-2"
            >
              <div className="mb-0.5 flex items-center gap-2">
                <span className="truncate text-xs font-medium text-txt-1">
                  {c.authorName ?? 'Unknown'}
                </span>
                {c.createdAt && (
                  <span className="shrink-0 text-[11px] text-txt-4" title={formatWhen(c.createdAt)}>
                    {relative(c.createdAt)}
                  </span>
                )}
              </div>
              <p className="whitespace-pre-wrap text-xs leading-relaxed text-txt-2">
                {c.comment ?? ''}
              </p>
            </div>
          ))}
        </div>
      )}

      <div className="mt-3 rounded-lg border border-line bg-bg-elevated p-3">
        <label className="mb-1.5 block text-[11px] font-medium text-txt-3">Add a comment</label>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          placeholder="Write a comment…"
          disabled={busy}
          className="w-full resize-y rounded-md border border-line bg-bg px-2.5 py-2 text-xs text-txt-1 placeholder:text-txt-4 focus:border-accent-ring focus:outline-none disabled:opacity-60"
        />
        <div className="mt-2 flex items-center justify-end">
          <button
            type="button"
            disabled={busy || text.trim().length === 0}
            onClick={() => void send()}
            className="inline-flex items-center gap-1.5 rounded-md border border-accent-ring px-3 py-1.5 text-xs font-semibold text-accent transition-colors hover:bg-accent/10 disabled:opacity-50"
          >
            {busy && <Spinner />}
            Comment
          </button>
        </div>
        {error && <p className="mt-2 text-xs text-err">{error}</p>}
      </div>
    </>
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
  discussions,
  modules,
  quizzes,
  courseName,
  onOpenAssignment,
  onOpenDiscussions,
  onOpenDiscussion,
  onOpenPage,
  onMarkModuleItem
}: {
  detail?: DetailCache<CanvasCourseDetail>
  courseId: string
  assignments: CanvasAssignment[]
  assignmentsMeta: TabData
  announcements: CanvasAnnouncement[]
  announcementsMeta: TabData
  discussions?: DetailCache<CanvasDiscussion[]>
  modules?: DetailCache<CanvasModule[]>
  quizzes?: DetailCache<CanvasQuiz[]>
  courseName: (id?: string) => string | undefined
  onOpenAssignment: (
    courseId?: string,
    assignmentId?: string,
    nav?: NavContext | null
  ) => void
  onOpenDiscussions: (courseId: string) => void
  onOpenDiscussion: (courseId: string, topicId?: string, nav?: NavContext | null) => void
  onOpenPage: (courseId: string, pageUrl?: string, nav?: NavContext | null) => void
  onMarkModuleItem: (
    courseId: string,
    moduleId: string,
    itemId: string,
    done: boolean
  ) => Promise<void>
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

  // Flattened display order across this course's assignment sections — the list
  // Prev/Next steps through when one of them is opened from the course view.
  const courseAssignmentOrder = [...missing, ...upcoming, ...pastDone, ...noDate]

  // ── Table of contents (jump-to-section side nav) ──
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const tocSlug = (s: string): string =>
    'toc-' + s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const scrollToToc = (id: string): void => {
    scrollRef.current?.querySelector(`[data-toc="${id}"]`)?.scrollIntoView({
      behavior: 'smooth',
      block: 'start'
    })
  }
  const moduleList = modules?.data ?? []
  // Modules form their own COLLAPSIBLE group in the TOC (starts collapsed).
  const [tocModulesOpen, setTocModulesOpen] = useState(false)
  const moduleToc = moduleList.map((m, i) => ({
    id: 'toc-module-' + (m.id ?? i),
    label: m.name ?? `Module ${i + 1}`
  }))
  // Flat (non-module) TOC entries shown above the Modules group.
  const toc: Array<{ id: string; label: string }> = [
    ...(missing.length ? [{ id: tocSlug('Missing'), label: 'Missing' }] : []),
    ...(upcoming.length ? [{ id: tocSlug('Upcoming'), label: 'Upcoming' }] : []),
    ...(pastDone.length ? [{ id: tocSlug('Past'), label: 'Past' }] : []),
    ...(noDate.length ? [{ id: tocSlug('No due date'), label: 'No due date' }] : []),
    { id: tocSlug('Announcements'), label: 'Announcements' },
    { id: tocSlug('Discussions'), label: 'Discussions' }
  ]

  const section = (
    title: string,
    tone: 'err' | 'accent' | 'muted' | 'ok',
    rows: CanvasAssignment[]
  ): JSX.Element | null => {
    if (rows.length === 0) return null
    return (
      <section key={title} data-toc={tocSlug(title)} className="mt-4 scroll-mt-2">
        <SectionHeading count={rows.length} tone={tone}>
          {title}
        </SectionHeading>
        <div className="flex flex-col gap-2">
          {rows.map((a, i) => (
            <AgendaAssignmentRow
              key={a.id ?? `${a.name ?? 'a'}-${i}`}
              a={a}
              label={label}
              nav={assignmentNav(courseAssignmentOrder, a)}
              onOpenAssignment={onOpenAssignment}
            />
          ))}
        </div>
      </section>
    )
  }

  return (
    <div className="flex min-h-0 flex-1">
      {/* Table of contents — jump to any section / module (course view can be a
          huge wall of info; this makes navigation easy). Hidden on narrow widths. */}
      <aside className="hidden w-44 shrink-0 overflow-y-auto border-r border-line p-2 md:block">
        <div className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-txt-4">
          Contents
        </div>
        {toc.map((t) => (
          <button
            key={t.id}
            onClick={() => scrollToToc(t.id)}
            className="block w-full truncate rounded-md px-2 py-1.5 text-left text-xs text-txt-2 transition-colors hover:bg-bg-elevated hover:text-txt-1"
            title={t.label}
          >
            {t.label}
          </button>
        ))}

        {/* Modules — a COLLAPSIBLE group in the contents (starts collapsed). */}
        {moduleToc.length > 0 && (
          <>
            <button
              onClick={() => setTocModulesOpen((v) => !v)}
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs font-medium text-txt-2 transition-colors hover:bg-bg-elevated hover:text-txt-1"
              aria-expanded={tocModulesOpen}
            >
              <svg
                viewBox="0 0 24 24"
                className={`h-3 w-3 shrink-0 text-txt-3 transition-transform ${tocModulesOpen ? 'rotate-90' : ''}`}
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M9 6l6 6-6 6" />
              </svg>
              <span className="min-w-0 flex-1 truncate">Modules</span>
              <span className="shrink-0 text-[10px] tabular-nums text-txt-4">{moduleToc.length}</span>
            </button>
            {tocModulesOpen &&
              moduleToc.map((t) => (
                <button
                  key={t.id}
                  onClick={() => scrollToToc(t.id)}
                  className="block w-full truncate rounded-md py-1.5 pl-7 pr-2 text-left text-xs text-txt-3 transition-colors hover:bg-bg-elevated hover:text-txt-1"
                  title={t.label}
                >
                  {t.label}
                </button>
              ))}
          </>
        )}

        <button
          onClick={() => scrollToToc(tocSlug('Quizzes'))}
          className="block w-full truncate rounded-md px-2 py-1.5 text-left text-xs text-txt-2 transition-colors hover:bg-bg-elevated hover:text-txt-1"
        >
          Quizzes
        </button>
      </aside>

      <div ref={scrollRef} className="flex-1 overflow-auto px-4 py-4">
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
      <section data-toc={tocSlug('Announcements')} className="mt-5 scroll-mt-2">
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

      {/* Discussions */}
      <div data-toc={tocSlug('Discussions')} className="scroll-mt-2">
        <CourseDiscussionsSection
          courseId={courseId}
          list={discussions}
          onOpenDiscussions={onOpenDiscussions}
          onOpenDiscussion={onOpenDiscussion}
        />
      </div>

      {/* Modules (reading) — each module is its own TOC anchor */}
      <CourseModulesSection
        courseId={courseId}
        modules={modules}
        accent={c.hue}
        missingAssignments={missing}
        onOpenPage={onOpenPage}
        onOpenAssignment={onOpenAssignment}
        onMarkModuleItem={onMarkModuleItem}
      />

      {/* Quizzes */}
      <div data-toc={tocSlug('Quizzes')} className="scroll-mt-2">
        <CourseQuizzesSection quizzes={quizzes} />
      </div>
      </div>
    </div>
  )
}

/* ── Course section: Discussions ── */

function CourseDiscussionsSection({
  courseId,
  list,
  onOpenDiscussions,
  onOpenDiscussion
}: {
  courseId: string
  list?: DetailCache<CanvasDiscussion[]>
  onOpenDiscussions: (courseId: string) => void
  onOpenDiscussion: (courseId: string, topicId?: string, nav?: NavContext | null) => void
}): JSX.Element {
  const topics = (list?.data ?? []).filter((t) => !t.isAnnouncement)
  // Only the first 5 are shown here, so Prev/Next steps through those 5.
  const shown = topics.slice(0, 5)
  const loading = !list || list.state === 'loading' || list.state === 'idle'
  return (
    <section className="mt-5">
      <div className="flex items-center justify-between">
        <SectionHeading count={loading ? undefined : topics.length}>Discussions</SectionHeading>
        {topics.length > 0 && (
          <button
            type="button"
            onClick={() => onOpenDiscussions(courseId)}
            className="mb-2 text-[11px] font-medium text-txt-3 transition-colors hover:text-accent"
          >
            View all
          </button>
        )}
      </div>
      {loading ? (
        <TabStatus kind="loading" message="Loading discussions…" />
      ) : list?.state === 'error' ? (
        <TabStatus kind="error" message={list.error} />
      ) : topics.length === 0 ? (
        <p className="text-xs text-txt-4">No discussions for this course.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {shown.map((t, i) => (
            <DiscussionRow
              key={t.id ?? `${t.title ?? 'd'}-${i}`}
              t={t}
              courseId={courseId}
              nav={discussionNav(shown, courseId, t)}
              onOpenDiscussion={onOpenDiscussion}
            />
          ))}
        </div>
      )}
    </section>
  )
}

/* ── Course section: Modules (reading) ── */

function CourseModulesSection({
  courseId,
  modules,
  accent,
  missingAssignments,
  onOpenPage,
  onOpenAssignment,
  onMarkModuleItem
}: {
  courseId: string
  modules?: DetailCache<CanvasModule[]>
  accent: string
  /** This course's MISSING assignments — surfaced inside the modules that hold them. */
  missingAssignments: CanvasAssignment[]
  onOpenPage: (courseId: string, pageUrl?: string, nav?: NavContext | null) => void
  onOpenAssignment: (courseId?: string, assignmentId?: string, nav?: NavContext | null) => void
  onMarkModuleItem: (
    courseId: string,
    moduleId: string,
    itemId: string,
    done: boolean
  ) => Promise<void>
}): JSX.Element {
  const list = modules?.data ?? []
  const loading = !modules || modules.state === 'loading' || modules.state === 'idle'
  // All readable page items across modules, in display order — the list Prev/Next
  // steps through when a page is opened.
  const pageOrder = list.flatMap((m) => (m.items ?? []).filter((it) => it.type === 'Page' && it.pageUrl))
  // Index missing assignments by their id so a module's Assignment items (whose
  // `contentId` is the assignment id) can be flagged as Missing in place.
  const missingById = new Map<string, CanvasAssignment>()
  for (const a of missingAssignments) if (a.id) missingById.set(a.id, a)
  return (
    <section className="mt-5">
      <SectionHeading count={loading ? undefined : list.length}>Modules</SectionHeading>
      {loading ? (
        <TabStatus kind="loading" message="Loading modules…" />
      ) : modules?.state === 'error' ? (
        <TabStatus kind="error" message={modules.error} />
      ) : list.length === 0 ? (
        <p className="text-xs text-txt-4">No modules for this course.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {list.map((m, i) => (
            <ModuleCard
              key={m.id ?? `m-${i}`}
              tocId={'toc-module-' + (m.id ?? i)}
              module={m}
              courseId={courseId}
              accent={accent}
              pageOrder={pageOrder}
              missingById={missingById}
              onOpenPage={onOpenPage}
              onOpenAssignment={onOpenAssignment}
              onMarkModuleItem={onMarkModuleItem}
            />
          ))}
        </div>
      )}
    </section>
  )
}

/**
 * A single module on the page (NOT collapsible — items are always shown). The
 * header shows the item count and, when the module holds any MISSING assignments,
 * a red "N missing" badge, with the missing items flagged in place below.
 */
function ModuleCard({
  tocId,
  module: m,
  courseId,
  accent,
  pageOrder,
  missingById,
  onOpenPage,
  onOpenAssignment,
  onMarkModuleItem
}: {
  tocId: string
  module: CanvasModule
  courseId: string
  accent: string
  pageOrder: CanvasModuleItem[]
  missingById: Map<string, CanvasAssignment>
  onOpenPage: (courseId: string, pageUrl?: string, nav?: NavContext | null) => void
  onOpenAssignment: (courseId?: string, assignmentId?: string, nav?: NavContext | null) => void
  onMarkModuleItem: (
    courseId: string,
    moduleId: string,
    itemId: string,
    done: boolean
  ) => Promise<void>
}): JSX.Element {
  const items = m.items ?? []
  const missingCount = items.reduce(
    (n, it) => n + (it.type === 'Assignment' && it.contentId && missingById.has(it.contentId) ? 1 : 0),
    0
  )
  return (
    <div data-toc={tocId} className="scroll-mt-2 rounded-lg border border-line bg-bg-elevated p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-txt-1">
          {m.name ?? 'Module'}
        </span>
        {missingCount > 0 && (
          <span className="shrink-0 rounded bg-err/15 px-1.5 py-0.5 text-[10px] font-semibold text-err">
            {missingCount} missing
          </span>
        )}
      </div>
      {items.length === 0 ? (
        <p className="text-[11px] text-txt-4">No items.</p>
      ) : (
        <div className="flex flex-col gap-1">
          {items.map((it, j) => (
            <ModuleItemRow
              key={it.id ?? `mi-${j}`}
              courseId={courseId}
              moduleId={m.id ?? ''}
              item={it}
              accent={accent}
              missing={
                it.type === 'Assignment' && it.contentId
                  ? missingById.get(it.contentId)
                  : undefined
              }
              nav={pageNav(pageOrder, courseId, it)}
              onOpenPage={onOpenPage}
              onOpenAssignment={onOpenAssignment}
              onMarkModuleItem={onMarkModuleItem}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Build a page nav context from a display-ordered list of page items (same
 * course). `id` is the pageUrl. Returns null when there's nothing to step
 * through. Non-page module items are ignored (only pages open in-deck).
 */
function pageNav(
  ordered: CanvasModuleItem[],
  courseId: string,
  item: CanvasModuleItem
): NavContext | null {
  const items: NavItem[] = ordered
    .filter((x) => x.type === 'Page' && x.pageUrl)
    .map((x) => ({ courseId, id: x.pageUrl! }))
  if (items.length < 2) return null
  const index = items.findIndex((x) => x.id === item.pageUrl)
  if (index < 0) return null
  return { kind: 'page', items, index }
}

/** A single module item row: page→open in deck; others→Open in Canvas; optional done toggle. */
function ModuleItemRow({
  courseId,
  moduleId,
  item,
  accent,
  missing,
  nav,
  onOpenPage,
  onOpenAssignment,
  onMarkModuleItem
}: {
  courseId: string
  moduleId: string
  item: CanvasModuleItem
  accent: string
  /** Set when this item is an Assignment that is currently MISSING. */
  missing?: CanvasAssignment
  /** Ordered page-item list this row belongs to, for Prev/Next stepping. */
  nav?: NavContext | null
  onOpenPage: (courseId: string, pageUrl?: string, nav?: NavContext | null) => void
  onOpenAssignment: (courseId?: string, assignmentId?: string, nav?: NavContext | null) => void
  onMarkModuleItem: (
    courseId: string,
    moduleId: string,
    itemId: string,
    done: boolean
  ) => Promise<void>
}): JSX.Element {
  const [busy, setBusy] = useState(false)
  const isPage = item.type === 'Page' && !!item.pageUrl
  const isAssignment = item.type === 'Assignment' && !!item.contentId
  const hasRequirement = !!item.requirementType
  const completed = !!item.completed

  const toggle = useCallback(async (): Promise<void> => {
    if (!item.id) return
    setBusy(true)
    try {
      await onMarkModuleItem(courseId, moduleId, item.id, !completed)
    } finally {
      setBusy(false)
    }
  }, [courseId, moduleId, item.id, completed, onMarkModuleItem])

  return (
    <div className="flex items-center gap-2">
      {isPage ? (
        <button
          type="button"
          onClick={() => onOpenPage(courseId, item.pageUrl, nav ?? null)}
          className="min-w-0 flex-1 truncate rounded px-1.5 py-1 text-left text-xs text-txt-2 transition-colors hover:text-accent"
          style={{ borderLeft: `2px solid ${accent}`, paddingLeft: '0.5rem' }}
        >
          {item.title ?? 'Page'}
        </button>
      ) : isAssignment ? (
        <button
          type="button"
          onClick={() => onOpenAssignment(courseId, item.contentId, null)}
          className="flex min-w-0 flex-1 items-center gap-1.5 truncate rounded px-1.5 py-1 text-left text-xs text-txt-2 transition-colors hover:text-accent"
          style={{ borderLeft: `2px solid ${missing ? 'var(--err)' : accent}`, paddingLeft: '0.5rem' }}
          title={missing ? 'Missing assignment — open' : item.type}
        >
          <span className="min-w-0 flex-1 truncate">{item.title ?? 'Assignment'}</span>
          {missing && (
            <span className="shrink-0 rounded bg-err/15 px-1.5 py-0.5 text-[10px] font-semibold text-err">
              Missing
            </span>
          )}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => openExternal(item.htmlUrl)}
          disabled={!item.htmlUrl}
          className="min-w-0 flex-1 truncate rounded px-1.5 py-1 text-left text-xs text-txt-2 transition-colors enabled:hover:text-accent disabled:opacity-60"
          style={{ borderLeft: `2px solid ${accent}`, paddingLeft: '0.5rem' }}
          title={item.type}
        >
          {item.title ?? item.type ?? 'Item'}
          {item.type && <span className="ml-1.5 text-[10px] text-txt-4">{item.type}</span>}
        </button>
      )}
      {hasRequirement && (
        <button
          type="button"
          onClick={() => void toggle()}
          disabled={busy}
          className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold transition-colors disabled:opacity-50 ${
            completed
              ? 'bg-ok/15 text-ok'
              : 'border border-line text-txt-3 hover:border-accent-ring hover:text-accent'
          }`}
        >
          {completed ? 'Done ✓' : 'Mark done'}
        </button>
      )}
    </div>
  )
}

/* ── Course section: Quizzes ── */

function CourseQuizzesSection({
  quizzes
}: {
  quizzes?: DetailCache<CanvasQuiz[]>
}): JSX.Element {
  const list = quizzes?.data ?? []
  const loading = !quizzes || quizzes.state === 'loading' || quizzes.state === 'idle'
  return (
    <section className="mt-5">
      <SectionHeading count={loading ? undefined : list.length}>Quizzes</SectionHeading>
      {loading ? (
        <TabStatus kind="loading" message="Loading quizzes…" />
      ) : quizzes?.state === 'error' ? (
        <TabStatus kind="error" message={quizzes.error} />
      ) : list.length === 0 ? (
        <p className="text-xs text-txt-4">No quizzes for this course.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {list.map((q, i) => {
            const u = urgency(q.dueAt)
            const past = q.dueAt ? new Date(q.dueAt).getTime() < Date.now() : false
            return (
              <div
                key={q.id ?? `q-${i}`}
                className="rounded-lg border border-line bg-bg-elevated px-3 py-2.5"
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-txt-1">
                    {q.title ?? 'Quiz'}
                  </span>
                  {q.locked ? (
                    <span className="shrink-0 rounded bg-bg px-1.5 py-0.5 text-[10px] font-semibold text-txt-3">
                      Locked
                    </span>
                  ) : (
                    <span className="shrink-0 rounded bg-ok/15 px-1.5 py-0.5 text-[10px] font-medium text-ok">
                      Available
                    </span>
                  )}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                  {q.dueAt ? (
                    <span className={past ? 'text-txt-4' : URGENCY_TEXT[u]}>
                      {past ? `Due ${formatWhen(q.dueAt)}` : `Due ${relative(q.dueAt)} · ${formatWhen(q.dueAt)}`}
                    </span>
                  ) : (
                    <span className="text-txt-4">No due date</span>
                  )}
                  {typeof q.pointsPossible === 'number' && (
                    <span className="text-txt-4">· {q.pointsPossible} pts</span>
                  )}
                  {typeof q.questionCount === 'number' && (
                    <span className="text-txt-4">· {q.questionCount} questions</span>
                  )}
                </div>
                <div className="mt-2">
                  <OpenInCanvasLink url={q.htmlUrl} />
                  <span className="ml-2 text-[10px] text-txt-4">to take</span>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

/* ── Discussion row (shared by course section + list view) ── */

function DiscussionRow({
  t,
  courseId,
  nav,
  onOpenDiscussion
}: {
  t: CanvasDiscussion
  courseId: string
  /** Ordered sibling list this row belongs to, for Prev/Next stepping. */
  nav?: NavContext | null
  onOpenDiscussion: (courseId: string, topicId?: string, nav?: NavContext | null) => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={() => onOpenDiscussion(courseId, t.id, nav ?? null)}
      disabled={!t.id}
      className="flex w-full flex-col items-start gap-1 overflow-hidden rounded-lg border border-line bg-bg-elevated px-3 py-2.5 text-left transition-colors enabled:hover:border-accent-ring disabled:cursor-default"
    >
      <div className="flex w-full items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-txt-1">
          {t.title ?? 'Discussion'}
        </span>
        {typeof t.unreadCount === 'number' && t.unreadCount > 0 && (
          <span className="shrink-0 rounded-full bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold text-accent">
            {t.unreadCount} new
          </span>
        )}
        {t.postedAt && (
          <span className="shrink-0 text-[11px] text-txt-4" title={formatWhen(t.postedAt)}>
            {relative(t.postedAt)}
          </span>
        )}
      </div>
      {t.requireInitialPost && (
        <span className="text-[10px] text-warn">Post a reply to view others</span>
      )}
    </button>
  )
}

/* ── Detail: Discussions list ── */

function DiscussionsView({
  list,
  courseId,
  courseName,
  onOpenDiscussion
}: {
  list?: DetailCache<CanvasDiscussion[]>
  courseId: string
  courseName: (id?: string) => string | undefined
  onOpenDiscussion: (courseId: string, topicId?: string, nav?: NavContext | null) => void
}): JSX.Element {
  const label = courseName(courseId)
  if (!list || list.state === 'loading' || list.state === 'idle') {
    return (
      <div className="flex-1 overflow-auto px-4 py-4">
        <TabStatus kind="loading" message="Loading discussions…" />
      </div>
    )
  }
  if (list.state === 'error') {
    return (
      <div className="flex-1 overflow-auto px-4 py-4">
        <TabStatus kind="error" message={list.error} />
      </div>
    )
  }
  const topics = (list.data ?? []).filter((t) => !t.isAnnouncement)
  return (
    <div className="flex-1 overflow-auto px-4 py-4">
      <div className="mb-3">
        <CourseChip label={label} colorKey={courseId} />
      </div>
      <SectionHeading count={topics.length}>Discussions</SectionHeading>
      {topics.length === 0 ? (
        <TabStatus kind="empty" message="No discussions for this course." />
      ) : (
        <div className="flex flex-col gap-2">
          {topics.map((t, i) => (
            <DiscussionRow
              key={t.id ?? `${t.title ?? 'd'}-${i}`}
              t={t}
              courseId={courseId}
              nav={discussionNav(topics, courseId, t)}
              onOpenDiscussion={onOpenDiscussion}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/* ── Detail: Discussion thread ── */

/** Recursively render a discussion entry and its nested replies (indented). */
function DiscussionEntryNode({
  entry,
  depth,
  accent,
  onReply,
  replyingTo,
  setReplyingTo,
  posting
}: {
  entry: CanvasDiscussionEntry
  depth: number
  accent: string
  onReply: (parentId: string, message: string) => Promise<void>
  replyingTo: string | null
  setReplyingTo: (id: string | null) => void
  posting: boolean
}): JSX.Element {
  const [text, setText] = useState('')
  const message = htmlToText(entry.message)
  const open = replyingTo === entry.id
  const indent = Math.min(depth, 5) * 14

  const send = useCallback(async (): Promise<void> => {
    if (!entry.id || text.trim().length === 0) return
    await onReply(entry.id, text)
    setText('')
  }, [entry.id, text, onReply])

  return (
    <div style={{ marginLeft: indent }}>
      <div
        className="rounded-lg border border-line bg-bg-elevated px-3 py-2"
        style={depth > 0 ? { borderLeft: `2px solid ${accent}` } : undefined}
      >
        <div className="mb-0.5 flex items-center gap-2">
          <span className="truncate text-xs font-medium text-txt-1">
            {entry.authorName ?? 'Unknown'}
          </span>
          {entry.createdAt && (
            <span className="shrink-0 text-[11px] text-txt-4" title={formatWhen(entry.createdAt)}>
              {relative(entry.createdAt)}
            </span>
          )}
        </div>
        {message ? (
          <p className="whitespace-pre-wrap text-xs leading-relaxed text-txt-2">{message}</p>
        ) : (
          <p className="text-xs text-txt-4">(no content)</p>
        )}
        <div className="mt-1.5">
          <button
            type="button"
            onClick={() => setReplyingTo(open ? null : entry.id ?? null)}
            disabled={!entry.id}
            className="text-[11px] font-medium text-txt-3 transition-colors hover:text-accent disabled:opacity-50"
          >
            {open ? 'Cancel' : 'Reply'}
          </button>
        </div>
        {open && (
          <div className="mt-2">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={2}
              placeholder="Write a reply…"
              disabled={posting}
              className="w-full resize-y rounded-md border border-line bg-bg px-2.5 py-2 text-xs text-txt-1 placeholder:text-txt-4 focus:border-accent-ring focus:outline-none disabled:opacity-60"
            />
            <div className="mt-2 flex justify-end">
              <button
                type="button"
                onClick={() => void send()}
                disabled={posting || text.trim().length === 0}
                className="inline-flex items-center gap-1.5 rounded-md border border-accent-ring px-3 py-1.5 text-xs font-semibold text-accent transition-colors hover:bg-accent/10 disabled:opacity-50"
              >
                {posting && <Spinner />}
                Post reply
              </button>
            </div>
          </div>
        )}
      </div>
      {(entry.replies ?? []).length > 0 && (
        <div className="mt-2 flex flex-col gap-2">
          {(entry.replies ?? []).map((r, i) => (
            <DiscussionEntryNode
              key={r.id ?? `r-${depth}-${i}`}
              entry={r}
              depth={depth + 1}
              accent={accent}
              onReply={onReply}
              replyingTo={replyingTo}
              setReplyingTo={setReplyingTo}
              posting={posting}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function DiscussionThreadView({
  thread,
  courseId,
  topicId,
  courseName,
  onPostReply
}: {
  thread?: DetailCache<CanvasDiscussionThread>
  courseId: string
  topicId: string
  courseName: (id?: string) => string | undefined
  onPostReply: (
    courseId: string,
    topicId: string,
    message: string,
    parentEntryId?: string
  ) => Promise<void>
}): JSX.Element {
  const accent = courseColor(courseId).hue
  const [rootText, setRootText] = useState('')
  const [posting, setPosting] = useState(false)
  const [error, setError] = useState('')
  const [replyingTo, setReplyingTo] = useState<string | null>(null)

  const postRoot = useCallback(async (): Promise<void> => {
    if (rootText.trim().length === 0) return
    setError('')
    setPosting(true)
    try {
      await onPostReply(courseId, topicId, rootText)
      setRootText('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to post reply.')
    } finally {
      setPosting(false)
    }
  }, [courseId, topicId, rootText, onPostReply])

  const postNested = useCallback(
    async (parentId: string, message: string): Promise<void> => {
      setError('')
      setPosting(true)
      try {
        await onPostReply(courseId, topicId, message, parentId)
        setReplyingTo(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to post reply.')
      } finally {
        setPosting(false)
      }
    },
    [courseId, topicId, onPostReply]
  )

  if (!thread || thread.state === 'loading' || thread.state === 'idle') {
    return (
      <div className="flex-1 overflow-auto px-4 py-4">
        <TabStatus kind="loading" message="Loading discussion…" />
      </div>
    )
  }
  if (thread.state === 'error') {
    return (
      <div className="flex-1 overflow-auto px-4 py-4">
        <TabStatus kind="error" message={thread.error} />
      </div>
    )
  }
  const t = thread.data ?? {}
  const rootMessage = htmlToText(t.message)
  const entries = t.entries ?? []
  const label = courseName(courseId)

  return (
    <div className="flex-1 overflow-auto px-4 py-4">
      <div className="mb-3">
        <CourseChip label={label} colorKey={courseId} />
      </div>
      <h1 className="text-base font-semibold leading-snug text-txt-1">{t.title ?? 'Discussion'}</h1>
      {t.postedAt && (
        <p className="mt-1 text-[11px] text-txt-4" title={formatWhen(t.postedAt)}>
          Posted {relative(t.postedAt)}
        </p>
      )}

      {/* Root message */}
      <div className="mt-3 rounded-lg border border-line bg-bg-elevated px-3 py-2.5">
        {rootMessage ? (
          <p className="whitespace-pre-wrap text-xs leading-relaxed text-txt-2">{rootMessage}</p>
        ) : (
          <p className="text-xs text-txt-4">No prompt text.</p>
        )}
      </div>

      {/* Reply to the discussion */}
      <div className="mt-4 rounded-lg border border-line bg-bg-elevated p-3">
        <label className="mb-1.5 block text-[11px] font-medium text-txt-3">Reply to discussion</label>
        <textarea
          value={rootText}
          onChange={(e) => setRootText(e.target.value)}
          rows={3}
          placeholder="Write a reply…"
          disabled={posting}
          className="w-full resize-y rounded-md border border-line bg-bg px-2.5 py-2 text-xs text-txt-1 placeholder:text-txt-4 focus:border-accent-ring focus:outline-none disabled:opacity-60"
        />
        <div className="mt-2 flex items-center justify-end">
          <button
            type="button"
            onClick={() => void postRoot()}
            disabled={posting || rootText.trim().length === 0}
            className="inline-flex items-center gap-1.5 rounded-md border border-accent-ring px-3 py-1.5 text-xs font-semibold text-accent transition-colors hover:bg-accent/10 disabled:opacity-50"
          >
            {posting && <Spinner />}
            Post reply
          </button>
        </div>
        {error && <p className="mt-2 text-xs text-err">{error}</p>}
      </div>

      {/* Replies */}
      <div className="mt-5">
        <SectionHeading count={entries.length || undefined}>Replies</SectionHeading>
        {entries.length === 0 ? (
          <p className="text-xs text-txt-4">No replies yet.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {entries.map((e, i) => (
              <DiscussionEntryNode
                key={e.id ?? `e-${i}`}
                entry={e}
                depth={0}
                accent={accent}
                onReply={postNested}
                replyingTo={replyingTo}
                setReplyingTo={setReplyingTo}
                posting={posting}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/* ── Detail: Page (reading) ── */

function PageView({
  page,
  courseId,
  courseName
}: {
  page?: DetailCache<CanvasPage>
  courseId: string
  courseName: (id?: string) => string | undefined
}): JSX.Element {
  const label = courseName(courseId)
  if (!page || page.state === 'loading' || page.state === 'idle') {
    return (
      <div className="flex-1 overflow-auto px-4 py-4">
        <TabStatus kind="loading" message="Loading page…" />
      </div>
    )
  }
  if (page.state === 'error') {
    return (
      <div className="flex-1 overflow-auto px-4 py-4">
        <TabStatus kind="error" message={page.error} />
      </div>
    )
  }
  const p = page.data ?? {}
  const hasBody = !!p.body && p.body.trim().length > 0
  return (
    <div className="flex-1 overflow-auto px-4 py-4">
      <div className="mb-3">
        <CourseChip label={label} colorKey={courseId} />
      </div>
      <h1 className="text-base font-semibold leading-snug text-txt-1">{p.title ?? 'Page'}</h1>
      {p.updatedAt && (
        <p className="mt-1 text-[11px] text-txt-4" title={formatWhen(p.updatedAt)}>
          Updated {relative(p.updatedAt)}
        </p>
      )}
      <div className="mt-4">
        {hasBody ? (
          <RichHtml html={p.body} className="text-xs leading-relaxed text-txt-2" />
        ) : (
          <p className="text-xs text-txt-4">This page has no content.</p>
        )}
      </div>

      {/* Files embedded in the page */}
      <AttachmentsSection attachments={p.attachments} title="Files" />
    </div>
  )
}
