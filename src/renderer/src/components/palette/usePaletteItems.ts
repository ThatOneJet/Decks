/**
 * usePaletteItems — assembles the Cmd+K candidate list and its `run` handlers.
 *
 * Three sources are combined into a single `CommandItem[]` (the shared shape):
 *   1. workspaces  (kind 'workspace')   — Enter → activateWorkspace(id)
 *   2. pinned sites (kind 'pinned-site') — Enter → create a panel in the active
 *      (or first) workspace via window.decks.panel.create + store.addPanel, then
 *      activate it. This is the seam Phase 2 may adjust.
 *   3. commands    (kind 'command')      — static actions (Go Home, Reload).
 *
 * Returns `{ items, run }` where `items` is the full unfiltered candidate list
 * and `run(item)` performs the item's action then closes the palette. Filtering
 * and ranking happen in the component (via fuzzy.ts).
 */
import { useMemo } from 'react'
import type { CommandItem } from '@shared/types'
import { useStore } from '../../store'

/** Hardcoded pinned sites. Each becomes a panel when chosen. */
export const PINNED_SITES: { id: string; label: string; url: string; glyph: string }[] = [
  { id: 'pin-claude', label: 'Claude', url: 'https://claude.ai', glyph: '✳' },
  { id: 'pin-github', label: 'GitHub', url: 'https://github.com', glyph: '🐙' },
  { id: 'pin-gmail', label: 'Gmail', url: 'https://mail.google.com', glyph: '✉' },
  { id: 'pin-youtube', label: 'YouTube', url: 'https://youtube.com', glyph: '▶' },
  { id: 'pin-mdn', label: 'MDN', url: 'https://developer.mozilla.org', glyph: '📘' },
  { id: 'pin-reddit', label: 'Reddit', url: 'https://reddit.com', glyph: '👽' },
  { id: 'pin-chatgpt', label: 'ChatGPT', url: 'https://chat.openai.com', glyph: '🤖' },
  { id: 'pin-stackoverflow', label: 'Stack Overflow', url: 'https://stackoverflow.com', glyph: '🧮' }
]

export interface UsePaletteItems {
  items: CommandItem[]
  run: (item: CommandItem) => void
}

export function usePaletteItems(): UsePaletteItems {
  const workspaces = useStore((s) => s.workspaces)
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const activateWorkspace = useStore((s) => s.activateWorkspace)
  const addPanel = useStore((s) => s.addPanel)
  const goHome = useStore((s) => s.goHome)
  const closePalette = useStore((s) => s.closePalette)

  const items = useMemo<CommandItem[]>(() => {
    const workspaceItems: CommandItem[] = workspaces.map((w) => ({
      id: `ws-${w.id}`,
      kind: 'workspace',
      label: w.name,
      hint: w.subtitle ?? 'workspace',
      value: w.id,
      glyph: w.glyph ?? '▦'
    }))

    const siteItems: CommandItem[] = PINNED_SITES.map((s) => ({
      id: s.id,
      kind: 'pinned-site',
      label: s.label,
      hint: 'open site',
      value: s.url,
      glyph: s.glyph
    }))

    const commandItems: CommandItem[] = [
      { id: 'cmd-home', kind: 'command', label: 'Go Home', hint: 'command', value: 'home', glyph: '⌂' },
      { id: 'cmd-reload', kind: 'command', label: 'Reload active panel', hint: 'command', value: 'reload', glyph: '⟳' }
    ]

    return [...workspaceItems, ...siteItems, ...commandItems]
  }, [workspaces])

  const run = useMemo(() => {
    return (item: CommandItem): void => {
      switch (item.kind) {
        case 'workspace': {
          if (item.value) activateWorkspace(item.value)
          break
        }
        case 'pinned-site': {
          const url = item.value
          if (!url) break
          // Target the active workspace, else the first one. If there are no
          // workspaces at all there is nowhere to put the panel — bail.
          const workspaceId = activeWorkspaceId ?? workspaces[0]?.id
          if (!workspaceId) break

          const panelId = crypto.randomUUID()
          // Guarded so it no-ops gracefully when the bridge is unavailable.
          window.decks?.panel
            .create({
              panelId,
              workspaceId,
              partition: 'persist:' + workspaceId,
              url,
              bounds: { x: 0, y: 0, width: 800, height: 600 }
            })
            .catch(() => {})
          addPanel(workspaceId, { id: panelId, title: item.label, url })
          activateWorkspace(workspaceId)
          break
        }
        case 'command': {
          if (item.value === 'home') {
            goHome()
          } else if (item.value === 'reload') {
            // Reload the first panel of the active workspace, if any.
            const ws = workspaces.find((w) => w.id === activeWorkspaceId)
            const panelId = ws?.panels[0]?.id
            if (panelId) window.decks?.panel.reload(panelId).catch(() => {})
          }
          break
        }
      }
      closePalette()
    }
  }, [workspaces, activeWorkspaceId, activateWorkspace, addPanel, goHome, closePalette])

  return { items, run }
}
