/**
 * LiveDot — the small live-state indicator shown on a workspace row.
 *
 * Renders one of four states derived from `WorkspaceLiveState.status`:
 *   - active : a green pulsing dot
 *   - idle   : a soft, dim grey dot
 *   - paused : a small ► glyph (the "paused HH:MM" text lives in the subtitle)
 *   - unread : a pill badge with the unread count
 */
import type { WorkspaceLiveState } from '@shared/types'

interface LiveDotProps {
  live: WorkspaceLiveState
}

function LiveDot({ live }: LiveDotProps): JSX.Element {
  switch (live.status) {
    case 'active':
      return (
        <span className="relative flex h-2.5 w-2.5" aria-label="active">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ok opacity-60" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-ok" />
        </span>
      )

    case 'unread': {
      const count = live.unread ?? 0
      return (
        <span
          className="inline-flex min-w-[18px] items-center justify-center rounded-full bg-accent px-1.5 text-[10px] font-semibold leading-[18px] text-white"
          aria-label={`${count} unread`}
        >
          {count > 99 ? '99+' : count}
        </span>
      )
    }

    case 'paused':
      return (
        <span className="text-[10px] leading-none text-warn" aria-label="paused">
          ►
        </span>
      )

    case 'idle':
    default:
      return (
        <span
          className="inline-flex h-2 w-2 rounded-full bg-txt-4"
          aria-label="idle"
        />
      )
  }
}

export default LiveDot
