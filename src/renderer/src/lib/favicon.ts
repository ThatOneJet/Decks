/**
 * Resolve a site's logo from a URL so a deck's rail tile / card header shows
 * "what it leads to" (Claude logo for claude.ai, etc.) immediately — before the
 * live page has reported its own favicon.
 *
 * Uses Google's public favicon service (allowed by the renderer CSP img-src
 * https:). The live favicon from the page (Panel.favicon) takes precedence when
 * available; this is the instant fallback derived purely from the URL.
 */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

export function faviconFor(url: string, size = 64): string {
  const host = hostOf(url)
  if (!host) return ''
  return `https://www.google.com/s2/favicons?domain=${host}&sz=${size}`
}

/**
 * High-res square brand logo (Clearbit) — fills a tile crisply when available.
 * Returns '' for unknown hosts; callers should fall back to faviconFor().
 */
export function logoFor(url: string): string {
  const host = hostOf(url)
  if (!host) return ''
  return `https://logo.clearbit.com/${host}?size=128`
}

/**
 * Ordered icon candidates for a deck, best (crispest, most app-icon-like) first.
 * Consumers walk this list, advancing on <img> error, then fall back to a
 * colored initial. All sources are https (allowed by the renderer CSP) and are
 * chosen/ordered so the sharpest square brand icon wins while 404s fall through
 * quickly to a source that always resolves:
 *
 *  1. Clearbit (size=128) — true square brand logos; 404s cleanly for unknowns.
 *  2. icon.horse — aggregates the best high-res icon a site exposes.
 *  3. unavatar (fallback=false) — aggregates logos/favicons; no generic filler.
 *  4. live page favicon — the real icon the page reported (often small).
 *  5. DuckDuckGo ip3 — frequently crisper than Google.
 *  6. Google s2 (sz=128) — last resort; always resolves something.
 */
export function iconCandidates(url: string, liveFavicon?: string): string[] {
  const host = hostOf(url)
  if (!host) return liveFavicon ? [liveFavicon] : []
  return [
    `https://logo.clearbit.com/${host}?size=128`,
    `https://icon.horse/icon/${host}`,
    `https://unavatar.io/${host}?fallback=false`,
    liveFavicon || '',
    `https://icons.duckduckgo.com/ip3/${host}.ico`,
    faviconFor(url, 128)
  ].filter(Boolean)
}

/** First letter fallback when no icon resolves. */
export function initialOf(title: string, url: string): string {
  const t = (title || hostOf(url) || '?').trim()
  return t.charAt(0).toUpperCase()
}
