/**
 * Titlebar — frameless window drag region + traffic-light controls.
 * Phase 0 stub; the Sidebar agent may refine styling. Owns window controls
 * via window.decks.window.*.
 */
function Titlebar(): JSX.Element {
  return (
    <header className="drag flex h-9 shrink-0 items-center justify-between border-b border-line bg-bg-rail px-3">
      <span className="text-xs font-medium tracking-wide text-txt-3">Decks</span>
      <div className="no-drag flex items-center gap-2">
        <button
          onClick={() => window.decks?.window.minimize()}
          className="h-3 w-3 rounded-full bg-warn/70 hover:bg-warn"
          aria-label="Minimize"
        />
        <button
          onClick={() => window.decks?.window.maximize()}
          className="h-3 w-3 rounded-full bg-ok/70 hover:bg-ok"
          aria-label="Maximize"
        />
        <button
          onClick={() => window.decks?.window.close()}
          className="h-3 w-3 rounded-full bg-err/70 hover:bg-err"
          aria-label="Close"
        />
      </div>
    </header>
  )
}

export default Titlebar
