/**
 * Console surfaces (wave 1 of the "Console" redesign): the first-run Welcome
 * tutorial, the Help/cheatsheet slide-over, and the Memory manager slide-over.
 * These drop in over the current shell (additive) and are wired to real data —
 * the Memory panel reads live metrics from main and the real workspace list.
 */
import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { faviconFor } from '../lib/favicon'
import { modCombo, MOD } from '../lib/platform'
import Logo from './Logo'
import type { MetricsResult, PanelMetric } from '@shared/ipc'

const WELCOME_KEY = 'decks.welcomeSeen'

function Ico({ d, w = 16 }: { d: React.ReactNode; w?: number }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width={w} height={w} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {d}
    </svg>
  )
}
const I = {
  search: <><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></>,
  split: <><rect x="3" y="4" width="8" height="16" rx="1" /><rect x="13" y="4" width="8" height="16" rx="1" /></>,
  bolt: <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" />,
  chip: <><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2" /></>,
  home: <><path d="M3 11l9-8 9 8" /><path d="M5 10v10h14V10" /></>,
  focus: <path d="M4 8V5a1 1 0 0 1 1-1h3M20 8V5a1 1 0 0 0-1-1h-3M4 16v3a1 1 0 0 0 1 1h3M20 16v3a1 1 0 0 1-1 1h-3" />,
  rail: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  help: <><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 1 1 3 2.4c-.6.2-1 .8-1 1.6M12 17h.01" /></>,
  x: <path d="M6 6l12 12M18 6L6 18" />
}

/** First-run welcome card — three things to know. Dismiss persists. */
export function Welcome({ onClose, onHelp }: { onClose: () => void; onHelp: () => void }): JSX.Element {
  const cells: Array<[React.ReactNode, string, string]> = [
    [I.search, 'One bar for everything', `The command bar jumps to any deck or runs any command — ${modCombo('K')}.`],
    [I.split, 'Split with one click', 'Drag a deck into the page (or open beside) to view two at once — up to four.'],
    [I.bolt, 'Native = low memory', 'Cyan decks draw our own fast UI on real APIs. Grey decks are embedded web pages.']
  ]
  const dismiss = (): void => {
    try {
      localStorage.setItem(WELCOME_KEY, '1')
    } catch {
      /* ignore */
    }
    onClose()
  }
  return (
    <div className="welcome glass">
      <div className="wtop">
        <span className="wbadge"><Logo size={24} /></span>
        <div>
          <h3>Welcome to Decks</h3>
          <div className="wsub">Everything here is labeled — no hidden gestures. Three things to know:</div>
        </div>
        <button className="wclose" onClick={dismiss}><Ico d={I.x} w={15} /></button>
      </div>
      <div className="wgrid">
        {cells.map(([icon, l, d]) => (
          <div className="wcell" key={l}>
            <span className="wi">{icon}</span>
            <div className="wl">{l}</div>
            <div className="wd">{d}</div>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 15 }}>
        <button className="btn-ghost" onClick={() => { dismiss(); onHelp() }}>See all shortcuts</button>
        <button className="btn-primary" onClick={dismiss}>Start exploring</button>
      </div>
    </div>
  )
}

/** True if the welcome card hasn't been dismissed yet. */
export function welcomeUnseen(): boolean {
  try {
    return localStorage.getItem(WELCOME_KEY) !== '1'
  } catch {
    return false
  }
}

type HelpAction = 'palette' | 'home' | 'focus' | 'add' | 'memory'

/** Help / cheatsheet slide-over — every capability, labeled, clickable. */
export function HelpPanel({
  onClose,
  onAction
}: {
  onClose: () => void
  onAction: (id: HelpAction) => void
}): JSX.Element {
  const dot = MOD === '⌘' ? '⌘.' : 'Ctrl+.'
  const groups: Array<[string, Array<[React.ReactNode, string, string, string, HelpAction?]>]> = [
    ['Move around', [
      [I.search, 'Command palette', 'Jump to any deck or run any command.', modCombo('K'), 'palette'],
      [I.home, 'Home', 'A clean launcher with your decks.', '', 'home'],
      [I.focus, 'Focus mode', 'Collapse the rail onto one deck for deep work.', dot, 'focus']
    ]],
    ['Work with decks', [
      [I.split, 'Open beside / split', 'Drag a deck from the rail into the page to view decks side by side (up to 4).', 'drag'],
      [I.folder, 'Group into folders', 'Drag one rail tile onto another to make a folder.', 'drag'],
      [I.plus, 'Add anything', 'Pick an integration or paste any link to add a deck. Logins persist.', modCombo('N'), 'add']
    ]],
    ['Understand decks', [
      [I.bolt, 'Native vs Web', 'Native decks (cyan) draw our UI on real APIs — fast & low memory. Web decks (grey) are sandboxed pages.', ''],
      [I.chip, 'Memory manager', "See what's using memory and what got freed.", '', 'memory']
    ]]
  ]
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="panel-over glass">
        <div className="panel-head">
          <span style={{ color: 'var(--accent)' }}><Ico d={I.help} w={19} /></span>
          <h3>Everything you can do</h3>
          <button className="pclose" onClick={onClose}><Ico d={I.x} w={15} /></button>
        </div>
        <div className="panel-body">
          {groups.map(([title, items]) => (
            <div className="help-grp" key={title}>
              <h4>{title}</h4>
              {items.map(([icon, label, desc, key, action]) => (
                <button
                  className="help-item"
                  key={label}
                  onClick={() => action && onAction(action)}
                  style={{ cursor: action ? 'pointer' : 'default' }}
                >
                  <span className="hicon">{icon}</span>
                  <span className="ht">
                    <span className="l">
                      {label}
                      {key && <span className="kbd">{key}</span>}
                    </span>
                    <span className="d">{desc}</span>
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
    </>
  )
}

/** Memory manager slide-over — live RAM + per-deck rollup (native = free). */
export function MemoryPanel({ onClose }: { onClose: () => void }): JSX.Element {
  const workspaces = useStore((s) => s.workspaces)
  const [m, setM] = useState<MetricsResult | null>(null)
  // Real per-panel memory (MB) keyed by panelId, polled from main.
  const [perPanel, setPerPanel] = useState<Record<string, number>>({})

  useEffect(() => {
    let alive = true
    const poll = async (): Promise<void> => {
      const [next, panelMetrics] = await Promise.all([
        window.decks?.metrics.get().catch(() => null),
        window.decks?.metrics.panels().catch(() => [] as PanelMetric[])
      ])
      if (!alive) return
      if (next) setM(next)
      const map: Record<string, number> = {}
      for (const pm of panelMetrics ?? []) map[pm.panelId] = pm.mb
      setPerPanel(map)
    }
    void poll()
    const id = setInterval(poll, 2500)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [])

  // Derive deck rollups from the real workspace list, summing the REAL renderer
  // memory of each workspace's web panels (matched by panelId to main's metrics).
  type Row = { id: string; name: string; url: string; native: boolean; live: boolean; mb: number }
  const rows: Row[] = workspaces.map((w) => {
    const primary = w.panels[0]
    const native = primary?.kind === 'native'
    const live = !native && w.panels.some((p) => p.kind !== 'native' && !p.discarded)
    // Sum real MB across this workspace's live web panels (a panel that's truly
    // live in main shows up in perPanel; discarded/unknown contribute 0).
    let mb = 0
    for (const p of w.panels) {
      if (p.kind === 'native') continue
      mb += perPanel[p.id] ?? 0
    }
    return { id: w.id, name: w.name, url: primary?.url ?? '', native, live, mb }
  })
  const liveWeb = rows.filter((r) => r.live)
  const freed = rows.filter((r) => !r.live)
  const total = m?.ramMB ?? 0
  // Share of total RAM attributable to live web decks (real per-deck sum / total).
  const webMB = liveWeb.reduce((sum, r) => sum + r.mb, 0)
  const webPct = total > 0 ? Math.min(100, (webMB / total) * 100) : 0
  // Everything that ISN'T a deck renderer: Electron's main process, the app's own
  // UI shell renderer, the GPU process, and the network/audio/storage helpers +
  // the overlay window. This is the app's fixed baseline — it's where the rest of
  // the total goes (the per-deck rows below only cover deck renderers).
  const baselineMB = Math.max(0, total - webMB)

  const ddImg = (url: string): string => faviconFor(url)

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="panel-over glass">
        <div className="panel-head">
          <span style={{ color: 'var(--accent)' }}><Ico d={I.chip} w={19} /></span>
          <h3>Memory</h3>
          <button className="pclose" onClick={onClose}><Ico d={I.x} w={15} /></button>
        </div>
        <div className="panel-body">
          <div className="mem-gauge">
            <div className="big">
              {total}
              <s>MB</s>
            </div>
            <div className="mem-bar">
              <i style={{ width: `${webPct}%`, background: 'var(--web)' }} />
              <i style={{ width: `${100 - webPct}%`, background: 'var(--elev-2)' }} />
            </div>
            <div className="mem-legend">
              <span>
                <i className="ld" style={{ background: 'var(--web)' }} />
                {m?.liveRenderers ?? 0} live web deck{(m?.liveRenderers ?? 0) === 1 ? '' : 's'} · {webMB} MB
              </span>
              <span>
                <i className="ld" style={{ background: 'var(--elev-2)' }} />
                App &amp; system · {baselineMB} MB
              </span>
              <span>
                <i className="ld" style={{ background: 'var(--accent)' }} />
                {rows.filter((r) => r.native).length} native · 0 MB
              </span>
            </div>
          </div>

          <div style={{ fontSize: 11.5, color: 'var(--t3)', lineHeight: 1.55, marginBottom: 16 }}>
            Native decks render our own UI on the app&apos;s data — they spawn{' '}
            <b style={{ color: 'var(--t1)' }}>no browser engine</b>, so they cost almost nothing. Idle web
            decks are auto-discarded ({m?.discarded ?? 0} freed) and reload instantly when you return.
          </div>

          <div className="psec" style={{ paddingLeft: 2 }}>App &amp; system</div>
          <div className="mem-row">
            <span className="mi"><Ico d={I.chip} w={16} /></span>
            <span className="mm">
              <div className="l">Decks app &amp; Electron</div>
              <div className="d">Main process, UI shell, GPU &amp; helper processes</div>
            </span>
            <span className="mv live">{baselineMB} MB</span>
          </div>

          {liveWeb.length > 0 && <div className="psec" style={{ paddingLeft: 2 }}>Live web decks</div>}
          {liveWeb.map((r) => (
            <div className="mem-row" key={r.id}>
              <span className="mi">{r.url ? <img src={ddImg(r.url)} alt="" /> : null}</span>
              <span className="mm">
                <div className="l">{r.name}</div>
                <div className="d">{r.mb > 0 ? 'Renderer active' : 'Renderer active — measuring…'}</div>
              </span>
              <span className="mv live">{r.mb > 0 ? `${r.mb} MB` : 'active'}</span>
            </div>
          ))}
          <div className="psec" style={{ paddingLeft: 2 }}>Native &amp; idle · free</div>
          {freed.map((r) => (
            <div className="mem-row" key={r.id}>
              <span className="mi">{r.url ? <img src={ddImg(r.url)} alt="" /> : null}</span>
              <span className="mm">
                <div className="l">{r.name}</div>
                <div className="d">{r.native ? 'Native deck — no renderer' : 'Idle — reloads on open'}</div>
              </span>
              <span className="mv zero">{r.native ? 'native · 0 MB' : '0 MB'}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  )
}
