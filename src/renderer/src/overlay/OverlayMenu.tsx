/**
 * OverlayMenu — the custom floating context menu, rendered inside the overlay
 * window so it draws ABOVE live web pages (a DOM menu would be covered by the
 * native WebContentsViews). The overlay window is already sized and positioned
 * at the cursor by main, so the menu is anchored top-left. A full-size
 * transparent backdrop catches outside clicks → dismiss.
 */
import type { MenuKind } from '@shared/ipc'

type Item = {
  action: string
  label: string
  icon: JSX.Element
  danger?: boolean
}

const Pencil = (
  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
)

const Refresh = (
  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
    <path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
    <path d="M3 21v-5h5" />
  </svg>
)

const Note = (
  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 3v5h5" />
    <path d="M19 8v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7Z" />
    <path d="M9 13h6" />
    <path d="M9 17h4" />
  </svg>
)

const Trash = (
  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 6h18" />
    <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    <path d="M10 11v6M14 11v6" />
  </svg>
)

const Ungroup = (
  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="14" width="7" height="7" rx="1" />
    <path d="M10 14H7a2 2 0 0 0-2 2v2" />
    <path d="M14 10h3a2 2 0 0 0 2-2V6" />
  </svg>
)

export default function OverlayMenu({
  kind,
  targetId,
  hasNotes
}: {
  kind: MenuKind
  targetId: string
  hasNotes: boolean
}): JSX.Element {
  const pick = (action: string): void =>
    window.decks?.menu.pick({ kind, targetId, action })
  const dismiss = (): void => window.decks?.menu.dismiss()

  const items: Item[] =
    kind === 'workspace'
      ? [
          { action: 'rename', label: 'Rename', icon: Pencil },
          { action: 'reset', label: 'Reset decks', icon: Refresh },
          { action: 'note', label: hasNotes ? 'Edit note' : 'Add note', icon: Note }
        ]
      : [
          { action: 'rename', label: 'Rename', icon: Pencil },
          { action: 'ungroup', label: 'Ungroup', icon: Ungroup }
        ]

  const danger: Item | null =
    kind === 'workspace'
      ? { action: 'delete', label: 'Delete workspace', icon: Trash, danger: true }
      : null

  const Row = ({ item }: { item: Item }): JSX.Element => (
    <button
      onClick={() => pick(item.action)}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = item.danger
          ? 'rgba(255, 93, 108, 0.14)'
          : 'var(--bg-elevated)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent'
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        width: '100%',
        padding: '8px 10px',
        borderRadius: 8,
        fontSize: 12.5,
        textAlign: 'left',
        background: 'transparent',
        border: 'none',
        cursor: 'pointer',
        color: item.danger ? 'var(--err)' : 'var(--txt-1)',
        transition: 'background 0.12s ease'
      }}
    >
      <span style={{ display: 'grid', placeItems: 'center', width: 16, height: 16, flexShrink: 0 }}>
        {item.icon}
      </span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {item.label}
      </span>
    </button>
  )

  return (
    <>
      {/* Outside-click catcher (the overlay window is interactive in menu mode). */}
      <div className="pointer-events-auto fixed inset-0" onClick={dismiss} onContextMenu={(e) => { e.preventDefault(); dismiss() }} />
      <div
        className="overlay-pop glass pointer-events-auto absolute left-0 top-0 w-[220px]"
        style={{ borderRadius: 12, padding: 6 }}
      >
        <div
          style={{
            padding: '4px 10px 6px',
            fontSize: 10.5,
            letterSpacing: 0.3,
            textTransform: 'uppercase',
            color: 'var(--txt-3)',
            fontFamily: 'var(--font-mono)'
          }}
        >
          {kind === 'workspace' ? 'Workspace' : 'Folder'}
        </div>
        {items.map((it) => (
          <Row key={it.action} item={it} />
        ))}
        {danger && (
          <>
            <div style={{ margin: '4px 0', height: 1, background: 'var(--line-2)' }} />
            <Row item={danger} />
          </>
        )}
      </div>
    </>
  )
}
