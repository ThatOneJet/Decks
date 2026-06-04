/**
 * Decks — app shell (the integration seam).
 *
 * Lays out the three Phase 1 surfaces and owns nothing of their internals:
 *   - <Sidebar/>        left workspace rail            (Sidebar agent)
 *   - <Home/>           home screen + animated bg      (Home agent)
 *   - <SplitView/>      workspace split panels         (Home agent)
 *   - <CommandPalette/> Cmd+K overlay                  (Palette agent)
 *
 * Each surface reads/writes the zustand store (./store) and calls window.decks
 * (the IPC contract) for main-process side effects. Phase 2 boots state here.
 */
import { useEffect } from 'react'
import { useStore } from './store'
import Titlebar from './components/Titlebar'
import Sidebar from './components/Sidebar'
import Home from './components/Home'
import SplitView from './components/SplitView'
import CommandPalette from './components/CommandPalette'
import { seedWorkspaces } from '@shared/seed'

function App(): JSX.Element {
  const view = useStore((s) => s.view)
  const setWorkspaces = useStore((s) => s.setWorkspaces)
  const workspaces = useStore((s) => s.workspaces)
  const togglePalette = useStore((s) => s.togglePalette)
  const closePalette = useStore((s) => s.closePalette)

  // Phase 0 bootstrap: hydrate from disk, else seed. Phase 2 replaces this with
  // the full load → create-views → save pipeline.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const persisted = await window.decks?.state.load().catch(() => null)
      if (cancelled) return
      if (persisted && persisted.workspaces.length) {
        setWorkspaces(persisted.workspaces)
      } else {
        setWorkspaces(seedWorkspaces())
      }
    })()
    return () => {
      cancelled = true
    }
  }, [setWorkspaces])

  // Global Cmd/Ctrl+K toggles the palette; Esc closes it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        togglePalette()
      } else if (e.key === 'Escape') {
        closePalette()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePalette, closePalette])

  return (
    <div className="flex h-full w-full flex-col bg-bg text-txt-1">
      <Titlebar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="relative min-w-0 flex-1">
          {view === 'home' || workspaces.length === 0 ? <Home /> : <SplitView />}
        </main>
      </div>
      <CommandPalette />
    </div>
  )
}

export default App
