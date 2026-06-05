/**
 * Decks — native deck component registry (renderer process).
 *
 * Maps each ProviderId to the React component that renders its native deck.
 * NativeDeckHost consults this; a missing entry renders a "coming soon"
 * placeholder, so it is safe for this map to be partial.
 *
 * Phase 0 ships it EMPTY (no native decks yet). Phase 1 agents add one entry per
 * provider they build, e.g.:
 *
 *   import CanvasDeck from './canvas/CanvasDeck'
 *   export const nativeDeckRegistry: NativeDeckRegistry = { canvas: CanvasDeck }
 */
import type { ComponentType } from 'react'
import type { ProviderId } from '@shared/types'
import type { NativeDeckProps } from './types'

/** Partial map: a provider without an entry falls back to the placeholder. */
export type NativeDeckRegistry = Partial<Record<ProviderId, ComponentType<NativeDeckProps>>>

export const nativeDeckRegistry: NativeDeckRegistry = {
  // Phase 1: canvas: CanvasDeck, github: GithubDeck, …
}
