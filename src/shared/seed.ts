/**
 * Decks — default seed workspaces (first launch, when no persisted state exists).
 * Each workspace is a single real site so the rail tile shows that site's logo.
 * No fake unread badges — notification counts only ever come from real signals.
 */
import type { Workspace } from './types'

let n = 0
const pid = (): string => `panel_${Date.now().toString(36)}_${n++}`

function single(
  id: string,
  name: string,
  color: string,
  glyph: string,
  title: string,
  url: string
): Workspace {
  const p = pid()
  return {
    id,
    name,
    subtitle: '1 deck',
    color,
    glyph,
    partition: `persist:${id}`,
    live: { status: 'idle' },
    panels: [{ id: p, title, url }],
    layout: { type: 'leaf', panelId: p }
  }
}

export function seedWorkspaces(): Workspace[] {
  return [
    single('build', 'Build', '#7c5cff', '▦', 'GitHub', 'https://github.com'),
    single('claude', 'Claude', '#d77a4b', '✳', 'Claude', 'https://claude.ai'),
    single('watch', 'Watch', '#5b8def', '►', 'YouTube', 'https://youtube.com'),
    single('social', 'Social', '#3ddc97', '◍', 'Reddit', 'https://reddit.com')
  ]
}
