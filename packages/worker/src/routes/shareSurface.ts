import { Hono } from 'hono';
import {
  spineToHtml,
  escapeHtmlText,
  escapeHtmlAttr,
  isTrashed,
  type Block,
  type PropertyBag,
  type Resource,
  type AttachmentContent,
  type RequestPrincipal,
} from '@deltos/shared';
import type { AppEnv, AppContext } from '../context.js';
import { canWith, resolveTokenPrincipal, resolvedGrantFor, type CanContext } from '../auth.js';
import { createResourceOwnerResolver } from '../db/resourceOwner.js';
import { createAuthStore, type AuthStore } from '../db/authStore.js';
import { d1Adapter, type DbAdapter, type NoteRow } from '../db/schema.js';
import { getNoteForAccount } from '../db/accountScope.js';
import {
  getNotebookForAccount,
  listNotesInNotebookForAccount,
  notebookRevision,
} from '../db/shareReads.js';
import { fixedWindowAllow } from '../rateLimit.js';
import { hashToken, randomToken } from '../authCrypto.js';
import { SAFE_INLINE_TYPES, safeServeType } from '../blobStore.js';

/**
 * PUBLIC read-only URL-share surface (ROAD-0011 P2 §3) — `/s/<token>`. A SEPARATE, SW-INDEPENDENT,
 * SERVER-RENDERED surface (assumption guard #9 / CONV-0004): it never serves the notes app shell and never
 * loads a client bundle — the note is rendered to static HTML on the worker (`spineToHtml`) and returned
 * `no-store`, cookie-less. Mirrors the OAuth consent surface's separation (wrangler `run_worker_first`,
 * SW navigation-denylist), except this one renders HTML directly instead of serving an asset entry.
 *
 * ENFORCEMENT (assumption guard #1) — every request resolves the URL token → the anonymous capability
 * principal (`resolveTokenPrincipal`) and runs the SAME `canWith(principal,'read',resource)` chokepoint the
 * PWA/MCP use, with the P1 owner-resolver so a NOTEBOOK share covers its notes (hierarchy) and a moved-out or
 * trashed/deleted note falls out. Revocation is IMMEDIATE (guard #10): each request re-resolves, and a
 * revoked/expired grant fails `grantIsLive` inside `canWith`. No parallel checker, no cached authority.
 *
 * EXPOSURE POSTURE (§3): nothing beyond the note — no owner identifiers (the opt-in display name is out of
 * v1), no notebook structure outside the grant, no tokens/session state. The render is cookie-less static
 * output.
 */
export const shareSurface = new Hono<AppEnv>();

// Per-token rate buckets (DEC-0004 two-tier fixed window, reusing the authThrottle counter). A leaked URL
// can be throttled then revoked. The page/blob bucket is generous for a real viewer but caps a scraper; the
// /live bucket is SEPARATE and far larger so a 15s heartbeat poll (4/min) never trips it.
const PAGE_RATE = { limit: 240, windowMs: 60_000 } as const; // page + blob reads, per token
const LIVE_RATE = { limit: 600, windowMs: 60_000 } as const; // /live heartbeat, per token (own allowance)

interface ShareContext {
  db: DbAdapter;
  store: AuthStore;
  principal: RequestPrincipal;
  /** The single resource this share grants (a share is a one-row grant set). */
  resource: Resource;
  /** The owner account the grant is stamped to (principal.id) — the scope for all owner-relative reads. */
  ownerAccountId: string;
  can: CanContext;
}

/**
 * Resolve `token` to its live anonymous-share context, or null (unknown token → 404). Does NOT yet run the
 * per-resource `can()` decision — the caller does that against the specific resource it is serving.
 */
async function resolveShare(c: AppContext, token: string): Promise<ShareContext | null> {
  const db = d1Adapter(c.env.DB);
  const store = createAuthStore(db);
  const principal = await resolveTokenPrincipal(store, token);
  if (!principal) return null;
  // The PUBLIC /s/* surface resolves ONLY anonymous share grants. A read-capable agent/session token
  // pasted as `/s/<token>` must NOT render the resource here (that path is the app/MCP, not this surface).
  if (principal.kind !== 'anonymous') return null;
  const grants = resolvedGrantFor(principal);
  const grant = grants?.[0];
  if (!grant) return null;
  return {
    db,
    store,
    principal,
    resource: grant.resource,
    ownerAccountId: principal.id,
    can: { resolveResourceOwner: createResourceOwnerResolver(db) },
  };
}

/** Fixed-window per-token throttle. Fail-open on an unbound/erroring store (never block a legit viewer). */
async function underRate(store: AuthStore, prefix: string, token: string, policy: { limit: number; windowMs: number }): Promise<boolean> {
  try {
    return await fixedWindowAllow(store, `${prefix}:${hashToken(token)}`, policy.limit, policy.windowMs, Date.now());
  } catch {
    return true;
  }
}

// ── HTML rendering ─────────────────────────────────────────────────────────────────────────────

/**
 * The full standalone HTML document for a share page. Server-rendered, self-contained (inline critical CSS +
 * one nonce'd heartbeat script), no app bundle, no cookies. The sonar-ping dot CSS is COPIED from the client
 * SyncIndicator (#105) — reused as pure CSS (the React component is wired to the client sync engine, which
 * does not exist here). The heartbeat is a DELIBERATE, documented carve-out to assumption-guard #9: a
 * viewer-facing liveness poll only — it sends no cookies, carries no owner state, and only ever reveals a
 * monotonic version number the viewer is already authorized to see.
 */
function renderSharePage(opts: {
  headingHtml: string; // already-escaped/rendered title or notebook name
  metaLabel: string; // "Shared note" | "Shared notebook"
  contentHtml: string;
  token: string;
  version: number;
  kind: 'note' | 'notebook';
  backHref: string | null;
  nonce: string;
}): string {
  const backLink = opts.backHref
    ? `<a class="share-back" href="${escapeHtmlAttr(opts.backHref)}">&larr; Back</a>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" media="(prefers-color-scheme: light)" content="#F2F2F4">
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#111113">
<meta name="referrer" content="no-referrer">
<title>${escapeHtmlText(opts.metaLabel)} · deltos</title>
<style>
:root { color-scheme: light dark; --paper:#fff; --ink:#17171a; --secondary:#6e6e76; --border:#e7e7eb; --sync:#34c759; --faint:#9a9aa3; }
@media (prefers-color-scheme: dark) { :root { --paper:#1a1a1d; --ink:#f0f0f2; --secondary:#9a9aa3; --border:#2a2a2e; --sync:#30d158; --faint:#6e6e76; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--paper); color:var(--ink); font:16px/1.65 -apple-system,system-ui,"IBM Plex Sans",sans-serif; -webkit-font-smoothing:antialiased; }
.share-wrap { max-width:44rem; margin:0 auto; padding:2rem 1.25rem 6rem; }
.share-head { display:flex; align-items:center; gap:.5rem; color:var(--secondary); font-size:.8rem; letter-spacing:.02em; text-transform:uppercase; margin-bottom:1rem; }
.share-back { display:inline-block; margin-bottom:1rem; color:var(--secondary); text-decoration:none; font-size:.9rem; }
.share-back:hover { color:var(--ink); }
h1.doc-title { font-size:1.9rem; line-height:1.2; margin:.2rem 0 1.2rem; }
article :is(h1,h2,h3,h4,h5,h6) { line-height:1.25; margin:1.6rem 0 .6rem; }
article p { margin:.6rem 0; }
article pre { background:rgba(127,127,127,.12); padding:.8rem 1rem; border-radius:8px; overflow:auto; }
article code { font-family:"IBM Plex Mono",ui-monospace,monospace; font-size:.9em; }
article pre code { font-size:.85rem; }
article blockquote { margin:1rem 0; padding:.2rem 0 .2rem 1rem; border-left:3px solid var(--border); color:var(--secondary); }
article hr { border:0; border-top:1px solid var(--border); margin:1.6rem 0; }
article img { max-width:100%; height:auto; border-radius:8px; }
.dltos-todo { display:flex; align-items:baseline; gap:.5rem; }
.dltos-formula { font-family:"IBM Plex Mono",ui-monospace,monospace; background:rgba(127,127,127,.12); padding:0 .25em; border-radius:4px; }
.note-list { list-style:none; padding:0; margin:0; }
.note-list li { border-bottom:1px solid var(--border); }
.note-list a { display:block; padding:.85rem .25rem; color:var(--ink); text-decoration:none; }
.note-list a:hover { color:var(--sync); }
.share-foot { position:fixed; left:0; right:0; bottom:0; display:flex; align-items:center; justify-content:center; gap:.6rem; padding:.6rem; background:color-mix(in srgb, var(--paper) 88%, transparent); backdrop-filter:blur(8px); border-top:1px solid var(--border); font-size:.85rem; color:var(--secondary); }
.share-reload { appearance:none; border:1px solid var(--border); background:var(--paper); color:var(--ink); border-radius:999px; padding:.35rem .8rem; font-size:.85rem; cursor:pointer; }
/* #105 sonar-ping dot — COPIED from client SyncIndicator.css, reused as pure CSS (no React component here). */
.sync-indicator { position:relative; display:inline-flex; align-items:center; justify-content:center; line-height:0; }
.sync-indicator__dot { width:8px; height:8px; border-radius:50%; background:var(--sync); flex-shrink:0; }
.sync-indicator--synced .sync-indicator__dot { background:var(--sync); }
.sync-indicator--error .sync-indicator__dot { background:#E0A52E; }
.sync-indicator--offline .sync-indicator__dot { background:var(--faint); opacity:.7; }
.sync-indicator__ring { position:absolute; top:50%; left:50%; width:8px; height:8px; margin:-4px 0 0 -4px; border-radius:50%; border:1.5px solid var(--sync); pointer-events:none; animation:sync-blip-ping 1.8s ease-out infinite; }
.sync-indicator:not(.sync-indicator--synced) .sync-indicator__ring { display:none; }
@keyframes sync-blip-ping { 0%{opacity:.5;transform:scale(.9);} 60%{opacity:0;transform:scale(2.6);} 100%{opacity:0;transform:scale(2.6);} }
@media (prefers-reduced-motion: reduce) { .sync-indicator__ring { display:none; } }
</style>
</head>
<body>
<div class="share-wrap">
${backLink}
<div class="share-head">${escapeHtmlText(opts.metaLabel)}</div>
${opts.headingHtml}
${opts.contentHtml}
</div>
<div class="share-foot">
<span class="sync-indicator sync-indicator--synced" id="share-dot"><span class="sync-indicator__dot"></span><span class="sync-indicator__ring"></span></span>
<span id="share-status">Live</span>
<button class="share-reload" id="share-reload" hidden></button>
</div>
<span id="share-live" data-token="${escapeHtmlAttr(opts.token)}" data-version="${String(opts.version)}" data-kind="${opts.kind}" hidden></span>
<script nonce="${escapeHtmlAttr(opts.nonce)}">
(function(){
  var el=document.getElementById('share-live');if(!el)return;
  var token=el.getAttribute('data-token');var rendered=Number(el.getAttribute('data-version'));
  var dot=document.getElementById('share-dot');var status=document.getElementById('share-status');var btn=document.getElementById('share-reload');
  function set(cls,text){dot.className='sync-indicator '+cls;status.textContent=text;}
  btn.addEventListener('click',function(){if(btn.getAttribute('data-mode')==='reload')location.reload();});
  function poll(){
    fetch('/s/'+encodeURIComponent(token)+'/live',{cache:'no-store'}).then(function(r){
      if(r.status!==200)throw new Error('dead');return r.json();
    }).then(function(d){
      if(d.version>rendered){set('sync-indicator--error','Updated');btn.hidden=false;btn.setAttribute('data-mode','reload');btn.textContent='New version — reload';}
      else{set('sync-indicator--synced','Live');btn.hidden=true;}
    }).catch(function(e){
      set('sync-indicator--offline', e&&e.message==='dead'?'Link no longer available':'Offline');
      if(e&&e.message==='dead'){btn.hidden=false;btn.setAttribute('data-mode','dead');btn.textContent='This link is no longer available';}
    });
  }
  poll();setInterval(poll,15000);
})();
</script>
</body>
</html>`;
}

/** Common response headers for a share PAGE: no-store, cookie-less, strict CSP (nonce'd inline script). */
function pageHeaders(nonce: string): Record<string, string> {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    // default-src 'none' — nothing loads unless explicitly allowed. img from same-origin (token-scoped blob),
    // inline style allowed, script ONLY via the per-response nonce (so even a hypothetical escaping bug can't
    // run injected inline script), fetch to same-origin (/live). No framing, no base, no forms.
    'Content-Security-Policy':
      `default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  };
}

/** A minimal "this link is not available" page (unknown/revoked/deleted) — same posture, 404. */
function notFoundPage(nonce: string): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Not available · deltos</title><style>:root{color-scheme:light dark;}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#fff;color:#17171a;font:16px/1.6 -apple-system,system-ui,sans-serif;}@media(prefers-color-scheme:dark){body{background:#1a1a1d;color:#f0f0f2;}}main{text-align:center;padding:2rem;}</style></head><body><main><h1>This link isn't available</h1><p>The share link may have been revoked or the content removed.</p></main></body></html>`;
  return new Response(html, { status: 404, headers: pageHeaders(nonce) });
}

/** Render a single note (title + body) → HTML content for the page shell. */
function renderNoteContent(note: NoteRow, token: string): { headingHtml: string; contentHtml: string } {
  const body = safeParseBody(note.body);
  const bodyHtml = spineToHtml(body, {
    // Attachments resolve through the TOKEN-SCOPED blob endpoint (access-checked against THIS grant), never
    // an account session — the render never emits an app-origin authenticated blob URL.
    attachmentUrl: (att: AttachmentContent) => `/s/${token}/blob/${att.hash}`,
  });
  return {
    headingHtml: `<h1 class="doc-title">${escapeHtmlText(note.title)}</h1>`,
    contentHtml: `<article>${bodyHtml}</article>`,
  };
}

/** Parse a NoteRow.body JSON to Block[] defensively (a malformed body renders empty, never throws). */
function safeParseBody(raw: string): Block[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Block[]) : [];
  } catch {
    return [];
  }
}

/** Parse a NoteRow.properties JSON defensively. */
function safeParseProps(raw: string): PropertyBag {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as PropertyBag) : {};
  } catch {
    return {};
  }
}

// ── routes ───────────────────────────────────────────────────────────────────────────────────────
//
// Multi-segment routes are registered BEFORE the bare `/:token` so Hono matches the specific ones first.

/** GET /s/:token/live — the heartbeat probe (cheap; own generous rate bucket). JSON, never HTML. */
shareSurface.get('/:token/live', async (c: AppContext) => {
  const token = c.req.param('token') ?? '';
  // Resolve the token FIRST — an unknown/invalid token 404s with NO rate-limit D1 write (only KNOWN tokens
  // get a rate bucket, so probing random tokens performs no write). Revoked/invalid → 404.
  const ctx = await resolveShare(c, token);
  if (!ctx) return c.json({ revoked: true }, 404, { 'X-Content-Type-Options': 'nosniff' });
  if (!(await underRate(ctx.store, 'share-live', token, LIVE_RATE))) {
    return c.json({ revoked: true }, 429, { 'X-Content-Type-Options': 'nosniff' });
  }
  const allowed = await canWith(ctx.can, ctx.principal, 'read', ctx.resource);
  if (!allowed) return c.json({ revoked: true }, 404, { 'X-Content-Type-Options': 'nosniff' });

  let version = 0;
  if (ctx.resource.kind === 'note') {
    const note = await getNoteForAccount(ctx.db, ctx.ownerAccountId, ctx.resource.id);
    if (!note) return c.json({ revoked: true }, 404, { 'X-Content-Type-Options': 'nosniff' });
    version = note.version;
  } else if (ctx.resource.kind === 'notebook') {
    version = await notebookRevision(ctx.db, ctx.ownerAccountId, ctx.resource.id);
  }
  return c.json({ version, revoked: false }, 200, { 'X-Content-Type-Options': 'nosniff' });
});

/** GET /s/:token/blob/:hash — token-scoped blob serving (image src / download), access-checked vs THIS grant. */
shareSurface.get('/:token/blob/:hash', async (c: AppContext) => {
  const token = c.req.param('token') ?? '';
  const hash = c.req.param('hash') ?? '';
  // Resolve the token FIRST — an unknown/invalid token 404s with NO rate-limit D1 write (only KNOWN tokens
  // get a rate bucket, so probing random tokens performs no write).
  const ctx = await resolveShare(c, token);
  if (!ctx) return new Response('not found', { status: 404 });
  if (!(await underRate(ctx.store, 'share', token, PAGE_RATE))) {
    return new Response('rate limited', { status: 429 });
  }
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return new Response('bad request', { status: 400 });

  // Liveness/revocation gate at the SAME chokepoint (guard #1/#10).
  if (!(await canWith(ctx.can, ctx.principal, 'read', ctx.resource))) return new Response('not found', { status: 404 });
  if (!c.env.BLOBS) return new Response('not found', { status: 404 });

  // ACCESS-CHECK vs THIS grant (not an account session): the hash MUST be referenced by a note the grant
  // covers, so a share link can't be used to fetch arbitrary blobs in the owner's account by guessing hashes.
  if (!(await blobReferencedInShare(ctx, hash))) return new Response('not found', { status: 404 });

  // The blob key is the OWNER's server-derived prefix (principal.id) — never a client value.
  const object = await c.env.BLOBS.get(`${ctx.ownerAccountId}/${hash}`);
  if (!object) return new Response('not found', { status: 404 });

  const stored = object.customMetadata?.['mime'] ?? object.httpMetadata?.contentType;
  const contentType = safeServeType(stored);
  // Images (in the safe set) serve INLINE so <img> works; everything else downloads. nosniff + a fully
  // sandboxed CSP still ride along so a stored file can never execute as active content (mirrors blob.ts).
  const inline = stored !== undefined && SAFE_INLINE_TYPES.has(stored);
  return new Response(object.body, {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': inline ? 'inline' : 'attachment',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, no-store',
    },
  });
});

/** GET /s/:token/n/:noteId — a single note within a NOTEBOOK share (each note gated by the one grant). */
shareSurface.get('/:token/n/:noteId', async (c: AppContext) => {
  const token = c.req.param('token') ?? '';
  const noteId = c.req.param('noteId') ?? '';
  const nonce = randomToken(16);
  // Resolve the token FIRST — an unknown/invalid token 404s with NO rate-limit D1 write (only KNOWN tokens
  // get a rate bucket, so probing random tokens performs no write).
  const ctx = await resolveShare(c, token);
  if (!ctx) return notFoundPage(nonce);
  if (!(await underRate(ctx.store, 'share', token, PAGE_RATE))) {
    return new Response('rate limited', { status: 429, headers: { 'Cache-Control': 'no-store' } });
  }

  // THE per-note gate (guard #1 + hierarchy): can(read, note) passes IFF the note currently lives in the
  // granted notebook AND the owner matches — a note moved out of the notebook, or a note-scoped share asked
  // for a different note, is denied here (canWith owner-resolver + belt).
  const noteResource = { kind: 'note', id: noteId } as Resource;
  if (!(await canWith(ctx.can, ctx.principal, 'read', noteResource))) return notFoundPage(nonce);

  const note = await getNoteForAccount(ctx.db, ctx.ownerAccountId, noteId);
  if (!note) return notFoundPage(nonce);
  // Fail CLOSED on a trashed note: the owner trashed it, so it must NOT be publicly served (matches the
  // list filter). Share-surface only — the shared resolver intentionally still exposes trashed rows to
  // agent-token reads.
  if (isTrashed(safeParseProps(note.properties))) return notFoundPage(nonce);

  const { headingHtml, contentHtml } = renderNoteContent(note, token);
  const backHref = ctx.resource.kind === 'notebook' ? `/s/${token}` : null;
  const html = renderSharePage({
    headingHtml,
    metaLabel: 'Shared note',
    contentHtml,
    token,
    version: note.version,
    kind: 'note',
    backHref,
    nonce,
  });
  return new Response(html, { status: 200, headers: pageHeaders(nonce) });
});

/** GET /s/:token — the share root: a note (render it) or a notebook (render its note list). */
shareSurface.get('/:token', async (c: AppContext) => {
  const token = c.req.param('token') ?? '';
  const nonce = randomToken(16);
  // Resolve the token FIRST — an unknown/invalid token 404s with NO rate-limit D1 write (only KNOWN tokens
  // get a rate bucket, so probing random tokens performs no write).
  const ctx = await resolveShare(c, token);
  if (!ctx) return notFoundPage(nonce);
  if (!(await underRate(ctx.store, 'share', token, PAGE_RATE))) {
    return new Response('rate limited', { status: 429, headers: { 'Cache-Control': 'no-store' } });
  }

  // Access decision at the SAME chokepoint against the granted resource (liveness/revocation gate).
  if (!(await canWith(ctx.can, ctx.principal, 'read', ctx.resource))) return notFoundPage(nonce);

  if (ctx.resource.kind === 'note') {
    const note = await getNoteForAccount(ctx.db, ctx.ownerAccountId, ctx.resource.id);
    if (!note) return notFoundPage(nonce);
    // Fail CLOSED on a trashed note (see /n/:noteId) — a note the owner trashed is not publicly served.
    if (isTrashed(safeParseProps(note.properties))) return notFoundPage(nonce);
    const { headingHtml, contentHtml } = renderNoteContent(note, token);
    const html = renderSharePage({
      headingHtml,
      metaLabel: 'Shared note',
      contentHtml,
      token,
      version: note.version,
      kind: 'note',
      backHref: null,
      nonce,
    });
    return new Response(html, { status: 200, headers: pageHeaders(nonce) });
  }

  if (ctx.resource.kind === 'notebook') {
    const notebook = await getNotebookForAccount(ctx.db, ctx.ownerAccountId, ctx.resource.id);
    if (!notebook) return notFoundPage(nonce);
    const notes = await listNotesInNotebookForAccount(ctx.db, ctx.ownerAccountId, ctx.resource.id);
    // Hide trashed notes so the read-only render matches the app's list (exposure posture: nothing extra).
    const visible = notes.filter((n) => !isTrashed(safeParseProps(n.properties)));
    const items = visible
      .map((n) => {
        const title = n.title.trim().length > 0 ? n.title : 'Untitled';
        return `<li><a href="/s/${escapeHtmlAttr(token)}/n/${escapeHtmlAttr(n.id)}">${escapeHtmlText(title)}</a></li>`;
      })
      .join('');
    const listHtml =
      visible.length > 0 ? `<ul class="note-list">${items}</ul>` : '<p class="share-empty">No notes to show.</p>';
    const version = await notebookRevision(ctx.db, ctx.ownerAccountId, ctx.resource.id);
    const html = renderSharePage({
      headingHtml: `<h1 class="doc-title">${escapeHtmlText(notebook.name)}</h1>`,
      metaLabel: 'Shared notebook',
      contentHtml: listHtml,
      token,
      version,
      kind: 'notebook',
      backHref: null,
      nonce,
    });
    return new Response(html, { status: 200, headers: pageHeaders(nonce) });
  }

  // A workspace share is not a v1 surface (shares are note/notebook only).
  return notFoundPage(nonce);
});

/**
 * Is `hash` referenced by a note this grant covers? The reference check scopes token-served blobs to the
 * shared content: a NOTE share covers its own note; a NOTEBOOK share covers its live notes. The hash is a
 * 64-hex SHA-256 that appears verbatim in an attachment block's stored JSON, so a substring test over the raw
 * body is a correct + cheap membership check (the hash's entropy makes an incidental match impossible).
 */
async function blobReferencedInShare(ctx: ShareContext, hash: string): Promise<boolean> {
  if (ctx.resource.kind === 'note') {
    const note = await getNoteForAccount(ctx.db, ctx.ownerAccountId, ctx.resource.id);
    return note !== null && note.body.includes(hash);
  }
  if (ctx.resource.kind === 'notebook') {
    const notes = await listNotesInNotebookForAccount(ctx.db, ctx.ownerAccountId, ctx.resource.id);
    return notes.some((n) => n.body.includes(hash));
  }
  return false;
}
