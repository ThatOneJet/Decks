/**
 * WorkspaceItem — a single row in the workspace rail.
 *
 * Shows: a color-tinted glyph chip, the workspace name (bold), a muted
 * subtitle line (falls back to a "paused HH:MM" string when paused and no
 * explicit subtitle is set), and a LiveDot on the right.
 *
 * `active` reflects that this workspace is BOTH the selected workspace AND the
 * right-hand region is showing the workspace view (not home). The active row
 * gets an accent background, a left accent bar, and brighter text.
 */
import type { Workspace } from '@shared/types'
import LiveDot from './LiveDot'

interface WorkspaceItemProps {
  workspace: Workspace
  active: boolean
  onActivate: (id: string) => void
}

/** Format an epoch-ms timestamp as "HH:MM" (24h, local time). */
function formatPausedTime(pausedAt: number): string {
  const d = new Date(pausedAt)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

/** The line under the name. Prefers the explicit subtitle, otherwise derives one. */
function subtitleFor(workspace: Workspace): string | undefined {
  if (workspace.subtitle) return workspace.subtitle
  if (workspace.live.status === 'paused' && workspace.live.pausedAt != null) {
    return `paused ${formatPausedTime(workspace.live.pausedAt)}`
  }
  return undefined
}

function WorkspaceItem({ workspace, active, onActivate }: WorkspaceItemProps): JSX.Element {
  const color = workspace.color ?? '#7c5cff'
  const subtitle = subtitleFor(workspace)

  return (
    <button
      type="button"
      onClick={() => onActivate(workspace.id)}
      aria-current={active ? 'true' : undefined}
      className={[
        'group relative flex w-full items-center gap-3 rounded-xl2 px-2.5 py-2 text-left transition-colors',
        active
          ? 'bg-accent-soft ring-1 ring-accent-ring'
          : 'hover:bg-bg-elevated'
      ].join(' ')}
    >
      {/* Left accent bar — only on the active row. */}
      {active && (
        <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-accent" />
      )}

      {/* Color-tinted glyph chip. */}
      <span
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sm"
        style={{ backgroundColor: `${color}22`, color }}
        aria-hidden
      >
        {workspace.glyph ?? workspace.name.charAt(0).toUpperCase()}
      </span>

      {/* Name + subtitle. */}
      <span className="flex min-w-0 flex-1 flex-col">
        <span
          className={[
            'truncate text-sm font-semibold leading-tight',
            active ? 'text-txt-1' : 'text-txt-2 group-hover:text-txt-1'
          ].join(' ')}
        >
          {workspace.name}
        </span>
        {subtitle && (
          <span className="truncate text-xs leading-tight text-txt-3">{subtitle}</span>
        )}
      </span>

      {/* Live-state indicator. */}
      <span className="flex shrink-0 items-center">
        <LiveDot live={workspace.live} />
      </span>
    </button>
  )
}

export default WorkspaceItem
