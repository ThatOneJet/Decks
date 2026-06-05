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

/** First letter fallback when no icon resolves. */
export function initialOf(title: string, url: string): string {
  const t = (title || hostOf(url) || '?').trim()
  return t.charAt(0).toUpperCase()
}
