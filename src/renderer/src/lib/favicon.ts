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

/** Ordered icon candidates for a deck, best (crispest) first. */
export function iconCandidates(url: string, liveFavicon?: string): string[] {
  return [logoFor(url), liveFavicon || '', faviconFor(url, 128)].filter(Boolean)
}

/** First letter fallback when no icon resolves. */
export function initialOf(title: string, url: string): string {
  const t = (title || hostOf(url) || '?').trim()
  return t.charAt(0).toUpperCase()
}
