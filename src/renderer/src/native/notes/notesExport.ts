/**
 * Decks — Notes export (renderer process).
 *
 * Turns a Notes page (or the whole workspace) into a SELF-CONTAINED HTML
 * document: one .html file with every style INLINED in a <style> block, no
 * external assets, no JS. Opened in any browser (or emailed to someone) it
 * renders pixel-identically to the in-app editor — the colors below are the
 * app's design tokens (see renderer/src/index.css) resolved to concrete sRGB so
 * the file looks the same even where the app's CSS variables aren't present.
 *
 * Why HTML (not PDF/Markdown/JSON):
 *  - Pixel-faithful: it reproduces the exact DOM + styles the deck renders, so
 *    headings, callouts, quotes, todos, code, dividers all look identical.
 *  - Self-contained + portable: a single file, zero dependencies, opens in every
 *    browser and most mail clients — trivially shareable.
 *  - Future-proof for PDF: the recipient can "Print → Save as PDF" from this exact
 *    layout (a @media print block keeps it clean), so we get PDF for free without
 *    bundling a renderer.
 */

// ── Model (mirrors NotesDeck.tsx / providers/notes.ts) ──────────────────────

type BlockType =
  | 'h1'
  | 'h2'
  | 'h3'
  | 'paragraph'
  | 'todo'
  | 'bulleted'
  | 'numbered'
  | 'quote'
  | 'callout'
  | 'divider'
  | 'code'

export interface ExportBlock {
  id: string
  type: BlockType
  text?: string
  checked?: boolean
}

export interface ExportPage {
  id: string
  title: string
  icon?: string
  blocks: ExportBlock[]
}

// ── Resolved design tokens (dark theme, from index.css) ─────────────────────
// Concrete values so the file is identical anywhere. These mirror the oklch
// tokens the app uses; kept here as one small palette the template references.

const T = {
  bg: '#1c1d24', // --bg-card (page surface)
  txt1: '#f4f4f6', // --txt-1
  txt2: '#bcbdc4', // --txt-2
  txt3: '#9495a0', // --txt-3
  txt4: '#74757f', // --txt-4
  line: 'rgba(255,255,255,0.09)', // --line
  accent: '#5b8cff', // --accent
  accentSoft: 'rgba(91,140,255,0.16)', // --accent-soft
  elev: '#3b3d48', // --bg-elevated
  bgBody: '#242530' // outer body behind the card
} as const

// ── HTML escaping ───────────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Escape but preserve line breaks (textarea content can be multi-line). */
function escMultiline(s: string): string {
  return esc(s).replace(/\n/g, '<br>')
}

// ── Block → HTML ─────────────────────────────────────────────────────────────

/**
 * Render one block. Numbered lists need their running index, so the caller
 * passes it; everything else ignores it.
 */
function renderBlock(block: ExportBlock, numberedIndex: number): string {
  const text = block.text ?? ''
  switch (block.type) {
    case 'h1':
      return `<h1 class="b-h1">${escMultiline(text)}</h1>`
    case 'h2':
      return `<h2 class="b-h2">${escMultiline(text)}</h2>`
    case 'h3':
      return `<h3 class="b-h3">${escMultiline(text)}</h3>`
    case 'quote':
      return `<blockquote class="b-quote">${escMultiline(text)}</blockquote>`
    case 'callout':
      return `<div class="b-callout"><span class="b-callout-ic">💡</span><span>${escMultiline(
        text
      )}</span></div>`
    case 'code':
      return `<pre class="b-code"><code>${esc(text)}</code></pre>`
    case 'divider':
      return `<hr class="b-divider">`
    case 'todo':
      return `<div class="b-todo"><span class="b-check${
        block.checked ? ' on' : ''
      }">${block.checked ? '✓' : ''}</span><span class="${
        block.checked ? 'b-todo-done' : ''
      }">${escMultiline(text)}</span></div>`
    case 'bulleted':
      return `<div class="b-li"><span class="b-bullet">•</span><span>${escMultiline(
        text
      )}</span></div>`
    case 'numbered':
      return `<div class="b-li"><span class="b-num">${numberedIndex}.</span><span>${escMultiline(
        text
      )}</span></div>`
    case 'paragraph':
    default:
      return `<p class="b-p">${escMultiline(text)}</p>`
  }
}

/** Render the body (blocks) of one page, tracking numbered-list runs. */
function renderBlocks(blocks: ExportBlock[]): string {
  let run = 0
  const out: string[] = []
  for (const b of blocks) {
    if (b.type === 'numbered') run += 1
    else run = 0
    // Skip fully-empty paragraphs only when they're trailing-noise? Keep all so
    // spacing matches the editor exactly.
    out.push(renderBlock(b, run))
  }
  return out.join('\n        ')
}

/** Render one page's header + blocks (used for single-page and workspace export). */
function renderPage(page: ExportPage): string {
  const icon = page.icon || '📄'
  const title = page.title?.trim() || 'Untitled'
  return `      <article class="page">
        <header class="page-head">
          <span class="page-icon">${esc(icon)}</span>
          <h1 class="page-title">${esc(title)}</h1>
        </header>
        ${renderBlocks(page.blocks)}
      </article>`
}

// ── Shared CSS (inlined) ─────────────────────────────────────────────────────

function styles(): string {
  return `    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    html, body { margin: 0; }
    body {
      background: ${T.bgBody};
      color: ${T.txt1};
      font-family: 'Manrope', system-ui, -apple-system, 'Segoe UI', sans-serif;
      -webkit-font-smoothing: antialiased;
      padding: 40px 16px;
      line-height: 1.6;
    }
    .doc { max-width: 768px; margin: 0 auto; }
    .page {
      background: ${T.bg};
      border-radius: 20px;
      padding: 40px;
      box-shadow: 0 18px 40px -22px rgba(0,0,0,0.75), 0 2px 8px -2px rgba(0,0,0,0.4);
    }
    .page + .page { margin-top: 28px; }
    .page-head { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 24px; }
    .page-icon { font-size: 40px; line-height: 1; flex: none; }
    .page-title { margin: 4px 0 0; font-size: 30px; font-weight: 700; line-height: 1.2; color: ${T.txt1}; }
    .b-h1 { font-size: 24px; font-weight: 700; margin: 18px 0 6px; color: ${T.txt1}; }
    .b-h2 { font-size: 20px; font-weight: 700; margin: 16px 0 6px; color: ${T.txt1}; }
    .b-h3 { font-size: 18px; font-weight: 600; margin: 14px 0 6px; color: ${T.txt1}; }
    .b-p { font-size: 15px; margin: 4px 0; color: ${T.txt1}; }
    .b-quote { margin: 8px 0; padding-left: 14px; border-left: 2px solid ${T.accent};
      font-size: 16px; font-style: italic; color: ${T.txt2}; }
    .b-callout { display: flex; gap: 8px; align-items: flex-start; margin: 8px 0;
      padding: 10px 14px; border: 1px solid ${T.line}; background: ${T.accentSoft};
      border-radius: 8px; font-size: 14px; color: ${T.txt1}; }
    .b-callout-ic { flex: none; }
    .b-code { margin: 8px 0; padding: 12px 14px; background: ${T.elev}; border-radius: 8px;
      font-family: 'JetBrains Mono', ui-monospace, 'SFMono-Regular', Consolas, monospace;
      font-size: 13px; color: ${T.txt1}; white-space: pre-wrap; word-break: break-word; overflow-x: auto; }
    .b-divider { border: none; border-top: 1px solid ${T.line}; margin: 14px 0; }
    .b-todo, .b-li { display: flex; gap: 8px; align-items: flex-start; margin: 4px 0; font-size: 15px; color: ${T.txt1}; }
    .b-check { flex: none; width: 18px; height: 18px; border-radius: 4px; border: 1px solid ${T.txt3};
      display: inline-flex; align-items: center; justify-content: center; font-size: 12px;
      line-height: 1; margin-top: 2px; color: transparent; }
    .b-check.on { background: ${T.accent}; border-color: ${T.accent}; color: ${T.bg}; }
    .b-todo-done { color: ${T.txt3}; text-decoration: line-through; }
    .b-bullet { flex: none; color: ${T.txt2}; margin-top: 1px; }
    .b-num { flex: none; color: ${T.txt2}; min-width: 1.4em; }
    /* Print → Save as PDF keeps the same look on a clean white-margined page. */
    @media print {
      body { background: #fff; padding: 0; }
      .page { box-shadow: none; border-radius: 0; }
    }`
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Build a self-contained HTML document for a SINGLE page. */
export function pageToHtml(page: ExportPage): string {
  const docTitle = page.title?.trim() || 'Untitled'
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(docTitle)}</title>
  <style>
${styles()}
  </style>
</head>
<body>
  <div class="doc">
${renderPage(page)}
  </div>
</body>
</html>
`
}

/** Build a self-contained HTML document for the WHOLE workspace (all pages). */
export function workspaceToHtml(pages: ExportPage[], title = 'Notes'): string {
  const body = pages.length
    ? pages.map(renderPage).join('\n')
    : '      <article class="page"><p class="b-p">This workspace has no pages.</p></article>'
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <style>
${styles()}
  </style>
</head>
<body>
  <div class="doc">
${body}
  </div>
</body>
</html>
`
}

/** A filesystem-safe file name from a page title (without extension). */
export function safeFileName(title: string, fallback = 'note'): string {
  const base = (title || '').trim().replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim()
  return (base || fallback).slice(0, 80)
}
