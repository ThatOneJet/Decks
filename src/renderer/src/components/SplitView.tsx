/**
 * SplitView — STUB. Owned by the "Home + split view + motion" Phase 1 agent.
 *
 * Contract: renders the active workspace's `layout` (LayoutNode tree) as a grid
 * of empty positioned SLOTS — it draws NO web content itself. The real web pages
 * are native WebContentsViews owned by the main process; this component measures
 * each leaf slot's pixel rect (getBoundingClientRect) and reports them via
 * window.decks.panel.showOnly({ panelIds, bounds }) so main positions the views
 * over the slots. Re-report on resize / layout change. No looping animation here.
 * No props (reads activeWorkspace from the store).
 */
import { useStore } from '../store'

function SplitView(): JSX.Element {
  const ws = useStore((s) => s.activeWorkspace())
  return (
    <div className="grid h-full w-full grid-cols-2 gap-3 p-3">
      {ws?.panels.map((p) => (
        <div
          key={p.id}
          data-panel-id={p.id}
          className="flex items-center justify-center rounded-xl2 border border-line bg-bg-panel text-txt-3"
        >
          {p.title} — slot (web view mounts here)
        </div>
      ))}
    </div>
  )
}

export default SplitView
