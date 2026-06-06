/**
 * Decks — Notes provider client (main process).
 *
 * Backs the native Notes deck: a local, Notion-style block editor. Like RSS this
 * provider needs NO auth and is ACCOUNT-AWARE — each "account" is one WORKSPACE
 * (a self-contained set of pages). The ENTIRE workspace is persisted as a single
 * JSON blob via the per-provider encrypted store (../tokens), keyed by
 * `accountKey('notes', accountId)` (see ../accounts). Nothing here is secret, but
 * reusing the store gives us atomic, OS-backed persistence on the user's machine
 * for free — and keeps Notes data OUT of the plaintext decks-state.json snapshot.
 *
 * There is NO network I/O. The renderer loads the workspace on mount ('load') and
 * autosaves the whole thing back ('save') on a debounce. The blob is sanitized
 * (shape-validated) on both read and write so a corrupt/old blob can never crash
 * the editor.
 */
import { saveToken, getToken, removeToken } from '../tokens'
import {
  accountKey,
  listAccounts as listProviderAccounts,
  upsertAccount,
  removeAccount
} from '../accounts'
import type { ProviderClient } from './types'
import type { ProviderId, ProviderStatus, AccountSummary } from '@shared/types'

const ID: ProviderId = 'notes'

/** Block kinds the editor understands. Unknown kinds collapse to 'paragraph'. */
export type BlockType =
  | 'h1'
  | 'h2'
  | 'h3'
  | 'paragraph'
  | 'todo'
  | 'bulleted'
  | 'numbered'
  | 'quote'
  | 'callout'
  | 'divider'
  | 'code'

const BLOCK_TYPES: readonly BlockType[] = [
  'h1',
  'h2',
  'h3',
  'paragraph',
  'todo',
  'bulleted',
  'numbered',
  'quote',
  'callout',
  'divider',
  'code'
]

/** One editable line/block within a page. */
export interface Block {
  id: string
  type: BlockType
  /** Text content (absent/ignored for 'divider'). */
  text?: string
  /** For 'todo': whether the item is checked. */
  checked?: boolean
  /** Reserved for list grouping (kept for forward-compat with the contract). */
  items?: string[]
  /** Reserved for nesting/indent level (kept for forward-compat). */
  level?: number
}

/** One page in the workspace. Pages nest via `parentId`. */
export interface Page {
  id: string
  title: string
  icon?: string
  parentId: string | null
  blocks: Block[]
  updatedAt: number
}

/** The whole persisted workspace blob. */
export interface Workspace {
  pages: Page[]
}

/** Generate a short, collision-resistant id (no external deps). */
function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/** A fresh workspace with one friendly welcome page. */
function seededWorkspace(): Workspace {
  const pageId = makeId('pg')
  return {
    pages: [
      {
        id: pageId,
        title: 'Welcome',
        icon: '👋',
        parentId: null,
        updatedAt: Date.now(),
        blocks: [
          { id: makeId('bk'), type: 'h1', text: 'Welcome to Notes' },
          {
            id: makeId('bk'),
            type: 'paragraph',
            text: 'A fast, local block editor. Everything lives on this machine.'
          },
          {
            id: makeId('bk'),
            type: 'callout',
            text: 'Tip: type “/” at the start of a line to pick a block type.'
          },
          { id: makeId('bk'), type: 'h2', text: 'Try it out' },
          { id: makeId('bk'), type: 'todo', text: 'Check me off', checked: false },
          { id: makeId('bk'), type: 'todo', text: 'Create a new page on the left', checked: false },
          { id: makeId('bk'), type: 'bulleted', text: 'Bulleted lists' },
          { id: makeId('bk'), type: 'numbered', text: 'Numbered lists' },
          { id: makeId('bk'), type: 'quote', text: '“The best way out is always through.”' },
          { id: makeId('bk'), type: 'divider' },
          { id: makeId('bk'), type: 'code', text: 'console.log("hello from Decks")' },
          { id: makeId('bk'), type: 'paragraph', text: '' }
        ]
      }
    ]
  }
}

export class NotesClient implements ProviderClient {
  readonly id: ProviderId = ID

  // ── Store ──────────────────────────────────────────────────────────────

  /** Secure-store key for one workspace blob. */
  private key(accountId: string): string {
    return accountKey(this.id, accountId)
  }

  /** Read + sanitize one workspace, or a seeded starter when none exists. */
  private readWorkspace(accountId: string): Workspace {
    const raw = getToken(this.key(accountId))
    if (!raw) return seededWorkspace()
    try {
      const parsed = JSON.parse(raw) as unknown
      const ws = this.sanitizeWorkspace(parsed)
      // An empty workspace shouldn't strand the user on a blank screen.
      return ws.pages.length > 0 ? ws : seededWorkspace()
    } catch {
      return seededWorkspace()
    }
  }

  /** Persist one workspace blob (sanitized). */
  private writeWorkspace(accountId: string, ws: Workspace): void {
    saveToken(this.key(accountId), JSON.stringify(this.sanitizeWorkspace(ws)))
  }

  // ── Sanitizers (never trust the blob or renderer params) ─────────────────

  private sanitizeWorkspace(input: unknown): Workspace {
    const pagesIn =
      input && typeof input === 'object' && Array.isArray((input as Workspace).pages)
        ? (input as Workspace).pages
        : []
    const pages = pagesIn
      .map((p) => this.sanitizePage(p))
      .filter((p): p is Page => p !== null)
    return { pages }
  }

  private sanitizePage(input: unknown): Page | null {
    if (!input || typeof input !== 'object') return null
    const p = input as Partial<Page>
    const id = typeof p.id === 'string' && p.id ? p.id : makeId('pg')
    const blocksIn = Array.isArray(p.blocks) ? p.blocks : []
    const blocks = blocksIn
      .map((b) => this.sanitizeBlock(b))
      .filter((b): b is Block => b !== null)
    return {
      id,
      title: typeof p.title === 'string' ? p.title : '',
      icon: typeof p.icon === 'string' ? p.icon : undefined,
      parentId: typeof p.parentId === 'string' ? p.parentId : null,
      blocks,
      updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : Date.now()
    }
  }

  private sanitizeBlock(input: unknown): Block | null {
    if (!input || typeof input !== 'object') return null
    const b = input as Partial<Block>
    const id = typeof b.id === 'string' && b.id ? b.id : makeId('bk')
    const type: BlockType = BLOCK_TYPES.includes(b.type as BlockType)
      ? (b.type as BlockType)
      : 'paragraph'
    const block: Block = { id, type }
    if (typeof b.text === 'string') block.text = b.text
    if (typeof b.checked === 'boolean') block.checked = b.checked
    if (Array.isArray(b.items)) {
      block.items = b.items.filter((i): i is string => typeof i === 'string')
    }
    if (typeof b.level === 'number') block.level = b.level
    return block
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  async connect(opts: {
    accountId: string
    mode: 'token' | 'oauth'
    token?: string
    fields?: Record<string, string>
  }): Promise<ProviderStatus> {
    const { accountId } = opts

    // Seed a starter workspace on first connect so 'load' always has content.
    if (!getToken(this.key(accountId))) {
      this.writeWorkspace(accountId, seededWorkspace())
    }

    const label = opts.fields?.label?.trim() || 'Notes'
    upsertAccount(this.id, { id: accountId, label })

    // Notes needs no auth — always "connected".
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
      account: entry?.label ?? 'Notes'
    }
  }

  /** List this provider's connected workspaces (for the Settings UI). */
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
      case 'save':
        return this.save(accountId, params?.data)

      case 'load':
      default:
        return this.readWorkspace(accountId)
    }
  }

  /** Persist the whole workspace JSON handed up from the editor. */
  private save(accountId: string, data: unknown): { ok: true } {
    const ws = this.sanitizeWorkspace(data)
    this.writeWorkspace(accountId, ws)
    return { ok: true }
  }
}
