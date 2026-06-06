/**
 * Decks — provider bootstrap (main process).
 *
 * Constructs every concrete `ProviderClient` and registers it with the registry.
 * Called exactly once on startup, BEFORE any provider IPC can arrive. This is the
 * single wiring point — nothing provider-specific lives anywhere else.
 */
import { registerProvider } from './registry'
import { CanvasClient } from './canvas'
import { GithubClient } from './github'
import { SpotifyClient } from './spotify'
import { BlueskyClient } from './bluesky'
import { MastodonClient } from './mastodon'
import { RssClient } from './rss'
import { FollowsWallClient } from './follows-wall'
import { DiscoveryClient } from './discovery'
import { NotesClient } from './notes'
import { CalendarClient } from './calendar'

/** Register all concrete provider clients. Call once on app startup. */
export function registerAllProviders(): void {
  registerProvider(new CanvasClient())
  registerProvider(new GithubClient())
  registerProvider(new SpotifyClient())
  registerProvider(new BlueskyClient())
  registerProvider(new MastodonClient())
  registerProvider(new RssClient())
  registerProvider(new NotesClient())
  registerProvider(new CalendarClient())
  // The follows-wall aggregates the above at runtime, so it must register last.
  registerProvider(new FollowsWallClient())
  // Discover also aggregates the source providers at runtime — register last too.
  registerProvider(new DiscoveryClient())
}
