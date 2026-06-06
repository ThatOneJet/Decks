/**
 * Decks — in-app feedback transport.
 *
 * Turns a suggestion / bug report from the feedback modal into a GitHub Issue on
 * the feedback repo (ThatOneJet/Decks), so submissions from ANY machine funnel to
 * one place. An attached screenshot is committed to the repo (Contents API) and
 * linked in the issue body. The always-on Claude session watches open issues via
 * `gh`, builds each, then closes it.
 *
 * If the network or token is unavailable, the item is queued locally
 * (userData/feedback/queue.jsonl) and flushed on the next successful submit, so a
 * report is never lost. Never throws — mirrors persistence.ts error handling.
 */
import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { hostname } from 'os'
import type { FeedbackPayload, FeedbackResult } from '@shared/ipc'
import { FEEDBACK_TOKEN, FEEDBACK_REPO } from './feedback-token'

const API = 'https://api.github.com'
const token = (): string => (process.env.DECKS_FEEDBACK_TOKEN || FEEDBACK_TOKEN || '').trim()

function queueDir(): string {
  return join(app.getPath('userData'), 'feedback')
}
function queuePath(): string {
  return join(queueDir(), 'queue.jsonl')
}

/** A stable-ish id from the current time (no RNG needed). */
function newId(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function ghHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${token()}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Decks-Feedback',
    'Content-Type': 'application/json'
  }
}

/** Commit an image to the repo and return its raw URL (or null on failure). */
async function uploadImage(id: string, dataUrl: string): Promise<string | null> {
  try {
    const m = /^data:(image\/(png|jpeg|jpg|gif|webp));base64,(.+)$/i.exec(dataUrl)
    if (!m) return null
    const ext = m[2].toLowerCase() === 'jpeg' ? 'jpg' : m[2].toLowerCase()
    const b64 = m[3]
    const path = `feedback/images/${id}.${ext}`
    const res = await fetch(`${API}/repos/${FEEDBACK_REPO}/contents/${path}`, {
      method: 'PUT',
      headers: ghHeaders(),
      body: JSON.stringify({ message: `feedback image ${id}`, content: b64 })
    })
    if (!res.ok) return null
    const json = (await res.json()) as { content?: { download_url?: string } }
    return json.content?.download_url ?? null
  } catch {
    return null
  }
}

/** Create the issue. Returns {number,url} or null on failure. */
async function createIssue(
  p: FeedbackPayload,
  imageUrl: string | null
): Promise<{ number: number; url: string } | null> {
  try {
    const prefix = p.type === 'bug' ? '[Bug]' : '[Suggestion]'
    const footer =
      `\n\n---\n` +
      `_Decks ${app.getVersion?.() ?? '?'} · ${process.platform} · ${hostname()} · ${new Date().toISOString()}_`
    const body =
      (p.description || '').trim() +
      (imageUrl ? `\n\n![screenshot](${imageUrl})` : '') +
      footer
    const res = await fetch(`${API}/repos/${FEEDBACK_REPO}/issues`, {
      method: 'POST',
      headers: ghHeaders(),
      body: JSON.stringify({
        title: `${prefix} ${p.title}`.slice(0, 250),
        body,
        labels: [p.type === 'bug' ? 'bug' : 'suggestion']
      })
    })
    if (!res.ok) return null
    const json = (await res.json()) as { number?: number; html_url?: string }
    if (typeof json.number !== 'number' || !json.html_url) return null
    return { number: json.number, url: json.html_url }
  } catch {
    return null
  }
}

/** Send one payload to GitHub (image + issue). Returns null if it couldn't. */
async function sendOne(p: FeedbackPayload): Promise<{ number: number; url: string } | null> {
  if (!token()) return null
  const imageUrl = p.imageDataUrl ? await uploadImage(newId(), p.imageDataUrl) : null
  return createIssue(p, imageUrl)
}

async function appendQueue(p: FeedbackPayload): Promise<void> {
  try {
    await fs.mkdir(queueDir(), { recursive: true })
    await fs.appendFile(queuePath(), JSON.stringify(p) + '\n', 'utf8')
  } catch (err) {
    console.error('[decks] failed to queue feedback:', err)
  }
}

/** Best-effort: resend everything queued; rewrite the queue with what's left. */
async function flushQueue(): Promise<void> {
  if (!token()) return
  let lines: string[]
  try {
    lines = (await fs.readFile(queuePath(), 'utf8')).split('\n').filter(Boolean)
  } catch {
    return // no queue
  }
  const remaining: string[] = []
  for (const line of lines) {
    let p: FeedbackPayload | null = null
    try {
      p = JSON.parse(line) as FeedbackPayload
    } catch {
      continue // drop malformed
    }
    const sent = await sendOne(p)
    if (!sent) remaining.push(line)
  }
  try {
    if (remaining.length) await fs.writeFile(queuePath(), remaining.join('\n') + '\n', 'utf8')
    else await fs.unlink(queuePath()).catch(() => {})
  } catch {
    /* ignore */
  }
}

/** Submit a suggestion/bug. Files a GitHub issue, or queues offline. Never throws. */
export async function submitFeedback(p: FeedbackPayload): Promise<FeedbackResult> {
  try {
    if (!p || !p.title?.trim()) return { ok: false, error: 'Title required' }
    // Opportunistically flush anything queued from earlier offline submits.
    await flushQueue().catch(() => {})
    const sent = await sendOne(p)
    if (sent) return { ok: true, number: sent.number, url: sent.url }
    await appendQueue(p)
    return {
      ok: false,
      queued: true,
      error: token() ? 'GitHub unreachable — queued' : 'No feedback token — queued'
    }
  } catch (err) {
    console.error('[decks] feedback submit failed:', err)
    await appendQueue(p).catch(() => {})
    return { ok: false, queued: true, error: 'Queued' }
  }
}
