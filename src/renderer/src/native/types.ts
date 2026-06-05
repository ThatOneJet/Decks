/**
 * Decks — native deck renderer contract (renderer process).
 *
 * A NATIVE deck renders OUR OWN React UI inside the deck card body (instead of an
 * embedded WebContentsView). It never holds tokens or talks to a service directly
 * — it asks the main process via `window.decks.provider.*` and gets back
 * sanitized JSON.
 *
 * Every native deck component receives exactly these props. The host
 * (NativeDeckHost) looks up the component for a panel's `provider` and renders it
 * with the panel/workspace identity so the component can scope its fetches.
 */
import type { ProviderId } from '@shared/types'

export interface NativeDeckProps {
  /** The backing provider this deck renders. */
  provider: ProviderId
  /** Which connected account this deck reads (a provider may have several). */
  accountId: string
  /** The owning panel's id (stable across the panel's lifetime). */
  panelId: string
  /** The workspace this deck lives in (for per-workspace scoping if needed). */
  workspaceId: string
}
