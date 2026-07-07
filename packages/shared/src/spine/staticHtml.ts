import type { Block } from './block.js';
import { ATTACHMENT_PLUGIN_TYPE, type AttachmentContent } from './attachmentBlock.js';

/**
 * spineToHtml — the read-only render core for the PUBLIC URL-share surface (ROAD-0011 P2 §3). A PURE
 * `Block[] → semantic HTML string`, the outbound sibling of {@link markdownToBody} (the inbound parse).
 * It lives in @deltos/shared (not the client) because the render is SERVER-SIDE (CONV-0004: the outbound
 * render is `spine→output` on the worker, NEVER the client bundle serving strangers — assumption guard #9),
 * and the worker cannot import client code.
 *
 * SECURITY (this is unauthenticated output): EVERY piece of note content is HTML-escaped — text, attribute
 * values, and hrefs — so a note body can never inject markup or script into the page. Link hrefs are
 * additionally scheme-gated (http/https/mailto only) so a stored `javascript:`/`data:` URL degrades to inert
 * text. Output is DETERMINISTIC (no randomness, stable child order) so the same spine always renders the same
 * bytes.
 *
 * Attachment blocks resolve their blob URL through the injected {@link SpineHtmlOptions.attachmentUrl} — the
 * caller (the share route) points it at the TOKEN-SCOPED blob endpoint (`/s/<token>/blob/<hash>`), access-
 * checked against the share grant, never an account session. Formula/compute inline atoms carry only their
 * SOURCE spec in the spine (the computed value is recomputed on render and never stored — serializer.ts), so
 * the read-only render shows the source text (assumption guard #7: no half-adopted state, just render truth).
 */

export interface SpineHtmlOptions {
  /**
   * Resolve an attachment block to a servable URL (image src / download href). The share route passes a
   * token-scoped resolver (`/s/<token>/blob/<hash>`); omitted ⇒ the attachment renders as inert filename
   * text (no live URL). A resolver that returns `null` for a given attachment (e.g. a blob it can't resolve)
   * renders the same inert filename as an omitted resolver — the render already null-checks the result.
   * Return value is escaped as an attribute by the renderer.
   */
  attachmentUrl?: (att: AttachmentContent) => string | null;
}

/** Escape text for HTML text content (`&`, `<`, `>`). */
function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Escape a string for use inside a double-quoted HTML attribute. */
function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Gate a link href to an inert-safe scheme. Only http/https/mailto pass; anything else (javascript:, data:,
 * vbscript:, unparseable) returns null so the caller renders the link text WITHOUT an anchor. Relative URLs
 * (no scheme) are allowed as-is — they resolve against the share origin, harmless.
 */
function safeHref(href: string): string | null {
  // Strip ALL C0 controls + spaces (U+0000–U+0020) before the scheme match, mirroring the browser URL
  // parser (which removes U+0009/0A/0D from ANYWHERE in a URL and trims leading/trailing controls+space).
  // Otherwise a scheme split by a control char — `java\tscript:` / `java\nscript:` — slips past the
  // allowlist here yet the browser still parses it as a live `javascript:` scheme. We gate on the sanitized
  // form `t` and, when allowed, EMIT `t` so the rendered href is exactly what the browser would parse.
  const t = href.replace(/[\u0000-\u0020]/g, '');
  // A scheme is `word chars + :` at the very start. No scheme ⇒ relative ⇒ allowed.
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(t);
  if (!schemeMatch) return t;
  const scheme = (schemeMatch[1] ?? '').toLowerCase();
  return scheme === 'http' || scheme === 'https' || scheme === 'mailto' ? t : null;
}

// ── inline segments ────────────────────────────────────────────────────────────────────────────
//
// The spine stores a text-bearing block's `content.segments` as an opaque array; each entry mirrors the
// editor's TextSegment ({ text, bold?, italic?, code?, underline?, strike?, highlight?, formula?, link? }).
// Read defensively — content crosses the sync boundary and may be any shape.

interface Seg {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  underline?: boolean;
  strike?: boolean;
  highlight?: boolean;
  formula?: boolean;
  link?: string;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

function parseSegments(raw: unknown): Seg[] {
  if (!Array.isArray(raw)) return [];
  const out: Seg[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item['text'] !== 'string' || item['text'].length === 0) continue;
    const seg: Seg = { text: item['text'] };
    if (item['bold'] === true) seg.bold = true;
    if (item['italic'] === true) seg.italic = true;
    if (item['code'] === true) seg.code = true;
    if (item['underline'] === true) seg.underline = true;
    if (item['strike'] === true) seg.strike = true;
    if (item['highlight'] === true) seg.highlight = true;
    // A formula/compute inline atom (or the legacy math mark): show its SOURCE spec (value not stored).
    if (isRecord(item['formula']) || item['math'] === true) seg.formula = true;
    if (typeof item['link'] === 'string') seg.link = item['link'];
    out.push(seg);
  }
  return out;
}

/** Render one inline segment: escape its text, wrap in mark elements, then (safely) in a link. */
function renderSegment(seg: Seg): string {
  // A hard-break segment (text === '\n') becomes a <br>.
  if (seg.text === '\n') return '<br>';
  let html = escapeText(seg.text);
  if (seg.formula) html = `<span class="dltos-formula">${html}</span>`;
  if (seg.code) html = `<code>${html}</code>`;
  if (seg.highlight) html = `<mark>${html}</mark>`;
  if (seg.strike) html = `<s>${html}</s>`;
  if (seg.underline) html = `<u>${html}</u>`;
  if (seg.italic) html = `<em>${html}</em>`;
  if (seg.bold) html = `<strong>${html}</strong>`;
  if (seg.link !== undefined) {
    const href = safeHref(seg.link);
    if (href !== null) {
      html = `<a href="${escapeAttr(href)}" rel="noopener nofollow ugc" target="_blank">${html}</a>`;
    }
  }
  return html;
}

function renderInline(rawSegments: unknown): string {
  return parseSegments(rawSegments).map(renderSegment).join('');
}

// ── block-level content parsers (defensive; content is `unknown`) ────────────────────────────────

function segmentsOf(content: unknown): unknown {
  return isRecord(content) ? content['segments'] : undefined;
}

function headingLevel(content: unknown): 1 | 2 | 3 | 4 | 5 | 6 {
  const lvl = isRecord(content) ? content['level'] : undefined;
  return lvl === 2 || lvl === 3 || lvl === 4 || lvl === 5 || lvl === 6 ? lvl : 1;
}

// ── block rendering ──────────────────────────────────────────────────────────────────────────────

function renderAttachment(block: Block, opts: SpineHtmlOptions): string {
  const c = block.content;
  if (!isRecord(c) || typeof c['hash'] !== 'string' || typeof c['name'] !== 'string') {
    return '<p class="dltos-attachment dltos-attachment--broken">[attachment]</p>';
  }
  const att: AttachmentContent = {
    hash: c['hash'],
    name: c['name'],
    mime: typeof c['mime'] === 'string' ? c['mime'] : 'application/octet-stream',
    size: typeof c['size'] === 'number' ? c['size'] : 0,
  };
  const url = opts.attachmentUrl ? opts.attachmentUrl(att) : null;
  const nameHtml = escapeText(att.name);
  const isImage = att.mime.startsWith('image/');
  if (url === null) {
    // No resolver (e.g. a unit render without a token) — inert filename, never a dead/guessable link.
    return `<p class="dltos-attachment"><span class="dltos-attachment__name">${nameHtml}</span></p>`;
  }
  const src = escapeAttr(url);
  if (isImage) {
    return `<figure class="dltos-attachment dltos-attachment--image"><img src="${src}" alt="${escapeAttr(att.name)}" loading="lazy"></figure>`;
  }
  return `<p class="dltos-attachment dltos-attachment--file"><a href="${src}" download>${nameHtml}</a></p>`;
}

/** The inner markup of a todo (a disabled checkbox + its inline text). Shared by list-item + top-level todo. */
function renderTodoInner(block: Block): string {
  const checked = isRecord(block.content) && block.content['checked'] === true;
  const box = `<input type="checkbox" disabled${checked ? ' checked' : ''}>`;
  return `${box} <span class="dltos-todo__label">${renderInline(segmentsOf(block.content))}</span>`;
}

/** Render a list item block (a `paragraph` or `todo` block) plus any nested list children, as an `<li>`. */
function renderListItem(item: Block, opts: SpineHtmlOptions): string {
  const inner =
    item.type === 'todo'
      ? renderTodoInner(item)
      : renderInline(segmentsOf(item.content));
  const nested = (item.children ?? [])
    .filter((c) => c.type === 'list')
    .map((c) => renderBlock(c, opts))
    .join('');
  return `<li>${inner}${nested}</li>`;
}

/** Render ONE block to HTML. `divider` and unknown/empty blocks degrade gracefully. */
function renderBlock(block: Block, opts: SpineHtmlOptions): string {
  switch (block.type) {
    case 'heading': {
      const lvl = headingLevel(block.content);
      return `<h${lvl}>${renderInline(segmentsOf(block.content))}</h${lvl}>`;
    }
    case 'paragraph':
      return `<p>${renderInline(segmentsOf(block.content))}</p>`;
    case 'quote': {
      const first = renderInline(segmentsOf(block.content));
      const rest = (block.children ?? []).map((c) => renderBlock(c, opts)).join('');
      const firstHtml = first.length > 0 ? `<p>${first}</p>` : '';
      return `<blockquote>${firstHtml}${rest}</blockquote>`;
    }
    case 'code': {
      const code = isRecord(block.content) && typeof block.content['code'] === 'string' ? block.content['code'] : '';
      const lang = isRecord(block.content) && typeof block.content['language'] === 'string' ? block.content['language'] : null;
      const langAttr = lang ? ` class="language-${escapeAttr(lang)}"` : '';
      return `<pre><code${langAttr}>${escapeText(code)}</code></pre>`;
    }
    case 'todo':
      return `<div class="dltos-todo">${renderTodoInner(block)}</div>`;
    case 'divider':
      return '<hr>';
    case 'list': {
      const ordered = isRecord(block.content) && block.content['ordered'] === true;
      const tag = ordered ? 'ol' : 'ul';
      const items = (block.children ?? []).map((item) => renderListItem(item, opts)).join('');
      return `<${tag}>${items}</${tag}>`;
    }
    case ATTACHMENT_PLUGIN_TYPE:
      return renderAttachment(block, opts);
    default:
      // Unknown / plugin block with no server renderer: if it carries inline segments (a text-bearing
      // variant) render those; otherwise omit it entirely (never leak an opaque payload as markup).
      return renderInline(segmentsOf(block.content));
  }
}

/**
 * Render a spine block body to a semantic HTML string — the read-only public-share render (P2 §3). Pure +
 * deterministic; every content byte is HTML-escaped. Attachment URLs resolve through
 * {@link SpineHtmlOptions.attachmentUrl} (token-scoped). Top-level blocks render in order; nesting (list
 * items, quote children) recurses.
 */
export function spineToHtml(blocks: Block[], opts: SpineHtmlOptions = {}): string {
  return blocks.map((b) => renderBlock(b, opts)).join('');
}

/** Escape a bare string as HTML text content — exported for the surrounding page (title, notebook name). */
export function escapeHtmlText(s: string): string {
  return escapeText(s);
}

/** Escape a bare string for an HTML attribute value — exported for the surrounding page shell. */
export function escapeHtmlAttr(s: string): string {
  return escapeAttr(s);
}
