/**
 * Decks — default presets (first launch) and reset templates.
 * Only two presets: YouTube and Opera GX. A template is also used by
 * "Reset decks" to restore a workspace's original deck(s).
 */
import type { Workspace } from './types'

export interface SeedTemplate {
  id: string
  name: string
  color: string
  glyph: string
  decks: { title: string; url: string }[]
}

export const SEED_TEMPLATES: SeedTemplate[] = [
  {
    id: 'youtube',
    name: 'YouTube',
    color: '#ff3b3b',
    glyph: '▶',
    decks: [{ title: 'YouTube', url: 'https://youtube.com' }]
  },
  {
    id: 'operagx',
    name: 'Opera GX',
    color: '#ff1b4c',
    glyph: '⊙',
    decks: [{ title: 'Opera GX', url: 'https://gx.games' }]
  },
  {
    id: 'claude',
    name: 'Claude',
    color: '#d77a4b',
    glyph: '✳',
    decks: [{ title: 'Claude', url: 'https://claude.ai' }]
  },
  {
    id: 'instagram',
    name: 'Instagram',
    color: '#e1306c',
    glyph: '⌾',
    decks: [{ title: 'Instagram', url: 'https://instagram.com' }]
  }
]

let n = 0
const pid = (): string => `panel_${Date.now().toString(36)}_${n++}`

/** Build a fresh Workspace from a template (new deck ids each time). */
export function workspaceFromTemplate(t: SeedTemplate): Workspace {
  const panels = t.decks.map((d) => ({ id: pid(), title: d.title, url: d.url }))
  const layout =
    panels.length === 1
      ? { type: 'leaf' as const, panelId: panels[0].id }
      : {
          type: 'split' as const,
          direction: 'row' as const,
          sizes: panels.map(() => 1 / panels.length),
          children: panels.map((p) => ({ type: 'leaf' as const, panelId: p.id }))
        }
  return {
    id: t.id,
    name: t.name,
    subtitle: `${panels.length} deck${panels.length === 1 ? '' : 's'}`,
    color: t.color,
    glyph: t.glyph,
    partition: `persist:${t.id}`,
    live: { status: 'idle' },
    panels,
    layout
  }
}

export function templateFor(id: string): SeedTemplate | undefined {
  return SEED_TEMPLATES.find((t) => t.id === id)
}

export function seedWorkspaces(): Workspace[] {
  return SEED_TEMPLATES.map(workspaceFromTemplate)
}
