/**
 * Route + surface tests for read-only URL sharing (ROAD-0011 P2 §3): the owner-authed mint/list/revoke
 * surface (/api/shares) AND the public server-rendered render surface (/s/<token>). This is an
 * UNAUTHENTICATED, externally-reachable surface, so the bar pins the security contract, not just the happy
 * path:
 *   - mint inserts an ANONYMOUS-principal grant (principalKind='anonymous', principalId=OWNER accountId,
 *     scope=['read']), returns the raw token + URL ONCE, persists ONLY the hash;
 *   - the public /s/<token> renders the note title + body server-side (no app bundle) and escapes content;
 *   - a notebook share renders a note list + per-note pages, each gated by the ONE grant (a note outside the
 *     notebook 404s);
 *   - revocation is IMMEDIATE — after DELETE, /s and /live both 404;
 *   - BOLA: account B can neither list nor revoke account A's share;
 *   - an AGENT token can NEVER mint a share (op:'share' 403s).
 *
 * Self-contained harness: better-sqlite3 → D1 shim + the real Hono app + the shared signupToken helper.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import app from '../src/index.js';
import type { Env } from '../src/env.js';
import { signupToken } from './helpers/passwordToken.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ALL_MIGRATIONS = [
  '0000_baseline.sql', '0001_stream-b-sync.sql', '0002_stream-a-auth.sql', '0003_account-identity.sql',
  '0004_password-auth.sql', '0005_recovery-established.sql', '0006_account-sync-seq.sql',
  '0007_reconcile-account-sync-seq.sql', '0008_notebooks.sql', '0009_backfill-default-notebooks.sql',
  '0010_nullable-notebookid-all-notes.sql', '0011_drop-isdefault-notebooksyncseg-notes_pull.sql',
  '0012_custom-dictionary.sql', '0013_agent-token-label.sql', '0014_grant-family-link.sql',
  '0015_audit-log.sql', '0016_usage-counter.sql', '0017_oauth-provider.sql', '0018_fts5-note-search.sql',
  '0019_note-routing-guide.sql', '0020_grant-sets.sql', '0021_oauth-refresh-token.sql',
  '0022_share-theme.sql',
].map((f) => readFileSync(join(__dirname, '../migrations', f), 'utf8'));

function d1Over(raw: Database.Database): D1Database {
  const prepare = (sql: string) => {
    const stmt = {
      sql,
      _params: [] as unknown[],
      bind(...p: unknown[]) { stmt._params = p; return stmt; },
      async first<T>() { return (raw.prepare(sql).get(...(stmt._params as never[])) ?? null) as T | null; },
      async all<T>() { return { results: raw.prepare(sql).all(...(stmt._params as never[])) as T[] }; },
      async run() { const info = raw.prepare(sql).run(...(stmt._params as never[])); return { meta: { rows_written: info.changes } }; },
    };
    return stmt;
  };
  return {
    prepare,
    async batch(prepared: Array<{ sql: string; _params: unknown[] }>) {
      return prepared.map((s) => {
        const info = raw.prepare(s.sql).run(...(s._params as never[]));
        return { meta: { rows_written: info.changes } };
      });
    },
  } as unknown as D1Database;
}

const makeEnv = (raw: Database.Database): Env =>
  ({ DB: d1Over(raw), ENVIRONMENT: 'development', AUTH_AUDIENCE: 'deltos.shares', AUTH_PEPPER: 'shares-pepper' } as unknown as Env);

const PW = 'correct-horse-battery-staple';
const now = new Date().toISOString();

function insertNote(raw: Database.Database, row: { id: string; notebookId: string | null; accountId: string; title: string; body?: unknown; version?: number; syncSeq?: number }) {
  raw.prepare(
    `INSERT INTO notes (id, notebookId, title, properties, body, version, createdAt, updatedAt, deletedAt, syncSeq, forkedFromId, accountId)
     VALUES (?, ?, ?, '{}', ?, ?, ?, ?, NULL, ?, NULL, ?)`,
  ).run(row.id, row.notebookId, row.title, JSON.stringify(row.body ?? []), row.version ?? 0, now, now, row.syncSeq ?? 0, row.accountId);
}
function insertNotebook(raw: Database.Database, row: { id: string; accountId: string; name: string; syncSeq?: number }) {
  raw.prepare(
    `INSERT INTO notebooks (id, accountId, name, defaultCollectionView, version, createdAt, updatedAt, deletedAt, syncSeq)
     VALUES (?, ?, ?, 'list', 1, ?, ?, NULL, ?)`,
  ).run(row.id, row.accountId, row.name, now, now, row.syncSeq ?? 0);
}

const post = (env: Env, path: string, body: unknown, token?: string) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }, env);
const get = (env: Env, path: string, token?: string) =>
  app.request(path, { headers: token ? { Authorization: `Bearer ${token}` } : {} }, env);
const del = (env: Env, path: string, token: string) =>
  app.request(path, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }, env);

const NOTE_ID = '11111111-1111-4111-8111-111111111111';
const NB_ID = '22222222-2222-4222-8222-222222222222';
const NOTE_IN_NB = '33333333-3333-4333-8333-333333333333';
const NOTE_OUTSIDE = '44444444-4444-4444-8444-444444444444';

const noteBody = [
  { id: '55555555-5555-4555-8555-555555555555', type: 'heading', content: { level: 1, segments: [{ text: 'Section' }] } },
  { id: '66666666-6666-4666-8666-666666666666', type: 'paragraph', content: { segments: [{ text: 'Body <b>text</b>' }] } },
];

describe('URL sharing — mint / render / live / revoke', () => {
  let raw: Database.Database;
  let env: Env;
  let owner: { token: string; accountId: string };

  beforeEach(async () => {
    raw = new Database(':memory:');
    for (const m of ALL_MIGRATIONS) raw.exec(m);
    env = makeEnv(raw);
    owner = await signupToken(env, 'owner_share', PW);
    insertNote(raw, { id: NOTE_ID, notebookId: null, accountId: owner.accountId, title: 'My <shared> note', body: noteBody, version: 3 });
  });

  async function mintNoteShare(): Promise<{ token: string; url: string; shareId: string }> {
    const res = await post(env, '/api/shares', { resourceType: 'note', resourceId: NOTE_ID }, owner.token);
    expect(res.status).toBe(201);
    return (await res.json()) as { token: string; url: string; shareId: string };
  }

  it('mints an anonymous read-only grant, returns the token+url once, persists only the hash', async () => {
    const body = await mintNoteShare();
    expect(body.token.startsWith('dltos_share_')).toBe(true);
    expect(body.url.endsWith(`/s/${body.token}`)).toBe(true);

    const rows = raw.prepare("SELECT principalKind, principalId, resourceKind, resourceId, scope, expiresAtMs FROM grants WHERE principalKind='anonymous'").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].principalKind).toBe('anonymous');
    expect(rows[0].principalId).toBe(owner.accountId); // owner accountId (belt + resolver scope)
    expect(rows[0].resourceKind).toBe('note');
    expect(rows[0].resourceId).toBe(NOTE_ID);
    expect(JSON.parse(rows[0].scope)).toEqual(['read']);
    expect(rows[0].expiresAtMs).toBeNull(); // non-expiring
    // The raw token is NEVER stored — only its hash lives in tokenHash.
    const hashRow = raw.prepare('SELECT tokenHash FROM grants WHERE grantId = ?').get(body.shareId) as any;
    expect(hashRow.tokenHash).not.toContain(body.token);
  });

  it('renders the shared note server-side (title + body), escaping content, with NO app bundle', async () => {
    const { token } = await mintNoteShare();
    const res = await get(env, `/s/${token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    expect(html).toContain('My &lt;shared&gt; note'); // escaped title
    expect(html).toContain('<h1>Section</h1>');
    expect(html).toContain('Body &lt;b&gt;text&lt;/b&gt;'); // escaped body content
    expect(html).not.toContain('<script type="module"'); // no SPA entry
  });

  it('renders the live pip as a bare dot inline by the title, with NO bottom status bar/label', async () => {
    const { token } = await mintNoteShare();
    const html = await (await get(env, `/s/${token}`)).text();
    // The live dot lives in the title row (inline next to the heading), not a bottom bar.
    expect(html).toContain('class="doc-title-row"');
    expect(html).toContain('id="share-dot"');
    expect(html).toContain('sync-indicator__dot'); // the sonar-ping dot visual is kept
    // The bottom status bar + its text label are gone.
    expect(html).not.toContain('share-foot');
    expect(html).not.toContain('id="share-status"');
    // The heartbeat still runs under the per-response nonce (no unsafe-inline for scripts).
    expect(html).toMatch(/<script nonce="[^"]+">/); // the poll script is nonce'd inline
    const csp = (await get(env, `/s/${token}`)).headers.get('content-security-policy') ?? '';
    expect(csp).toMatch(/script-src 'nonce-[^']+'/);
    expect(csp).not.toContain("script-src 'unsafe-inline'");
  });

  it('the /live heartbeat returns the note version, and increments are visible', async () => {
    const { token } = await mintNoteShare();
    const res = await get(env, `/s/${token}/live`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: 3, revoked: false });
    raw.prepare('UPDATE notes SET version = 4 WHERE id = ?').run(NOTE_ID);
    expect(await (await get(env, `/s/${token}/live`)).json()).toEqual({ version: 4, revoked: false });
  });

  it('lists live shares for the resource (never the token) and revokes immediately (guard #10)', async () => {
    const { token, shareId } = await mintNoteShare();
    const listRes = await get(env, `/api/shares?resourceType=note&resourceId=${NOTE_ID}`, owner.token);
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { shares: any[] };
    expect(list.shares).toHaveLength(1);
    expect(list.shares[0].shareId).toBe(shareId);
    expect(JSON.stringify(list.shares[0])).not.toContain(token);

    const revokeRes = await del(env, `/api/shares/${shareId}`, owner.token);
    expect(revokeRes.status).toBe(200);
    // Immediate: the public surface + heartbeat both go dead.
    expect((await get(env, `/s/${token}`)).status).toBe(404);
    expect((await get(env, `/s/${token}/live`)).status).toBe(404);
    // And it drops out of the owner's listing.
    const after = (await (await get(env, `/api/shares?resourceType=note&resourceId=${NOTE_ID}`, owner.token)).json()) as { shares: any[] };
    expect(after.shares).toHaveLength(0);
  });

  it('an unknown / malformed token 404s (no oracle) and records NO throttle row (resolve-before-limit)', async () => {
    expect((await get(env, '/s/dltos_share_not-a-real-token')).status).toBe(404);
    expect((await get(env, '/s/dltos_share_not-a-real-token/live')).status).toBe(404);
    // Resolve-before-limit: an unknown token performs no D1 rate-limit write, so unauthenticated probing of
    // random tokens leaves the throttle table empty (only KNOWN tokens get a bucket).
    const cnt = raw.prepare('SELECT COUNT(*) AS n FROM authThrottle').get() as { n: number };
    expect(cnt.n).toBe(0);
  });

  it('does not serve a note the owner has TRASHED (fail closed → 404)', async () => {
    const { token } = await mintNoteShare();
    // The share is live while the note is live.
    expect((await get(env, `/s/${token}`)).status).toBe(200);
    // Owner trashes the note (sys:trashedAt property flag) → the public surface fails closed.
    raw.prepare('UPDATE notes SET properties = ? WHERE id = ?')
      .run(JSON.stringify({ 'sys:trashedAt': { type: 'date', value: now } }), NOTE_ID);
    expect((await get(env, `/s/${token}`)).status).toBe(404);
  });

  it('STAMPS the owner theme at mint and renders it (data-* + light+dark tokens + voice @font-face + font-src)', async () => {
    // Mint WITH the owner's theme (ember × mono).
    const res = await post(env, '/api/shares', { resourceType: 'note', resourceId: NOTE_ID, palette: 'ember', voice: 'mono' }, owner.token);
    expect(res.status).toBe(201);
    const { token, shareId } = (await res.json()) as { token: string; shareId: string };

    // Persisted with the grant (JSON), enum-validated at the boundary.
    const themeRow = raw.prepare('SELECT shareTheme FROM grants WHERE grantId = ?').get(shareId) as { shareTheme: string | null };
    expect(JSON.parse(themeRow.shareTheme ?? '{}')).toEqual({ palette: 'ember', voice: 'mono' });

    const pageRes = await get(env, `/s/${token}`);
    const html = await pageRes.text();
    // The viewer's OS decides light/dark → data-mode="system" is FORCED, with the stamped palette + voice.
    expect(html).toContain('data-mode="system"');
    expect(html).toContain('data-palette="ember"');
    expect(html).toContain('data-voice="mono"');
    // The stamped palette's LIGHT tokens ride the tokens.css selector shape (light AND system match)...
    expect(html).toContain('[data-palette="ember"][data-mode="light"],[data-palette="ember"][data-mode="system"]');
    expect(html).toContain('--accent:#EE431C'); // ember light accent (verbatim from tokens.css)
    // ...and a prefers-color-scheme:dark media re-points system→dark.
    expect(html).toMatch(/@media \(prefers-color-scheme: dark\)\{\[data-palette="ember"\]\[data-mode="system"\]\{/);
    expect(html).toContain('--accent:#FF6242'); // ember dark accent
    // The stamped VOICE loads a same-origin woff2 @font-face.
    expect(html).toContain("@font-face{font-family:'IBM Plex Mono'");
    expect(html).toContain("src:url('/fonts/ibm-plex-mono-400.woff2') format('woff2')");
    // CSP now allows the font from same-origin, and keeps the nonce'd script (no unsafe-inline for scripts).
    const csp = pageRes.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("font-src 'self'");
    expect(csp).toMatch(/script-src 'nonce-[^']+'/);
    expect(csp).not.toContain("script-src 'unsafe-inline'");
  });

  it('a share with NO stamp (older client) falls back to graphite × sans, still system-aware', async () => {
    // Mint WITHOUT palette/voice — the pre-change client shape.
    const res = await post(env, '/api/shares', { resourceType: 'note', resourceId: NOTE_ID }, owner.token);
    const { token, shareId } = (await res.json()) as { token: string; shareId: string };
    // Nothing stamped on the grant.
    const themeRow = raw.prepare('SELECT shareTheme FROM grants WHERE grantId = ?').get(shareId) as { shareTheme: string | null };
    expect(themeRow.shareTheme).toBeNull();

    const html = await (await get(env, `/s/${token}`)).text();
    expect(html).toContain('data-palette="graphite"');
    expect(html).toContain('data-voice="sans"');
    expect(html).toContain('data-mode="system"');
    expect(html).toContain('[data-palette="graphite"][data-mode="light"],[data-palette="graphite"][data-mode="system"]');
    expect(html).toContain("@font-face{font-family:'IBM Plex Sans'");
  });

  it('REJECTS an off-enum palette at the mint boundary (no CSS injection reaches the render)', async () => {
    const res = await post(
      env,
      '/api/shares',
      { resourceType: 'note', resourceId: NOTE_ID, palette: '#000;}body{}', voice: 'sans' },
      owner.token,
    );
    // Strict enum → 400 at the schema boundary; nothing is stored.
    expect(res.status).toBe(400);
    const cnt = raw.prepare("SELECT COUNT(*) AS n FROM grants WHERE principalKind='anonymous'").get() as { n: number };
    expect(cnt.n).toBe(0);
  });
});

describe('URL sharing — notebook shares + per-note gating', () => {
  let raw: Database.Database;
  let env: Env;
  let owner: { token: string; accountId: string };

  beforeEach(async () => {
    raw = new Database(':memory:');
    for (const m of ALL_MIGRATIONS) raw.exec(m);
    env = makeEnv(raw);
    owner = await signupToken(env, 'owner_nb', PW);
    insertNotebook(raw, { id: NB_ID, accountId: owner.accountId, name: 'Trip <plans>', syncSeq: 5 });
    insertNote(raw, { id: NOTE_IN_NB, notebookId: NB_ID, accountId: owner.accountId, title: 'Inside', body: noteBody, version: 2, syncSeq: 7 });
    insertNote(raw, { id: NOTE_OUTSIDE, notebookId: null, accountId: owner.accountId, title: 'Outside', version: 1, syncSeq: 9 });
  });

  it('renders a notebook share as a note list, links to per-note pages, and gates each note by the grant', async () => {
    const res = await post(env, '/api/shares', { resourceType: 'notebook', resourceId: NB_ID }, owner.token);
    expect(res.status).toBe(201);
    const { token } = (await res.json()) as { token: string };

    const rootRes = await get(env, `/s/${token}`);
    expect(rootRes.status).toBe(200);
    const rootHtml = await rootRes.text();
    expect(rootHtml).toContain('Trip &lt;plans&gt;'); // notebook name escaped
    expect(rootHtml).toContain(`/s/${token}/n/${NOTE_IN_NB}`); // link to the covered note
    expect(rootHtml).not.toContain('Outside'); // a note NOT in the notebook is not listed

    // The covered note renders...
    const inRes = await get(env, `/s/${token}/n/${NOTE_IN_NB}`);
    expect(inRes.status).toBe(200);
    expect(await inRes.text()).toContain('<h1>Section</h1>');

    // ...but a note OUTSIDE the granted notebook is denied by the ONE grant (hierarchy coverage).
    expect((await get(env, `/s/${token}/n/${NOTE_OUTSIDE}`)).status).toBe(404);

    // /live returns the notebook revision (max note syncSeq).
    expect(await (await get(env, `/s/${token}/live`)).json()).toEqual({ version: 7, revoked: false });
  });

  it('does not serve a TRASHED note within a notebook share (fail closed → 404, dropped from list)', async () => {
    const res = await post(env, '/api/shares', { resourceType: 'notebook', resourceId: NB_ID }, owner.token);
    const { token } = (await res.json()) as { token: string };
    // The covered note is live → per-note page 200 and listed.
    expect((await get(env, `/s/${token}/n/${NOTE_IN_NB}`)).status).toBe(200);
    // Owner trashes it → the per-note page fails closed and the root list drops it.
    raw.prepare('UPDATE notes SET properties = ? WHERE id = ?')
      .run(JSON.stringify({ 'sys:trashedAt': { type: 'date', value: now } }), NOTE_IN_NB);
    expect((await get(env, `/s/${token}/n/${NOTE_IN_NB}`)).status).toBe(404);
    expect(await (await get(env, `/s/${token}`)).text()).not.toContain(`/n/${NOTE_IN_NB}`);
  });
});

describe('URL sharing — access control (BOLA + agent-cannot-share)', () => {
  let raw: Database.Database;
  let env: Env;
  let alice: { token: string; accountId: string };
  let bob: { token: string; accountId: string };

  beforeEach(async () => {
    raw = new Database(':memory:');
    for (const m of ALL_MIGRATIONS) raw.exec(m);
    env = makeEnv(raw);
    alice = await signupToken(env, 'alice_s', PW);
    bob = await signupToken(env, 'bob_s', PW);
    insertNote(raw, { id: NOTE_ID, notebookId: null, accountId: alice.accountId, title: 'Alice note', body: noteBody, version: 1 });
  });

  it('B cannot mint, list, or revoke a share of A\'s note (guard #3)', async () => {
    // B cannot mint a share of A's resource (ownership validation → 404).
    expect((await post(env, '/api/shares', { resourceType: 'note', resourceId: NOTE_ID }, bob.token)).status).toBe(404);

    // A mints; B cannot revoke it (BOLA → 404), and A's share stays live.
    const { shareId, token } = (await (await post(env, '/api/shares', { resourceType: 'note', resourceId: NOTE_ID }, alice.token)).json()) as any;
    expect((await del(env, `/api/shares/${shareId}`, bob.token)).status).toBe(404);
    expect((await get(env, `/s/${token}`)).status).toBe(200);
  });

  it('an AGENT token can NEVER mint a share (op:share 403 — guard #8)', async () => {
    // Mint a read-only agent token (step-up = the account password).
    const mintRes = await post(env, '/api/agent-tokens', { password: PW }, alice.token);
    expect(mintRes.status).toBe(201);
    const agentToken = ((await mintRes.json()) as { token: string }).token;
    // The agent token holds ['read','search'] — no 'share' — so the mint chokepoint 403s.
    const res = await post(env, '/api/shares', { resourceType: 'note', resourceId: NOTE_ID }, agentToken);
    expect(res.status).toBe(403);
  });

  it('a read-capable AGENT token used AS a /s/ share token 404s (public surface = anonymous grants only)', async () => {
    // Mint a read-capable agent token, then paste it into the PUBLIC share surface. Even though it can
    // read via the app/MCP, the /s/* surface resolves ONLY anonymous share grants → 404 (LOW-1).
    const mintRes = await post(env, '/api/agent-tokens', { password: PW }, alice.token);
    const agentToken = ((await mintRes.json()) as { token: string }).token;
    expect((await get(env, `/s/${agentToken}`)).status).toBe(404);
    expect((await get(env, `/s/${agentToken}/live`)).status).toBe(404);
  });
});
