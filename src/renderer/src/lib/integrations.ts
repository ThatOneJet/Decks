/**
 * Integration catalog — the deck types Decks knows how to add.
 *
 * NATIVE integrations render our own UI on a provider's API (and most require an
 * auth step before the deck can be added). WEB integrations are sandboxed
 * embedded sites (you sign in inside the deck). Anything else is a custom URL.
 *
 * Used by the "Add a deck" wizard (and mirrors the providers wired in main +
 * the Settings → Accounts panel).
 */
import type { ProviderId } from '@shared/types'

export interface FieldDef {
  key: string
  label: string
  placeholder?: string
  secret?: boolean
}

export interface NativeIntegration {
  kind: 'native'
  id: ProviderId
  label: string
  glyph: string
  color: string
  blurb: string
  mode: 'token' | 'oauth'
  /** When true, the wizard's auth step is REQUIRED (no skip). */
  requiresAuth: boolean
  /** Primary pasted-token input (PAT / access token), when the flow uses one. */
  tokenField?: { label: string; placeholder?: string }
  /** Extra non-secret connect fields passed in `fields`. */
  fields: FieldDef[]
}

export interface WebIntegration {
  kind: 'web'
  id: string
  label: string
  url: string
  glyph: string
  color: string
  blurb: string
}

export type Integration = NativeIntegration | WebIntegration

export const NATIVE_INTEGRATIONS: NativeIntegration[] = [
  {
    kind: 'native',
    id: 'canvas',
    label: 'Canvas',
    glyph: '🎓',
    color: '#e2484d',
    blurb: 'Courses, assignments, grades, announcements & calendar.',
    mode: 'token',
    requiresAuth: true,
    tokenField: { label: 'Access token', placeholder: 'Account → Settings → New access token' },
    fields: [{ key: 'instanceUrl', label: 'Canvas URL', placeholder: 'https://school.instructure.com' }]
  },
  {
    kind: 'native',
    id: 'github',
    label: 'GitHub',
    glyph: '🐙',
    color: '#8b95a5',
    blurb: 'Your notifications and recently-updated repos.',
    mode: 'token',
    requiresAuth: true,
    tokenField: { label: 'Personal access token', placeholder: 'ghp_… (repo, notifications, read:user)' },
    fields: []
  },
  {
    kind: 'native',
    id: 'spotify',
    label: 'Spotify',
    glyph: '🎧',
    color: '#1db954',
    blurb: 'Now playing, playlists, recently played.',
    mode: 'oauth',
    requiresAuth: true,
    fields: [
      { key: 'clientId', label: 'Client ID', placeholder: 'from your Spotify app' },
      { key: 'clientSecret', label: 'Client secret', placeholder: 'from your Spotify app', secret: true },
      { key: 'redirectUri', label: 'Redirect URI', placeholder: 'http://127.0.0.1:8888/callback' }
    ]
  },
  {
    kind: 'native',
    id: 'bluesky',
    label: 'Bluesky',
    glyph: '🦋',
    color: '#1185fe',
    blurb: 'Your chronological following timeline.',
    mode: 'token',
    requiresAuth: true,
    fields: [
      { key: 'handle', label: 'Handle', placeholder: 'you.bsky.social' },
      { key: 'appPassword', label: 'App password', placeholder: 'Settings → App passwords', secret: true }
    ]
  },
  {
    kind: 'native',
    id: 'mastodon',
    label: 'Mastodon',
    glyph: '🐘',
    color: '#6364ff',
    blurb: 'Your home timeline.',
    mode: 'token',
    requiresAuth: true,
    tokenField: { label: 'Access token', placeholder: 'Preferences → Development → New application' },
    fields: [{ key: 'instanceUrl', label: 'Instance URL', placeholder: 'https://mastodon.social' }]
  },
  {
    kind: 'native',
    id: 'rss',
    label: 'RSS',
    glyph: '📡',
    color: '#f5b342',
    blurb: 'A feed collection — blogs, news, even YouTube channels. No login.',
    mode: 'token',
    requiresAuth: false,
    fields: [{ key: 'label', label: 'Collection name', placeholder: 'e.g. Tech, News' }]
  },
  {
    kind: 'native',
    id: 'follows-wall',
    label: 'Follows wall',
    glyph: '🧱',
    color: '#35e3ff',
    blurb: 'One chronological river of Bluesky + Mastodon + RSS. No login.',
    mode: 'token',
    requiresAuth: false,
    fields: []
  },
  {
    kind: 'native',
    id: 'notes',
    label: 'Notes',
    glyph: '📝',
    color: '#f5b342',
    blurb: 'A fast, Notion-style workspace — pages, to-dos, blocks. Local & private.',
    mode: 'token',
    requiresAuth: false,
    fields: []
  },
  {
    kind: 'native',
    id: 'calendar',
    label: 'Calendar',
    glyph: '📅',
    color: '#4ade80',
    blurb: 'Your own calendar — events, holidays, and a Canvas classwork overlay.',
    mode: 'token',
    requiresAuth: false,
    fields: []
  }
]

/** Common embedded sites we support out of the box (sign in inside the deck). */
export const WEB_INTEGRATIONS: WebIntegration[] = [
  { kind: 'web', id: 'youtube', label: 'YouTube', url: 'https://youtube.com', glyph: '▶', color: '#ff0033', blurb: 'Watch & subscriptions.' },
  { kind: 'web', id: 'netflix', label: 'Netflix', url: 'https://netflix.com', glyph: '🎬', color: '#e50914', blurb: 'Streaming (needs DRM build).' },
  { kind: 'web', id: 'disney', label: 'Disney+', url: 'https://disneyplus.com', glyph: '🏰', color: '#1f6feb', blurb: 'Streaming (needs DRM build).' },
  { kind: 'web', id: 'instagram', label: 'Instagram', url: 'https://instagram.com', glyph: '📸', color: '#e1306c', blurb: 'Feed, reels & DMs.' },
  { kind: 'web', id: 'tiktok', label: 'TikTok', url: 'https://tiktok.com', glyph: '🎵', color: '#69c9d0', blurb: 'For You feed.' },
  { kind: 'web', id: 'x', label: 'X', url: 'https://x.com', glyph: '𝕏', color: '#8b95a5', blurb: 'The timeline.' },
  { kind: 'web', id: 'reddit', label: 'Reddit', url: 'https://reddit.com', glyph: '👽', color: '#ff4500', blurb: 'Your home & subs.' },
  { kind: 'web', id: 'twitch', label: 'Twitch', url: 'https://twitch.tv', glyph: '🎮', color: '#9146ff', blurb: 'Live streams.' },
  { kind: 'web', id: 'whatsapp', label: 'WhatsApp', url: 'https://web.whatsapp.com', glyph: '💬', color: '#25d366', blurb: 'Chats.' },
  { kind: 'web', id: 'discord', label: 'Discord', url: 'https://discord.com/app', glyph: '🎧', color: '#5865f2', blurb: 'Servers & DMs.' },
  { kind: 'web', id: 'gmail', label: 'Gmail', url: 'https://mail.google.com', glyph: '✉', color: '#ea4335', blurb: 'Your inbox.' },
  { kind: 'web', id: 'notion', label: 'Notion', url: 'https://notion.so', glyph: '📝', color: '#8b95a5', blurb: 'Docs & wikis.' },
  { kind: 'web', id: 'figma', label: 'Figma', url: 'https://figma.com', glyph: '🎨', color: '#a259ff', blurb: 'Design files.' },
  { kind: 'web', id: 'chatgpt', label: 'ChatGPT', url: 'https://chat.openai.com', glyph: '🤖', color: '#10a37f', blurb: 'Chat.' },
  // PowerSchool is per-district (you sign in at your own portal URL) and has no
  // public grades API — a native graderoom-style reskin can't be reliably built
  // or kept working across districts, so we embed your portal instead. Edit the
  // deck URL to your district (e.g. https://yourdistrict.powerschool.com).
  { kind: 'web', id: 'powerschool', label: 'PowerSchool', url: 'https://powerschool.com', glyph: '🎒', color: '#4f7cff', blurb: 'Grades & attendance — set your district URL.' }
]
