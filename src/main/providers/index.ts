/**
 * Decks — provider bootstrap (main process).
 *
 * Constructs every concrete `ProviderClient` and registers it with the registry.
 * Called exactly once on startup, BEFORE any provider IPC can arrive.
 *
 * Phase 0 registers nothing — the seam is intentionally empty. Phase 1 agents add
 * one line per provider here, e.g.:
 *
 *   import { CanvasClient } from './canvas'
 *   registerProvider(new CanvasClient())
 *
 * Nothing provider-specific lives anywhere else; this is the single wiring point.
 */
// Phase 1: import { registerProvider } from './registry' and the concrete clients.

/** Register all concrete provider clients. Call once on app startup. */
export function registerAllProviders(): void {
  // Phase 1: register concrete clients here, e.g.
  //   import { registerProvider } from './registry'
  //   import { CanvasClient } from './canvas'
  //   registerProvider(new CanvasClient())
}
