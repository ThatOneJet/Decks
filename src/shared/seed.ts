/**
 * Decks — default seed workspaces (used on first launch when no persisted
 * state exists). Matches the three rail items in the target dashboard:
 * Build (split view), Claude (chat · code), Watch (paused), Social (unread).
 */
import type { Workspace } from './types'

let n = 0
const pid = (): string => `panel_${Date.now().toString(36)}_${n++}`

export function seedWorkspaces(): Workspace[] {
  const buildA = pid()
  const buildB = pid()
  return [
    {
      id: 'build',
      name: 'Build',
      subtitle: '2 panels · term',
      color: '#7c5cff',
      glyph: '▦',
      partition: 'persist:build',
      live: { status: 'active' },
      panels: [
        { id: buildA, title: 'localhost:5173', url: 'http://localhost:5173' },
        { id: buildB, title: 'MDN', url: 'https://developer.mozilla.org' }
      ],
      layout: {
        type: 'split',
        direction: 'row',
        sizes: [0.5, 0.5],
        children: [
          { type: 'leaf', panelId: buildA },
          { type: 'leaf', panelId: buildB }
        ]
      }
    },
    {
      id: 'claude',
      name: 'Claude',
      subtitle: 'chat · code',
      color: '#d77a4b',
      glyph: '✳',
      partition: 'persist:claude',
      live: { status: 'idle' },
      panels: [(() => { const p = pid(); return { id: p, title: 'Claude', url: 'https://claude.ai' } })()],
      layout: { type: 'leaf', panelId: '' } // fixed below
    },
    {
      id: 'watch',
      name: 'Watch',
      subtitle: 'paused 14:32',
      color: '#5b8def',
      glyph: '►',
      partition: 'persist:watch',
      live: { status: 'paused', pausedAt: Date.now() },
      panels: [(() => { const p = pid(); return { id: p, title: 'YouTube', url: 'https://youtube.com' } })()],
      layout: { type: 'leaf', panelId: '' }
    },
    {
      id: 'social',
      name: 'Social',
      subtitle: '3 unread',
      color: '#3ddc97',
      glyph: '◍',
      partition: 'persist:social',
      live: { status: 'unread', unread: 3 },
      panels: [(() => { const p = pid(); return { id: p, title: 'Reddit', url: 'https://reddit.com' } })()],
      layout: { type: 'leaf', panelId: '' }
    }
  ].map((w) => {
    // Ensure single-panel workspaces point their leaf at their one panel.
    if (w.panels.length === 1) {
      w.layout = { type: 'leaf', panelId: w.panels[0].id }
    }
    return w as Workspace
  })
}
