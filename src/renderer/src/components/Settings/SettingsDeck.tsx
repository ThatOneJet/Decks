/**
 * SettingsDeck — the dedicated settings surface (view === 'settings').
 *
 * A full-surface, scrollable page (fills <main>) holding app-level settings:
 *   - Memory:      live RAM / live / discarded readout (polls metrics.get) and a
 *                  "discard idle panels after" stepper that pushes the timeout to
 *                  the main process via settings.apply.
 *   - Appearance:  an accent-color swatch picker that updates settings.accent and
 *                  applies it live via the --accent CSS variable.
 *   - About:       app name, one-liner, version.
 *
 * Reads/acts through the store (settings slice) and window.decks. No props.
 */
import { useEffect, useState } from 'react'
import { useStore } from '../../store'
import type { MetricsResult } from '@shared/ipc'
import Accounts from './Accounts'

const ACCENTS = ['#7c5cff', '#ff3b3b', '#3ddc97', '#5b8def', '#e1306c', '#f5b342']
const DISCARD_MIN = 1
const DISCARD_MAX = 60

/** Apply the accent color live by setting a CSS variable on the document root. */
function applyAccent(accent: string): void {
  document.documentElement.style.setProperty('--accent', accent)
}

/** Live memory readout — polls the main process every ~2.5s. */
function MemoryReadout(): JSX.Element {
  const [m, setM] = useState<MetricsResult | null>(null)

  useEffect(() => {
    let alive = true
    const poll = async (): Promise<void> => {
      const next = await window.decks?.metrics.get().catch(() => null)
      if (alive && next) setM(next)
    }
    void poll()
    const id = setInterval(poll, 2500)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [])

  const stats: { label: string; value: string }[] = [
    { label: 'Total RAM', value: m ? `${m.ramMB} MB` : '—' },
    { label: 'Live renderers', value: m ? `${m.liveRenderers}` : '—' },
    { label: 'Discarded', value: m ? `${m.discarded}` : '—' }
  ]

  return (
    <div className="grid grid-cols-3 gap-3">
      {stats.map((s) => (
        <div
          key={s.label}
          className="flex flex-col items-center justify-center rounded-xl2 border border-line bg-bg-elevated px-4 py-5 text-center"
        >
          <span className="text-2xl font-semibold tabular-nums text-txt-1">{s.value}</span>
          <span className="mt-1 text-xs text-txt-3">{s.label}</span>
        </div>
      ))}
    </div>
  )
}

/** A titled card wrapper matching the dark theme. */
function Card({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <section className="rounded-xl2 border border-line bg-bg-panel p-5">
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-txt-2">{title}</h2>
      {children}
    </section>
  )
}

function SettingsDeck(): JSX.Element {
  const settings = useStore((s) => s.settings)
  const setSettings = useStore((s) => s.setSettings)

  // Detach every panel view so this pure-renderer surface is fully visible.
  useEffect(() => {
    window.decks?.panel.hideAll()
  }, [])

  const setDiscard = (minutes: number): void => {
    const clamped = Math.min(DISCARD_MAX, Math.max(DISCARD_MIN, Math.round(minutes)))
    if (clamped === settings.discardMinutes) return
    setSettings({ discardMinutes: clamped })
    window.decks?.settings.apply({ discardMinutes: clamped })
  }

  const pickAccent = (accent: string): void => {
    setSettings({ accent })
    applyAccent(accent)
  }

  return (
    <div className="h-full w-full overflow-y-auto bg-bg">
      <div className="mx-auto w-full max-w-2xl px-8 py-10">
        <header className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight text-txt-1">Settings</h1>
          <p className="mt-1 text-sm text-txt-3">Memory, appearance, and app preferences.</p>
        </header>

        <div className="flex flex-col gap-5">
          {/* ── Accounts & native decks ── */}
          <Card title="Accounts & native decks">
            <p className="-mt-2 mb-4 text-xs leading-relaxed text-txt-3">
              Connect a service to render your own feed on its data — no embedded site, no
              extra renderer process. Closed feeds (Instagram, TikTok, X, Reddit, YouTube) stay
              as embedded web decks.
            </p>
            <Accounts />
          </Card>

          {/* ── Memory ── */}
          <Card title="Memory">
            <MemoryReadout />

            <div className="mt-6">
              <div className="flex items-center justify-between">
                <label htmlFor="discard-range" className="text-sm font-medium text-txt-1">
                  Discard idle panels after
                </label>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setDiscard(settings.discardMinutes - 1)}
                    disabled={settings.discardMinutes <= DISCARD_MIN}
                    className="grid h-7 w-7 place-items-center rounded-lg border border-line bg-bg-elevated text-txt-2 transition-colors hover:text-txt-1 disabled:opacity-40"
                    aria-label="Decrease"
                  >
                    −
                  </button>
                  <span className="w-16 text-center text-sm font-medium tabular-nums text-txt-1">
                    {settings.discardMinutes} min
                  </span>
                  <button
                    onClick={() => setDiscard(settings.discardMinutes + 1)}
                    disabled={settings.discardMinutes >= DISCARD_MAX}
                    className="grid h-7 w-7 place-items-center rounded-lg border border-line bg-bg-elevated text-txt-2 transition-colors hover:text-txt-1 disabled:opacity-40"
                    aria-label="Increase"
                  >
                    +
                  </button>
                </div>
              </div>

              <input
                id="discard-range"
                type="range"
                min={DISCARD_MIN}
                max={DISCARD_MAX}
                value={settings.discardMinutes}
                onChange={(e) => setDiscard(Number(e.target.value))}
                className="mt-3 w-full accent-[var(--accent,#7c5cff)]"
              />

              <p className="mt-2 text-xs leading-relaxed text-txt-3">
                Lower frees RAM sooner by suspending unused panels; higher keeps them warm so
                returning to a deck is instant.
              </p>
            </div>
          </Card>

          {/* ── Appearance ── */}
          <Card title="Appearance">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-txt-1">Accent color</p>
                <p className="mt-1 text-xs text-txt-3">Tints accent UI throughout the app.</p>
              </div>
              <div className="flex items-center gap-2.5">
                {ACCENTS.map((c) => {
                  const selected = settings.accent.toLowerCase() === c.toLowerCase()
                  return (
                    <button
                      key={c}
                      onClick={() => pickAccent(c)}
                      title={c}
                      aria-label={`Accent ${c}`}
                      aria-pressed={selected}
                      style={{ backgroundColor: c }}
                      className={`h-7 w-7 rounded-full transition-transform hover:scale-110 ${
                        selected
                          ? 'ring-2 ring-white ring-offset-2 ring-offset-bg-panel'
                          : 'ring-1 ring-inset ring-white/10'
                      }`}
                    />
                  )
                })}
              </div>
            </div>
          </Card>

          {/* ── About ── */}
          <Card title="About">
            <div className="flex items-baseline justify-between">
              <div>
                <p className="text-base font-semibold text-txt-1">Decks</p>
                <p className="mt-1 text-sm text-txt-3">Your workspaces, one keystroke away.</p>
              </div>
              <span className="text-xs tabular-nums text-txt-3">v0.1.0</span>
            </div>
          </Card>
        </div>
      </div>
    </div>
  )
}

export default SettingsDeck
