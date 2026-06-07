/**
 * Decks — Notes native deck (renderer process).
 *
 * A fast, local, Notion-style block editor. There is NO network and NO auth: the
 * whole workspace ({ pages: Page[] }) is loaded on mount via the 'notes' provider
 * ('load') and autosaved back ('save') on a ~600ms debounce. The provider owns
 * persistence (an OS-encrypted JSON blob on this machine) — this component never
 * touches disk or localStorage and scopes every fetch to `props.accountId`.
 *
 * Layout: a left PAGE LIST (create / nest / rename / delete, with emoji icons) +
 * a main EDITOR (title + a column of blocks). Blocks are controlled <textarea>s so
 * editing is robust across IME/paste; we drive keyboard interactions (Enter to add,
 * Backspace-at-start to delete/merge, Up/Down to move focus, "/" for the slash
 * menu, "+" to add) on top of that.
 *
 * Styling mirrors the app's dark futuristic theme (bg / txt / line / accent
 * tokens, rounded-xl2).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX, KeyboardEvent, ReactNode } from 'react'
import type { NativeDeckProps } from '../types'
import { pageToHtml, workspaceToHtml, safeFileName } from './notesExport'

// ── Model (mirrors src/main/providers/notes.ts) ────────────────────────────

type BlockType =
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

interface Block {
  id: string
  type: BlockType
  text?: string
  checked?: boolean
  items?: string[]
  level?: number
}

interface Page {
  id: string
  title: string
  icon?: string
  parentId: string | null
  blocks: Block[]
  updatedAt: number
}

interface Workspace {
  pages: Page[]
}

type SaveState = 'idle' | 'pending' | 'saved'

// ── Block-type catalog (slash menu + handle menu) ──────────────────────────

interface BlockTypeDef {
  type: BlockType
  label: string
  hint: string
  /** Keywords to match in the slash menu. */
  keys: string[]
}

const BLOCK_TYPE_DEFS: BlockTypeDef[] = [
  { type: 'paragraph', label: 'Text', hint: 'Plain paragraph', keys: ['text', 'paragraph', 'p'] },
  { type: 'h1', label: 'Heading 1', hint: 'Large heading', keys: ['h1', 'heading', 'title'] },
  { type: 'h2', label: 'Heading 2', hint: 'Medium heading', keys: ['h2', 'heading'] },
  { type: 'h3', label: 'Heading 3', hint: 'Small heading', keys: ['h3', 'heading'] },
  { type: 'todo', label: 'To-do', hint: 'Checkbox item', keys: ['todo', 'task', 'check', 'box'] },
  { type: 'bulleted', label: 'Bulleted list', hint: 'Unordered list', keys: ['bullet', 'list', 'ul'] },
  { type: 'numbered', label: 'Numbered list', hint: 'Ordered list', keys: ['number', 'list', 'ol'] },
  { type: 'quote', label: 'Quote', hint: 'Block quote', keys: ['quote', 'blockquote'] },
  { type: 'callout', label: 'Callout', hint: 'Highlighted note', keys: ['callout', 'note', 'info'] },
  { type: 'code', label: 'Code', hint: 'Monospaced block', keys: ['code', 'snippet'] },
  { type: 'divider', label: 'Divider', hint: 'Horizontal rule', keys: ['divider', 'hr', 'line'] }
]

const PAGE_EMOJIS = [
  '📄', '📝', '📌', '📚', '💡', '🎯', '🚀', '🔥', '⭐', '✅',
  '🗂️', '🧠', '📅', '💬', '🎨', '🔬', '🏷️', '📊', '🌱', '👋'
]

// ── Helpers ────────────────────────────────────────────────────────────────

function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function emptyBlock(type: BlockType = 'paragraph'): Block {
  const b: Block = { id: makeId('bk'), type }
  if (type !== 'divider') b.text = ''
  if (type === 'todo') b.checked = false
  return b
}

/** Thin wrapper around the provider IPC, scoped to one workspace account. */
async function notesFetch<T>(
  provider: NativeDeckProps['provider'],
  accountId: string,
  resource: string,
  params?: Record<string, unknown>
): Promise<T> {
  const result = await window.decks?.provider.fetch({ provider, accountId, resource, params })
  return result as T
}

// ── Component ───────────────────────────────────────────────────────────────

function NotesDeck({ provider, accountId }: NativeDeckProps): JSX.Element {
  const [pages, setPages] = useState<Page[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [pickerFor, setPickerFor] = useState<string | null>(null)

  // Slash menu: which block opened it + the query typed after "/" + highlighted row.
  const [slash, setSlash] = useState<{
    blockId: string
    query: string
    index: number
  } | null>(null)
  // Handle "+" menu open for a given block.
  const [handleMenu, setHandleMenu] = useState<string | null>(null)

  // Mirror of pages used by the debounced save so we always persist the latest.
  const latest = useRef<Page[]>([])
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dirty = useRef(false)
  // Block id that should grab focus after the next render.
  const focusNext = useRef<string | null>(null)
  const blockRefs = useRef<Map<string, HTMLTextAreaElement>>(new Map())

  latest.current = pages

  // ── Load on mount ──────────────────────────────────────────────────────

  useEffect(() => {
    let alive = true
    void (async () => {
      setLoading(true)
      try {
        const ws = await notesFetch<Workspace>(provider, accountId, 'load')
        const loaded = Array.isArray(ws?.pages) ? ws.pages : []
        if (!alive) return
        setPages(loaded)
        setActiveId(loaded[0]?.id ?? null)
      } catch {
        if (alive) {
          setPages([])
          setActiveId(null)
        }
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [provider, accountId])

  // ── Autosave (debounced ~600ms) ────────────────────────────────────────

  const flushSave = useCallback(async (): Promise<void> => {
    if (!dirty.current) return
    dirty.current = false
    try {
      await notesFetch(provider, accountId, 'save', { data: { pages: latest.current } })
      setSaveState('saved')
      if (savedTimer.current) clearTimeout(savedTimer.current)
      savedTimer.current = setTimeout(() => setSaveState('idle'), 1600)
    } catch {
      // Leave it dirty-ish: a later edit will retry the save.
      setSaveState('idle')
    }
  }, [provider, accountId])

  const scheduleSave = useCallback((): void => {
    dirty.current = true
    setSaveState('pending')
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => void flushSave(), 600)
  }, [flushSave])

  // Flush any pending save on unmount.
  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
      if (savedTimer.current) clearTimeout(savedTimer.current)
      void flushSave()
    }
  }, [flushSave])

  // ── Focus management ────────────────────────────────────────────────────

  useEffect(() => {
    if (!focusNext.current) return
    const el = blockRefs.current.get(focusNext.current)
    if (el) {
      el.focus()
      const end = el.value.length
      el.setSelectionRange(end, end)
    }
    focusNext.current = null
  })

  const registerRef = useCallback(
    (id: string) =>
      (el: HTMLTextAreaElement | null): void => {
        if (el) blockRefs.current.set(id, el)
        else blockRefs.current.delete(id)
      },
    []
  )

  // ── Derived ─────────────────────────────────────────────────────────────

  const activePage = useMemo(
    () => pages.find((p) => p.id === activeId) ?? null,
    [pages, activeId]
  )

  /** Pages grouped for a simple two-level tree (root pages + their children). */
  const tree = useMemo(() => {
    const roots = pages.filter((p) => !p.parentId)
    const childrenOf = (id: string): Page[] => pages.filter((p) => p.parentId === id)
    return { roots, childrenOf }
  }, [pages])

  // ── Mutations ────────────────────────────────────────────────────────────

  const mutatePages = useCallback(
    (next: Page[]): void => {
      setPages(next)
      scheduleSave()
    },
    [scheduleSave]
  )

  const touchPage = (page: Page): Page => ({ ...page, updatedAt: Date.now() })

  const updateActive = useCallback(
    (updater: (page: Page) => Page): void => {
      if (!activeId) return
      mutatePages(
        latest.current.map((p) => (p.id === activeId ? touchPage(updater(p)) : p))
      )
    },
    [activeId, mutatePages]
  )

  // Pages ------------------------------------------------------------------

  const createPage = useCallback(
    (parentId: string | null = null): void => {
      const page: Page = {
        id: makeId('pg'),
        title: '',
        icon: PAGE_EMOJIS[Math.floor(Math.random() * PAGE_EMOJIS.length)],
        parentId,
        blocks: [emptyBlock('paragraph')],
        updatedAt: Date.now()
      }
      mutatePages([...latest.current, page])
      setActiveId(page.id)
      setRenamingId(page.id)
    },
    [mutatePages]
  )

  const deletePage = useCallback(
    (id: string): void => {
      // Remove the page and any descendants (two-level tree, so direct children).
      const removeIds = new Set<string>([id])
      for (const p of latest.current) {
        if (p.parentId && removeIds.has(p.parentId)) removeIds.add(p.id)
      }
      const next = latest.current.filter((p) => !removeIds.has(p.id))
      mutatePages(next)
      if (activeId && removeIds.has(activeId)) {
        setActiveId(next[0]?.id ?? null)
      }
    },
    [activeId, mutatePages]
  )

  const renamePage = useCallback(
    (id: string, title: string): void => {
      mutatePages(latest.current.map((p) => (p.id === id ? touchPage({ ...p, title }) : p)))
    },
    [mutatePages]
  )

  const setPageIcon = useCallback(
    (id: string, icon: string): void => {
      mutatePages(latest.current.map((p) => (p.id === id ? touchPage({ ...p, icon }) : p)))
      setPickerFor(null)
    },
    [mutatePages]
  )

  // Export -----------------------------------------------------------------

  const exportPage = useCallback(
    async (page: Page): Promise<void> => {
      const html = pageToHtml(page)
      const name = `${safeFileName(page.title)}.html`
      await window.decks?.file.save({
        defaultName: name,
        contents: html,
        title: 'Export note',
        filters: [{ name: 'HTML Document', extensions: ['html'] }]
      })
    },
    []
  )

  const exportWorkspace = useCallback(async (): Promise<void> => {
    // Export every page in document order (roots, each followed by its children).
    const all = latest.current
    const roots = all.filter((p) => !p.parentId)
    const ordered: Page[] = []
    for (const r of roots) {
      ordered.push(r)
      for (const c of all.filter((p) => p.parentId === r.id)) ordered.push(c)
    }
    // Include any orphans (parent missing) so nothing is silently dropped.
    for (const p of all) if (!ordered.includes(p)) ordered.push(p)
    const html = workspaceToHtml(ordered, 'Notes')
    await window.decks?.file.save({
      defaultName: 'notes-workspace.html',
      contents: html,
      title: 'Export all notes',
      filters: [{ name: 'HTML Document', extensions: ['html'] }]
    })
  }, [])

  // Blocks -----------------------------------------------------------------

  const updateBlock = useCallback(
    (blockId: string, patch: Partial<Block>): void => {
      updateActive((page) => ({
        ...page,
        blocks: page.blocks.map((b) => (b.id === blockId ? { ...b, ...patch } : b))
      }))
    },
    [updateActive]
  )

  const setBlockType = useCallback(
    (blockId: string, type: BlockType): void => {
      updateActive((page) => ({
        ...page,
        blocks: page.blocks.map((b) => {
          if (b.id !== blockId) return b
          const next: Block = { id: b.id, type }
          if (type !== 'divider') next.text = b.text ?? ''
          if (type === 'todo') next.checked = b.checked ?? false
          return next
        })
      }))
      if (type !== 'divider') focusNext.current = blockId
    },
    [updateActive]
  )

  const insertBlockAfter = useCallback(
    (blockId: string, type: BlockType = 'paragraph'): string => {
      const created = emptyBlock(type)
      updateActive((page) => {
        const idx = page.blocks.findIndex((b) => b.id === blockId)
        const blocks = [...page.blocks]
        blocks.splice(idx + 1, 0, created)
        return { ...page, blocks }
      })
      focusNext.current = created.id
      return created.id
    },
    [updateActive]
  )

  const removeBlock = useCallback(
    (blockId: string, focusPrev = true): void => {
      updateActive((page) => {
        if (page.blocks.length <= 1) {
          // Never leave a page with zero blocks.
          return { ...page, blocks: [emptyBlock('paragraph')] }
        }
        const idx = page.blocks.findIndex((b) => b.id === blockId)
        const blocks = page.blocks.filter((b) => b.id !== blockId)
        if (focusPrev) {
          const target = blocks[Math.max(0, idx - 1)]
          if (target) focusNext.current = target.id
        }
        return { ...page, blocks }
      })
    },
    [updateActive]
  )

  const moveFocus = useCallback(
    (blockId: string, dir: -1 | 1): void => {
      if (!activePage) return
      const idx = activePage.blocks.findIndex((b) => b.id === blockId)
      const target = activePage.blocks[idx + dir]
      if (target) {
        const el = blockRefs.current.get(target.id)
        el?.focus()
        if (el) {
          const end = el.value.length
          el.setSelectionRange(end, end)
        }
      }
    },
    [activePage]
  )

  // ── Slash menu ────────────────────────────────────────────────────────

  const slashMatches = useMemo(() => {
    if (!slash) return []
    const q = slash.query.trim().toLowerCase()
    if (!q) return BLOCK_TYPE_DEFS
    return BLOCK_TYPE_DEFS.filter(
      (d) =>
        d.label.toLowerCase().includes(q) || d.keys.some((k) => k.includes(q))
    )
  }, [slash])

  // Highlight index clamped to the current match list (matches shrink as you type).
  const slashIndex = slash ? Math.min(slash.index, Math.max(0, slashMatches.length - 1)) : 0

  const applySlash = useCallback(
    (blockId: string, type: BlockType): void => {
      // Convert the block AND clear the captured "/query" text in a SINGLE
      // atomic update. (Doing this as two separate setState calls reads a stale
      // `latest.current` for the second one, so the "/query" text would survive.)
      updateActive((page) => ({
        ...page,
        blocks: page.blocks.map((b) => {
          if (b.id !== blockId) return b
          const next: Block = { id: b.id, type }
          if (type !== 'divider') next.text = ''
          if (type === 'todo') next.checked = false
          return next
        })
      }))
      if (type !== 'divider') focusNext.current = blockId
      setSlash(null)
    },
    [updateActive]
  )

  // ── Per-block keyboard handling ──────────────────────────────────────────

  const onBlockKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>, block: Block): void => {
      const el = e.currentTarget
      const atStart = el.selectionStart === 0 && el.selectionEnd === 0
      const atEnd = el.selectionStart === el.value.length && el.selectionEnd === el.value.length

      // Slash menu navigation takes precedence while it's open: Arrow keys move
      // the highlight, Enter/Tab pick it, Escape closes. None of these should
      // fall through to the block's own newline / focus-move handling.
      if (slash && slash.blockId === block.id) {
        if (e.key === 'Escape') {
          e.preventDefault()
          setSlash(null)
          return
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          if (slashMatches.length > 0) {
            setSlash((s) =>
              s ? { ...s, index: (slashIndex + 1) % slashMatches.length } : s
            )
          }
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          if (slashMatches.length > 0) {
            setSlash((s) =>
              s
                ? { ...s, index: (slashIndex - 1 + slashMatches.length) % slashMatches.length }
                : s
            )
          }
          return
        }
        if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) {
          e.preventDefault()
          if (slashMatches.length > 0) applySlash(block.id, slashMatches[slashIndex].type)
          return
        }
      }

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        if (slash && slash.blockId === block.id) return
        insertBlockAfter(block.id, 'paragraph')
        return
      }

      if (e.key === 'Backspace' && atStart && !el.value) {
        e.preventDefault()
        if (slash && slash.blockId === block.id) setSlash(null)
        removeBlock(block.id, true)
        return
      }

      if (e.key === 'ArrowUp' && atStart) {
        e.preventDefault()
        moveFocus(block.id, -1)
        return
      }

      if (e.key === 'ArrowDown' && atEnd) {
        e.preventDefault()
        moveFocus(block.id, 1)
        return
      }
    },
    [slash, slashMatches, slashIndex, applySlash, insertBlockAfter, removeBlock, moveFocus]
  )

  const onBlockChange = useCallback(
    (block: Block, value: string): void => {
      updateBlock(block.id, { text: value })
      // Open the slash menu when the line is exactly "/…" with no spaces. Reset
      // the highlight to the top whenever the query changes so the first match
      // is selected by default.
      if (value.startsWith('/') && !value.includes(' ')) {
        const query = value.slice(1)
        setSlash((s) =>
          s && s.blockId === block.id && s.query === query
            ? s
            : { blockId: block.id, query, index: 0 }
        )
      } else if (slash && slash.blockId === block.id) {
        setSlash(null)
      }
    },
    [updateBlock, slash]
  )

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <div className="flex h-full w-full overflow-hidden bg-bg text-txt-1">
      {/* ── Page list ── */}
      <aside className="flex w-56 shrink-0 flex-col border-r border-line bg-bg-panel">
        <div className="flex items-center justify-between px-3 pt-3 pb-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-txt-3">
            Pages
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => void exportWorkspace()}
              title="Export all pages to an HTML file"
              disabled={pages.length === 0}
              className="grid h-6 w-6 place-items-center rounded-lg border border-line text-txt-2 transition-colors hover:border-accent hover:text-accent disabled:cursor-default disabled:opacity-40"
            >
              {/* download / export glyph */}
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
            </button>
            <button
              onClick={() => createPage(null)}
              title="New page"
              className="grid h-6 w-6 place-items-center rounded-lg border border-line text-txt-2 transition-colors hover:border-accent hover:text-accent"
            >
              +
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {tree.roots.length === 0 ? (
            <button
              onClick={() => createPage(null)}
              className="mt-2 w-full rounded-lg border border-dashed border-line px-3 py-6 text-center text-xs text-txt-3 transition-colors hover:border-accent hover:text-accent"
            >
              Create your first page
            </button>
          ) : (
            tree.roots.map((page) => (
              <PageRow
                key={page.id}
                page={page}
                depth={0}
                active={page.id === activeId}
                renaming={renamingId === page.id}
                onSelect={() => setActiveId(page.id)}
                onStartRename={() => setRenamingId(page.id)}
                onRename={(t) => renamePage(page.id, t)}
                onEndRename={() => setRenamingId(null)}
                onDelete={() => deletePage(page.id)}
                onAddChild={() => createPage(page.id)}
              >
                {tree.childrenOf(page.id).map((child) => (
                  <PageRow
                    key={child.id}
                    page={child}
                    depth={1}
                    active={child.id === activeId}
                    renaming={renamingId === child.id}
                    onSelect={() => setActiveId(child.id)}
                    onStartRename={() => setRenamingId(child.id)}
                    onRename={(t) => renamePage(child.id, t)}
                    onEndRename={() => setRenamingId(null)}
                    onDelete={() => deletePage(child.id)}
                    onAddChild={() => createPage(child.id)}
                  />
                ))}
              </PageRow>
            ))
          )}
        </div>
      </aside>

      {/* ── Editor ── */}
      <main className="relative flex min-w-0 flex-1 flex-col">
        {/* Save indicator + per-page export */}
        <div className="absolute right-3 top-2 z-10 flex items-center gap-2 text-[11px] tabular-nums">
          {saveState === 'pending' && <span className="text-txt-4">Saving…</span>}
          {saveState === 'saved' && <span className="text-ok">Saved</span>}
          {activePage && (
            <button
              onClick={() => activePage && void exportPage(activePage)}
              title="Export this page to an HTML file (opens identically in any browser)"
              className="flex items-center gap-1 rounded-lg border border-line bg-bg-elevated px-2 py-1 text-[11px] font-medium text-txt-2 transition-colors hover:border-accent hover:text-accent"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              Export
            </button>
          )}
        </div>

        {loading ? (
          <div className="grid h-full place-items-center text-sm text-txt-3">Loading…</div>
        ) : !activePage ? (
          <div className="grid h-full place-items-center p-6 text-center">
            <div className="max-w-xs">
              <p className="text-sm font-medium text-txt-1">No page selected</p>
              <p className="mt-1 text-xs leading-relaxed text-txt-3">
                Create a page on the left to start writing.
              </p>
              <button
                onClick={() => createPage(null)}
                className="mt-4 rounded-lg border border-line bg-bg-elevated px-3 py-1.5 text-sm font-medium text-txt-1 transition-colors hover:border-accent hover:text-accent"
              >
                New page
              </button>
            </div>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-3xl px-10 py-10">
              {/* Page header: icon + title */}
              <div className="relative mb-6 flex items-start gap-3">
                <button
                  onClick={() =>
                    setPickerFor(pickerFor === activePage.id ? null : activePage.id)
                  }
                  className="grid h-12 w-12 shrink-0 place-items-center rounded-xl2 text-3xl transition-colors hover:bg-bg-elevated"
                  title="Change icon"
                >
                  {activePage.icon || '📄'}
                </button>

                {pickerFor === activePage.id && (
                  <div className="absolute left-0 top-14 z-20 grid w-64 grid-cols-8 gap-1 rounded-xl2 border border-line bg-bg-elevated p-2 shadow-2xl">
                    {PAGE_EMOJIS.map((emoji) => (
                      <button
                        key={emoji}
                        onClick={() => setPageIcon(activePage.id, emoji)}
                        className="grid h-7 w-7 place-items-center rounded-lg text-lg transition-colors hover:bg-bg-panel"
                      >
                        {emoji}
                      </button>
                    ))}
                  </div>
                )}

                <textarea
                  value={activePage.title}
                  onChange={(e) => renamePage(activePage.id, e.target.value)}
                  placeholder="Untitled"
                  rows={1}
                  spellCheck={false}
                  className="mt-1 min-h-0 flex-1 resize-none bg-transparent text-3xl font-bold leading-tight text-txt-1 placeholder:text-txt-4 outline-none"
                  onInput={(e) => {
                    const t = e.currentTarget
                    t.style.height = 'auto'
                    t.style.height = `${t.scrollHeight}px`
                  }}
                />
              </div>

              {/* Blocks */}
              <div className="space-y-0.5">
                {activePage.blocks.map((block) => (
                  <BlockRow
                    key={block.id}
                    block={block}
                    refCb={registerRef(block.id)}
                    onChange={(v) => onBlockChange(block, v)}
                    onKeyDown={(e) => onBlockKeyDown(e, block)}
                    onToggleCheck={() => updateBlock(block.id, { checked: !block.checked })}
                    onAddBelow={() => insertBlockAfter(block.id, 'paragraph')}
                    onOpenHandleMenu={() =>
                      setHandleMenu(handleMenu === block.id ? null : block.id)
                    }
                    handleMenuOpen={handleMenu === block.id}
                    onPickType={(type) => {
                      setBlockType(block.id, type)
                      setHandleMenu(null)
                    }}
                    onDelete={() => {
                      removeBlock(block.id)
                      setHandleMenu(null)
                    }}
                    slashOpen={slash?.blockId === block.id}
                    slashMatches={slash?.blockId === block.id ? slashMatches : []}
                    slashIndex={slash?.blockId === block.id ? slashIndex : 0}
                    onPickSlash={(type) => applySlash(block.id, type)}
                  />
                ))}
              </div>

              {/* Click-to-add tail */}
              <button
                onClick={() => {
                  const last = activePage.blocks[activePage.blocks.length - 1]
                  if (last) insertBlockAfter(last.id, 'paragraph')
                }}
                className="mt-2 w-full rounded-lg py-2 text-left text-sm text-txt-4 transition-colors hover:text-txt-3"
              >
                + Click to add a block
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}

// ── Page row (sidebar) ──────────────────────────────────────────────────────

interface PageRowProps {
  page: Page
  depth: number
  active: boolean
  renaming: boolean
  onSelect: () => void
  onStartRename: () => void
  onRename: (title: string) => void
  onEndRename: () => void
  onDelete: () => void
  onAddChild: () => void
  children?: ReactNode
}

function PageRow(props: PageRowProps): JSX.Element {
  const {
    page,
    depth,
    active,
    renaming,
    onSelect,
    onStartRename,
    onRename,
    onEndRename,
    onDelete,
    onAddChild,
    children
  } = props

  return (
    <div>
      <div
        className={`group flex items-center gap-1 rounded-lg pr-1 ${
          active ? 'bg-accent-soft text-txt-1' : 'text-txt-2 hover:bg-bg-elevated'
        }`}
        style={{ paddingLeft: `${6 + depth * 14}px` }}
      >
        <button
          onClick={onSelect}
          onDoubleClick={onStartRename}
          className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left"
        >
          <span className="shrink-0 text-sm leading-none">{page.icon || '📄'}</span>
          {renaming ? (
            <input
              autoFocus
              defaultValue={page.title}
              onBlur={(e) => {
                onRename(e.target.value)
                onEndRename()
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  onRename(e.currentTarget.value)
                  onEndRename()
                } else if (e.key === 'Escape') {
                  onEndRename()
                }
              }}
              className="min-w-0 flex-1 rounded border border-accent-ring bg-bg px-1 py-0.5 text-sm text-txt-1 outline-none"
            />
          ) : (
            <span className="min-w-0 flex-1 truncate text-sm">
              {page.title || 'Untitled'}
            </span>
          )}
        </button>

        {!renaming && (
          <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100">
            {depth === 0 && (
              <button
                onClick={onAddChild}
                title="Add subpage"
                className="grid h-5 w-5 place-items-center rounded text-txt-3 hover:bg-bg-panel hover:text-accent"
              >
                +
              </button>
            )}
            <button
              onClick={onDelete}
              title="Delete page"
              className="grid h-5 w-5 place-items-center rounded text-txt-3 hover:bg-bg-panel hover:text-err"
            >
              ×
            </button>
          </div>
        )}
      </div>
      {children}
    </div>
  )
}

// ── Block row (editor) ──────────────────────────────────────────────────────

interface BlockRowProps {
  block: Block
  refCb: (el: HTMLTextAreaElement | null) => void
  onChange: (value: string) => void
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void
  onToggleCheck: () => void
  onAddBelow: () => void
  onOpenHandleMenu: () => void
  handleMenuOpen: boolean
  onPickType: (type: BlockType) => void
  onDelete: () => void
  slashOpen: boolean
  slashMatches: BlockTypeDef[]
  slashIndex: number
  onPickSlash: (type: BlockType) => void
}

/** Tailwind classes for a block's textarea by type. */
function blockTextClass(type: BlockType): string {
  switch (type) {
    case 'h1':
      return 'text-2xl font-bold text-txt-1'
    case 'h2':
      return 'text-xl font-bold text-txt-1'
    case 'h3':
      return 'text-lg font-semibold text-txt-1'
    case 'quote':
      return 'text-base italic text-txt-2'
    case 'callout':
      return 'text-sm text-txt-1'
    case 'code':
      return 'font-mono text-[13px] text-txt-1'
    default:
      return 'text-[15px] text-txt-1'
  }
}

function blockPlaceholder(type: BlockType): string {
  switch (type) {
    case 'h1':
      return 'Heading 1'
    case 'h2':
      return 'Heading 2'
    case 'h3':
      return 'Heading 3'
    case 'todo':
      return 'To-do'
    case 'bulleted':
    case 'numbered':
      return 'List item'
    case 'quote':
      return 'Quote'
    case 'callout':
      return 'Callout'
    case 'code':
      return 'Code'
    default:
      return "Type '/' for commands"
  }
}

function autoGrow(el: HTMLTextAreaElement): void {
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}

function BlockRow(props: BlockRowProps): JSX.Element {
  const {
    block,
    refCb,
    onChange,
    onKeyDown,
    onToggleCheck,
    onAddBelow,
    onOpenHandleMenu,
    handleMenuOpen,
    onPickType,
    onDelete,
    slashOpen,
    slashMatches,
    slashIndex,
    onPickSlash
  } = props

  const setRef = useCallback(
    (el: HTMLTextAreaElement | null): void => {
      refCb(el)
      if (el) autoGrow(el)
    },
    [refCb]
  )

  if (block.type === 'divider') {
    return (
      <div className="group relative flex items-center">
        <BlockHandle
          onAdd={onAddBelow}
          onMenu={onOpenHandleMenu}
          menuOpen={handleMenuOpen}
          onPickType={onPickType}
          onDelete={onDelete}
        />
        <div className="my-2 h-px w-full bg-line" />
      </div>
    )
  }

  // Wrapper styling per block type (the leading marker + container chrome).
  const isCallout = block.type === 'callout'
  const isQuote = block.type === 'quote'
  const isCode = block.type === 'code'

  return (
    <div className="group relative flex items-start">
      <BlockHandle
        onAdd={onAddBelow}
        onMenu={onOpenHandleMenu}
        menuOpen={handleMenuOpen}
        onPickType={onPickType}
        onDelete={onDelete}
      />

      <div
        className={`flex w-full items-start gap-2 rounded-lg ${
          isCallout ? 'border border-line bg-accent-soft px-3 py-2' : ''
        } ${isQuote ? 'border-l-2 border-accent pl-3' : ''} ${
          isCode ? 'bg-bg-elevated px-3 py-2' : ''
        }`}
      >
        {/* Leading marker */}
        {block.type === 'todo' && (
          <button
            onClick={onToggleCheck}
            className={`mt-[3px] grid h-[18px] w-[18px] shrink-0 place-items-center rounded border transition-colors ${
              block.checked
                ? 'border-accent bg-accent text-bg'
                : 'border-txt-3 text-transparent hover:border-accent'
            }`}
          >
            {block.checked ? '✓' : ''}
          </button>
        )}
        {block.type === 'bulleted' && (
          <span className="mt-[7px] shrink-0 text-txt-2 leading-none">•</span>
        )}
        {block.type === 'numbered' && (
          <span className="mt-1 shrink-0 text-sm text-txt-2 leading-none">•</span>
        )}
        {isCallout && <span className="mt-px shrink-0 text-base leading-none">💡</span>}

        <textarea
          ref={setRef}
          value={block.text ?? ''}
          onChange={(e) => {
            autoGrow(e.currentTarget)
            onChange(e.target.value)
          }}
          onKeyDown={onKeyDown}
          rows={1}
          spellCheck={!isCode}
          placeholder={blockPlaceholder(block.type)}
          className={`min-h-0 w-full resize-none break-words bg-transparent leading-relaxed outline-none placeholder:text-txt-4 ${blockTextClass(
            block.type
          )} ${block.type === 'todo' && block.checked ? 'text-txt-3 line-through' : ''}`}
        />
      </div>

      {/* Slash menu */}
      {slashOpen && (
        <div className="absolute left-8 top-7 z-30 max-h-64 w-60 overflow-y-auto rounded-xl2 border border-line bg-bg-elevated p-1 shadow-2xl">
          {slashMatches.length === 0 ? (
            <div className="px-3 py-2 text-xs text-txt-4">No matches</div>
          ) : (
            slashMatches.map((d, i) => (
              <button
                key={d.type}
                ref={(el) => {
                  if (el && i === slashIndex) el.scrollIntoView({ block: 'nearest' })
                }}
                onMouseDown={(e) => {
                  // mousedown (not click) so the textarea doesn't blur first.
                  e.preventDefault()
                  onPickSlash(d.type)
                }}
                className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-1.5 text-left transition-colors hover:bg-bg-panel ${
                  i === slashIndex ? 'bg-bg-panel' : ''
                }`}
              >
                <span className="text-sm text-txt-1">{d.label}</span>
                <span className="text-[11px] text-txt-4">{d.hint}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}

// ── Block hover handle (+ / convert menu) ────────────────────────────────────

interface BlockHandleProps {
  onAdd: () => void
  onMenu: () => void
  menuOpen: boolean
  onPickType: (type: BlockType) => void
  onDelete: () => void
}

function BlockHandle(props: BlockHandleProps): JSX.Element {
  const { onAdd, onMenu, menuOpen, onPickType, onDelete } = props
  return (
    <div className="relative -ml-7 flex w-7 shrink-0 items-center justify-center pt-1 opacity-0 transition-opacity group-hover:opacity-100">
      <div className="flex flex-col items-center">
        <button
          onClick={onAdd}
          title="Add block below"
          className="grid h-5 w-4 place-items-center rounded text-txt-3 hover:bg-bg-elevated hover:text-accent"
        >
          +
        </button>
        <button
          onClick={onMenu}
          title="Turn into / delete"
          className="grid h-5 w-4 place-items-center rounded text-txt-3 hover:bg-bg-elevated hover:text-txt-1"
        >
          ⋮
        </button>
      </div>

      {menuOpen && (
        <div className="absolute left-5 top-0 z-30 max-h-72 w-52 overflow-y-auto rounded-xl2 border border-line bg-bg-elevated p-1 shadow-2xl">
          <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-txt-4">
            Turn into
          </div>
          {BLOCK_TYPE_DEFS.map((d) => (
            <button
              key={d.type}
              onClick={() => onPickType(d.type)}
              className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-1.5 text-left transition-colors hover:bg-bg-panel"
            >
              <span className="text-sm text-txt-1">{d.label}</span>
            </button>
          ))}
          <div className="my-1 h-px bg-line" />
          <button
            onClick={onDelete}
            className="flex w-full items-center rounded-lg px-3 py-1.5 text-left text-sm text-err transition-colors hover:bg-bg-panel"
          >
            Delete block
          </button>
        </div>
      )}
    </div>
  )
}

export default NotesDeck
