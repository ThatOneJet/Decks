/**
 * Decks — native deck component registry (renderer process).
 *
 * Maps each ProviderId to the React component that renders its native deck.
 * NativeDeckHost consults this; a missing entry renders a "coming soon"
 * placeholder, so it is safe for this map to be partial.
 */
import type { ComponentType } from 'react'
import type { ProviderId } from '@shared/types'
import type { NativeDeckProps } from './types'
import CanvasDeck from './canvas/CanvasDeck'
import GithubDeck from './github/GithubDeck'
import SpotifyDeck from './spotify/SpotifyDeck'
import BlueskyDeck from './bluesky/BlueskyDeck'
import MastodonDeck from './mastodon/MastodonDeck'
import RssDeck from './rss/RssDeck'
import FollowsWallDeck from './follows-wall/FollowsWallDeck'
import NotesDeck from './notes/NotesDeck'
import CalendarDeck from './calendar/CalendarDeck'

/** Partial map: a provider without an entry falls back to the placeholder. */
export type NativeDeckRegistry = Partial<Record<ProviderId, ComponentType<NativeDeckProps>>>

export const nativeDeckRegistry: NativeDeckRegistry = {
  canvas: CanvasDeck,
  github: GithubDeck,
  spotify: SpotifyDeck,
  bluesky: BlueskyDeck,
  mastodon: MastodonDeck,
  rss: RssDeck,
  'follows-wall': FollowsWallDeck,
  notes: NotesDeck,
  calendar: CalendarDeck
}
