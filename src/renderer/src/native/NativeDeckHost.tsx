/**
 * Decks — native deck host (renderer process).
 *
 * Rendered by SplitView in a deck card BODY when the panel's `kind === 'native'`
 * (in place of the measured WebContentsView slot). Looks up the component for the
 * panel's `provider` in the native registry and renders it; if none is registered
 * yet, shows a tasteful "not connected / coming soon" placeholder.
 *
 * Native decks have NO WebContentsView in main, so this host (and the components
 * it renders) own all of the deck's UI. They talk to providers only through
 * `window.decks.provider.*`.
 */
import type { JSX } from 'react'
import { nativeDeckRegistry } from './registry'
import type { NativeDeckProps } from './types'

/** Human-friendly provider label for the placeholder. */
function providerLabel(provider: string): string {
  if (!provider) return 'This deck'
  return provider
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

function NativeDeckHost(props: NativeDeckProps): JSX.Element {
  const Component = nativeDeckRegistry[props.provider]

  if (Component) {
    return <Component {...props} />
  }

  return (
    <div className="grid h-full w-full place-items-center bg-bg p-6 text-center">
      <div className="max-w-sm">
        <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-xl2 bg-bg-elevated text-txt-3">
          <svg
            viewBox="0 0 24 24"
            className="h-6 w-6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8" />
          </svg>
        </div>
        <div className="text-sm font-medium text-txt-1">{providerLabel(props.provider)}</div>
        <p className="mt-1 text-xs leading-relaxed text-txt-3">
          This native deck isn’t available yet. Connect it to see your feed here —
          coming soon.
        </p>
      </div>
    </div>
  )
}

export default NativeDeckHost
