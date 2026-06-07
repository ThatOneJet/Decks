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

export function faviconFor(url: string, size = 256): string {
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
  return `https://logo.clearbit.com/${host}?size=512`
}

/**
 * Ordered icon candidates for a deck, best (crispest, most app-icon-like) first.
 * Consumers walk this list, advancing on <img> error, then fall back to a
 * colored initial. All sources are https (allowed by the renderer CSP) and are
 * chosen/ordered so the sharpest square brand icon wins while 404s fall through
 * quickly to a source that always resolves:
 *
 * Ordered HIGH-RES first so logos look crisp (the old order led with a tiny
 * DuckDuckGo .ico, which is why tiles looked low-quality):
 *  1. unavatar (fallback=false) — aggregates the sharpest brand logo a site has.
 *  2. icon.horse — high-res icon aggregator.
 *  3. Clearbit (size=512) — true square brand logos; 404s cleanly for unknowns.
 *  4. Google s2 (sz=256) — crisp & square for major brands.
 *  5. live page favicon — the real icon the page reported (often small).
 *  6. DuckDuckGo ip3 — last-resort that always resolves something.
 */
export function iconCandidates(url: string, liveFavicon?: string): string[] {
  const host = hostOf(url)
  if (!host) return liveFavicon ? [liveFavicon] : []
  return [
    `https://unavatar.io/${host}?fallback=false`,
    `https://icon.horse/icon/${host}`,
    `https://logo.clearbit.com/${host}?size=512`,
    `https://www.google.com/s2/favicons?domain=${host}&sz=256`,
    liveFavicon || '',
    `https://icons.duckduckgo.com/ip3/${host}.ico`
  ].filter(Boolean)
}

/** First letter fallback when no icon resolves. */
export function initialOf(title: string, url: string): string {
  const t = (title || hostOf(url) || '?').trim()
  return t.charAt(0).toUpperCase()
}
