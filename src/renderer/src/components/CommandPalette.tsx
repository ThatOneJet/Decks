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
    const id = results[selected]?.id
    if (!id) return
    const el = listRef.current?.querySelector(`#palette-row-${CSS.escape(id)}`) as
      | HTMLElement
      | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [selected, results])

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
    <>
      <div className="scrim" onClick={close} />
      <div className="palette glass" onClick={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <div className="palette-search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <circle cx="11" cy="11" r="7" />
            <line x1="16.5" y1="16.5" x2="21" y2="21" strokeLinecap="round" />
          </svg>
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Jump anywhere…"
            role="combobox"
            aria-expanded={results.length > 0}
            aria-controls="palette-listbox"
            aria-activedescendant={results[selected] ? `palette-row-${results[selected].id}` : undefined}
          />
        </div>
        <div ref={listRef} id="palette-listbox" role="listbox" className="palette-list">
          {results.length === 0 ? (
            <div className="palette-sec">No results</div>
          ) : (
            results.map((item, i) => {
              const active = i === selected
              const newSection = i === 0 || results[i - 1].kind !== item.kind
              return (
                <div key={item.id} className="contents">
                  {newSection && <div className="palette-sec">{KIND_LABEL[item.kind]}</div>}
                  <button
                    type="button"
                    id={`palette-row-${item.id}`}
                    role="option"
                    aria-selected={active}
                    onMouseMove={() => setSelected(i)}
                    onClick={() => run(item)}
                    className={'palette-row' + (active ? ' sel' : '')}
                  >
                    <span className={'ic' + (item.kind === 'command' ? ' act' : '')}>
                      {item.glyph}
                    </span>
                    <div className="tx">
                      <div className="l">{item.label}</div>
                      {item.hint && <div className="d">{item.hint}</div>}
                    </div>
                    <span className="meta">{KIND_LABEL[item.kind]}</span>
                  </button>
                </div>
              )
            })
          )}
        </div>
      </div>
    </>
  )
}

export default CommandPalette
