/**
 * CommandPalette — the Cmd+K overlay (Phase 1, Palette agent).
 *
 * A centered, Chrome-simple overlay shown when `useStore().paletteOpen`. Fuzzy
 * searches a combined CommandItem[] of workspaces + pinned sites + commands
 * (assembled by usePaletteItems), ranks them with fuzzy.ts, and runs the chosen
 * item. The global ⌘K/Esc keys are owned by App.tsx; this component only handles
 * keys WHILE open (Up/Down/Enter) and closes via closePalette.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CommandItem } from '@shared/types'
import { useStore } from '../store'
import { fuzzyScore } from './palette/fuzzy'
import { usePaletteItems } from './palette/usePaletteItems'
import { useHideViewsWhile } from '../lib/useOverlay'

const KIND_LABEL: Record<CommandItem['kind'], string> = {
  workspace: 'Workspace',
  'pinned-site': 'Site',
  command: 'Command'
}

function CommandPalette(): JSX.Element | null {
  const open = useStore((s) => s.paletteOpen)
  const close = useStore((s) => s.closePalette)
  const { items, run } = usePaletteItems()
  useHideViewsWhile(open)

  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  // Reset query + selection every time the palette opens.
  useEffect(() => {
    if (open) {
      setQuery('')
      setSelected(0)
    }
  }, [open])

  // Filter + rank. Empty query keeps source order; otherwise sort by score desc.
  const results = useMemo<CommandItem[]>(() => {
    const q = query.trim()
    if (!q) return items
    const scored: { item: CommandItem; score: number }[] = []
    for (const item of items) {
      const score = fuzzyScore(q, item.label)
      if (score !== null) scored.push({ item, score })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.map((s) => s.item)
  }, [items, query])

  // Keep selection in range as results change.
  useEffect(() => {
    setSelected((s) => (results.length === 0 ? 0 : Math.min(s, results.length - 1)))
  }, [results])

  // Scroll the selected row into view.
  useEffect(() => {
    const el = listRef.current?.children[selected] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  if (!open) return null

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (results.length) setSelected((s) => (s + 1) % results.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (results.length) setSelected((s) => (s - 1 + results.length) % results.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = results[selected]
      if (item) run(item)
    }
    // Esc is handled globally by App.tsx → closePalette.
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-32"
      onClick={close}
    >
      <div
        className="w-[min(560px,90vw)] overflow-hidden rounded-xl2 border border-line bg-bg-elevated shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Jump anywhere…"
          className="w-full bg-transparent px-4 py-3 text-sm text-txt-1 outline-none placeholder:text-txt-3"
        />
        <div ref={listRef} className="max-h-72 overflow-y-auto border-t border-line">
          {results.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-txt-3">No results</div>
          ) : (
            results.map((item, i) => {
              const active = i === selected
              return (
                <button
                  key={item.id}
                  type="button"
                  onMouseMove={() => setSelected(i)}
                  onClick={() => run(item)}
                  className={
                    'flex w-full items-center gap-3 px-4 py-2 text-left text-sm ' +
                    (active ? 'bg-accent-soft text-txt-1' : 'text-txt-2')
                  }
                >
                  <span className="w-5 shrink-0 text-center text-base leading-none">
                    {item.glyph}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.hint && (
                    <span className="shrink-0 text-xs text-txt-3">{item.hint}</span>
                  )}
                  <span
                    className={
                      'shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ' +
                      (active ? 'text-accent' : 'text-txt-4')
                    }
                  >
                    {KIND_LABEL[item.kind]}
                  </span>
                </button>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}

export default CommandPalette
