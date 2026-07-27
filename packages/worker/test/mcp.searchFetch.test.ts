/**
 * ChatGPT MCP connector tools — `search` + `fetch` (docs/specs/chatgpt-mcp-connector-spec.md §2, §5).
 *
 * Purely additive read-only tools with an exact OpenAI connector contract. These tests pin that
 * contract + the isolation belt; they deliberately do NOT soft-assert key names (a wrong key is a
 * silent ChatGPT connector failure).
 *
 *   • search → {results:[{id,title,url}]} ; url = `https://${AUTH_AUDIENCE}/note/<id>` (canonical host,
 *     NOT request origin — anti-Host-spoof) ; empty query rejected
 *   • fetch  → {id,title,text,url,metadata} ; text is spineToMarkdown output (not raw spine JSON)
 *   • 🚨 BOLA: account B cannot fetch account A's note
 *   • Cross-notebook: notebook-scoped token cannot fetch an out-of-scope note (real can() deny)
 *   • tools/list advertises both tools to a read-only token
 *
 * Self-contained harness mirrors mcp.routes.test.ts / writeTools.redteam.test.ts:
 * better-sqlite3 → D1 shim + real Hono app + signupToken.
 *
 * TDD-friendly: red until S1 lands the tools in packages/worker/src/mcp/tools.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import app from '../src/index.js';
import type { Env } from '../src/env.js';
import { signupToken } from './helpers/passwordToken.js';
import { allMigrations } from './helpers/migrations.js';

const ALL_MIGRATIONS = allMigrations();

function d1Over(raw: Database.Database): D1Database {
  const prepare = (sql: string) => {
    const stmt = {
      sql,
      _params: [] as unknown[],
      bind(...p: unknown[]) {
        stmt._params = p;
        return stmt;
      },
      async first<T>() {
        return (raw.prepare(sql).get(...(stmt._params as never[])) ?? null) as T | null;
      },
      async all<T>() {
        return { results: raw.prepare(sql).all(...(stmt._params as never[])) as T[] };
      },
      async run() {
        const info = raw.prepare(sql).run(...(stmt._params as never[]));
        return { meta: { rows_written: info.changes } };
      },
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

const AUD = 'deltos.mcp.searchFetch';
/** Origin used in requests so noteUrl assertions pin a real absolute citation URL. */
const ORIGIN = 'https://deltos.example.test';
const makeEnv = (raw: Database.Database): Env =>
  ({
    DB: d1Over(raw),
    ENVIRONMENT: 'development',
    AUTH_AUDIENCE: AUD,
    AUTH_PEPPER: 'mcp-searchfetch-pepper',
  }) as unknown as Env;

interface JsonRpcResult {
  jsonrpc: string;
  id: unknown;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
}

const rpc = (env: Env, payload: unknown, token?: string) =>
  app.request(`${ORIGIN}/api/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
  }, env);

async function rawCall(
  env: Env,
  token: string,
  name: string,
  args: unknown,
): Promise<JsonRpcResult> {
  const res = await rpc(
    env,
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } },
    token,
  );
  return (await res.json()) as JsonRpcResult;
}

/** tools/call → the McpToolResult (JSON-RPC result.result). */
async function call(env: Env, token: string, name: string, args: unknown): Promise<any> {
  return (await rawCall(env, token, name, args)).result;
}

async function mintAgentToken(
  env: Env,
  ownerToken: string,
  ownerPassword: string,
  opts: { resources?: Array<{ kind: string; id: string | null }> } = {},
): Promise<{ token: string; grantId: string }> {
  const res = await app.request(`${ORIGIN}/api/agent-tokens`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${ownerToken}`,
    },
    body: JSON.stringify({
      label: 'test-searchfetch',
      password: ownerPassword,
      ...(opts.resources ? { resources: opts.resources } : {}),
    }),
  }, env);
  if (res.status !== 201) throw new Error(`mint failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as {
    token: string;
    resources: Array<{ grantId: string }>;
  };
  return { token: body.token, grantId: body.resources[0].grantId };
}

async function createNote(
  env: Env,
  ownerToken: string,
  opts: {
    title: string;
    bodyText?: string;
    notebookId?: string | null;
    body?: unknown[];
  },
): Promise<string> {
  const id = randomUUID();
  const body =
    opts.body ??
    (opts.bodyText
      ? [
          {
            id: randomUUID(),
            type: 'paragraph',
            content: { segments: [{ text: opts.bodyText }] },
          },
        ]
      : []);
  const res = await app.request(`${ORIGIN}/api/notes`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${ownerToken}`,
    },
    body: JSON.stringify({
      id,
      notebookId: opts.notebookId ?? null,
      title: opts.title,
      properties: {},
      body,
    }),
  }, env);
  if (res.status !== 201) throw new Error(`createNote failed: ${res.status} ${await res.text()}`);
  return id;
}

describe('MCP ChatGPT connector tools — search + fetch (spec §2/§5)', () => {
  let env: Env;
  let raw: Database.Database;
  let ownerA: string;
  let passA: string;
  let accountA: string;
  let agentA: string;

  beforeEach(async () => {
    raw = new Database(':memory:');
    for (const m of ALL_MIGRATIONS) raw.exec(m);
    env = makeEnv(raw);
    passA = 'mcp-sf-owner-password';
    ({ token: ownerA, accountId: accountA } = await signupToken(env, 'mcp-sf-owner', passA));
    ({ token: agentA } = await mintAgentToken(env, ownerA, passA));
  });

  // --- tools/list ---------------------------------------------------------------------------------

  it("tools/list includes 'search' and 'fetch' for a read-only token", async () => {
    const res = await rpc(env, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, agentA);
    expect(res.status).toBe(200);
    const body = (await res.json()) as JsonRpcResult;
    expect(body.error).toBeUndefined();
    const names = (body.result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain('search');
    expect(names).toContain('fetch');
    // Still advertised as read-only surface companions — no write ops required.
    expect(names).toContain('search_notes');
    expect(names).toContain('get_note');
  });

  // --- search -------------------------------------------------------------------------------------

  it('search returns {results:[{id,title,url}]} with citation url matching ${origin}/note/<id>', async () => {
    const noteId = await createNote(env, ownerA, {
      title: 'Weekly grocery list',
      bodyText: 'milk eggs bread',
    });

    const envelope = await rawCall(env, agentA, 'search', { query: 'grocery' });
    expect(envelope.error, `search must be a known tool: ${envelope.error?.message}`).toBeUndefined();
    const r = envelope.result;
    expect(r).toBeDefined();
    expect(r.isError).toBeUndefined();
    // Exact §2 shape — wrong key name must fail.
    expect(r.structuredContent).toEqual(
      expect.objectContaining({
        results: expect.any(Array),
      }),
    );
    const results = r.structuredContent.results as Array<{
      id: string;
      title: string;
      url: string;
    }>;
    expect(results.length).toBeGreaterThan(0);
    const hit = results.find((x) => x.id === noteId);
    expect(hit).toBeDefined();
    expect(hit!.title).toBe('Weekly grocery list');
    // Citation URL is built from the CONFIGURED deployment host (AUTH_AUDIENCE), NOT the request
    // origin — proving a spoofed Host can't poison ChatGPT citations. Note ORIGIN (deltos.example.test)
    // deliberately differs from AUD (deltos.mcp.searchFetch); the url must carry AUD, not ORIGIN.
    expect(hit!.url).toBe(`https://${AUD}/note/${noteId}`);
    // No extra keys ChatGPT would ignore as "wrong shape" on the hit itself — pin the triad.
    expect(Object.keys(hit!).sort()).toEqual(['id', 'title', 'url']);
  });

  it('search empty query is rejected by argsSchema (JSON-RPC invalid-params -32602)', async () => {
    const envelope = await rawCall(env, agentA, 'search', { query: '' });
    // Must be schema rejection of the known tool — NOT "unknown tool" (that would pass pre-S1 for the wrong reason).
    expect(envelope.error?.code).toBe(-32602);
    expect(envelope.error?.message).toMatch(/invalid tool arguments/i);
    expect(envelope.error?.message).not.toMatch(/unknown tool/i);
    expect(envelope.result).toBeUndefined();
  });

  it('search missing query is rejected by argsSchema', async () => {
    const envelope = await rawCall(env, agentA, 'search', {});
    expect(envelope.error?.code).toBe(-32602);
    expect(envelope.error?.message).toMatch(/invalid tool arguments/i);
    expect(envelope.error?.message).not.toMatch(/unknown tool/i);
  });

  // --- fetch --------------------------------------------------------------------------------------

  it('fetch returns {id,title,text,url,metadata}; text is MARKDOWN not raw spine JSON', async () => {
    const headingId = randomUUID();
    const paraId = randomUUID();
    const noteId = await createNote(env, ownerA, {
      title: 'Project Alpha',
      body: [
        {
          id: headingId,
          type: 'heading',
          content: { level: 2, segments: [{ text: 'Goals' }] },
        },
        {
          id: paraId,
          type: 'paragraph',
          content: { segments: [{ text: 'Ship the connector' }] },
        },
      ],
    });

    const envelope = await rawCall(env, agentA, 'fetch', { id: noteId });
    expect(envelope.error, `fetch must be a known tool: ${envelope.error?.message}`).toBeUndefined();
    const r = envelope.result;
    expect(r).toBeDefined();
    expect(r.isError).toBeUndefined();
    const doc = r.structuredContent as {
      id: string;
      title: string;
      text: string;
      url: string;
      metadata: Record<string, unknown>;
    };
    // Exact top-level keys per §2.
    expect(Object.keys(doc).sort()).toEqual(['id', 'metadata', 'text', 'title', 'url']);
    expect(doc.id).toBe(noteId);
    expect(doc.title).toBe('Project Alpha');
    // Canonical (AUTH_AUDIENCE) origin, not the request origin — anti-Host-spoof (see search test).
    expect(doc.url).toBe(`https://${AUD}/note/${noteId}`);
    expect(doc.metadata).toEqual(
      expect.objectContaining({
        notebookId: null,
        updatedAt: expect.any(String),
      }),
    );

    // text is human markdown (spineToMarkdown), NOT a JSON-serialized spine.
    expect(typeof doc.text).toBe('string');
    expect(doc.text).toMatch(/#\s*Project Alpha/); // title line from spineToMarkdown({title})
    expect(doc.text).toMatch(/Goals/);
    expect(doc.text).toMatch(/Ship the connector/);
    // Raw spine leak detectors — body is NOT re-emitted as JSON blocks/segments.
    expect(doc.text).not.toMatch(/"type"\s*:\s*"heading"/);
    expect(doc.text).not.toMatch(/"segments"/);
    expect(doc.text).not.toContain(headingId);
    expect(doc.text).not.toContain(paraId);
  });

  it('fetch unknown id → toolError (handled isError, not protocol error)', async () => {
    const missing = randomUUID();
    const envelope = await rawCall(env, agentA, 'fetch', { id: missing });
    // Protocol-level unknown-tool must NOT satisfy this — tool must exist and return a handled error.
    expect(envelope.error).toBeUndefined();
    const r = envelope.result;
    expect(r).toBeDefined();
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/not found/i);
    expect(r.structuredContent).toBeUndefined();
  });

  it('fetch invalid id is rejected at the args boundary (-32602)', async () => {
    const envelope = await rawCall(env, agentA, 'fetch', { id: 'not-a-uuid' });
    expect(envelope.error?.code).toBe(-32602);
    expect(envelope.error?.message).toMatch(/invalid tool arguments/i);
    expect(envelope.error?.message).not.toMatch(/unknown tool/i);
  });

  // --- 🚨 BOLA / isolation (load-bearing) ---------------------------------------------------------

  it("🚨 CROSS-ACCOUNT: account B's token cannot fetch account A's note (denied, no leak)", async () => {
    const aNoteId = await createNote(env, ownerA, {
      title: 'A private secret note',
      bodyText: 'the passphrase is xylophone-42',
    });
    const { token: ownerB } = await signupToken(env, 'mcp-sf-attacker', 'mcp-sf-attacker-password');
    const { token: agentB } = await mintAgentToken(env, ownerB, 'mcp-sf-attacker-password');

    const envelope = await rawCall(env, agentB, 'fetch', { id: aNoteId });
    expect(envelope.error, `fetch must exist: ${envelope.error?.message}`).toBeUndefined();
    const r = envelope.result;
    expect(r.isError).toBe(true);
    // not found OR scope/forbidden — either is a denial; content must never leak.
    expect(r.content[0].text).toMatch(/not found|forbidden|not authorized|scope/i);
    const blob = JSON.stringify(r);
    expect(blob).not.toContain('A private secret note');
    expect(blob).not.toContain('xylophone-42');
  });

  it("🚨 CROSS-NOTEBOOK: notebook-scoped token cannot fetch an out-of-scope note (real can() deny)", async () => {
    const iso = new Date().toISOString();
    const inNb = randomUUID();
    const outNb = randomUUID();
    // Two notebooks owned by A; token is granted ONLY on inNb.
    raw
      .prepare(
        `INSERT INTO notebooks (id, accountId, name, defaultCollectionView, version, createdAt, updatedAt, deletedAt, syncSeq)
         VALUES (?, ?, 'in-scope', 'list', 1, ?, ?, NULL, 0)`,
      )
      .run(inNb, accountA, iso, iso);
    raw
      .prepare(
        `INSERT INTO notebooks (id, accountId, name, defaultCollectionView, version, createdAt, updatedAt, deletedAt, syncSeq)
         VALUES (?, ?, 'out-of-scope', 'list', 1, ?, ?, NULL, 0)`,
      )
      .run(outNb, accountA, iso, iso);

    const inNoteId = await createNote(env, ownerA, {
      title: 'Inside grant',
      bodyText: 'visible body',
      notebookId: inNb,
    });
    const outNoteId = await createNote(env, ownerA, {
      title: 'Outside grant secret',
      bodyText: 'should-not-leak',
      notebookId: outNb,
    });

    const { token: scoped } = await mintAgentToken(env, ownerA, passA, {
      resources: [{ kind: 'notebook', id: inNb }],
    });

    // In-scope fetch is allowed — proves the token works and the path is live.
    const okEnv = await rawCall(env, scoped, 'fetch', { id: inNoteId });
    expect(okEnv.error, `fetch must exist: ${okEnv.error?.message}`).toBeUndefined();
    const ok = okEnv.result;
    expect(ok.isError).toBeUndefined();
    expect(ok.structuredContent.id).toBe(inNoteId);
    expect(ok.structuredContent.text).toMatch(/visible body/);

    // Out-of-scope: must be denied at the can() chokepoint (hierarchy coverage), NOT a mocked gate.
    // Mirror of get_note's resource/op so the same belt decides — expect forbidden (not a silent empty).
    const denied = await call(env, scoped, 'fetch', { id: outNoteId });
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toMatch(/forbidden|not authorized/i);
    const blob = JSON.stringify(denied);
    expect(blob).not.toContain('Outside grant secret');
    expect(blob).not.toContain('should-not-leak');

    // Audit scoreboard: the deny was recorded on the mcp surface (proves can() ran, not a fake short-circuit).
    const denyRow = raw
      .prepare(
        `SELECT result, detail, resourceKind, resourceId FROM auditLog
         WHERE surface = 'mcp' AND detail = 'fetch' AND resourceId = ? AND result = 'deny'
         ORDER BY rowid DESC LIMIT 1`,
      )
      .get(outNoteId) as
      | { result: string; detail: string; resourceKind: string; resourceId: string }
      | undefined;
    expect(denyRow).toBeDefined();
    expect(denyRow!.resourceKind).toBe('note');
  });

  it('search never returns another account\'s note (BOLA on the search path too)', async () => {
    await createNote(env, ownerA, {
      title: 'A only',
      bodyText: 'unique-token-zebra-99',
    });
    const { token: ownerB } = await signupToken(env, 'mcp-sf-search-b', 'mcp-sf-search-b-pw');
    const { token: agentB } = await mintAgentToken(env, ownerB, 'mcp-sf-search-b-pw');

    const envelope = await rawCall(env, agentB, 'search', { query: 'unique-token-zebra-99' });
    expect(envelope.error, `search must exist: ${envelope.error?.message}`).toBeUndefined();
    const r = envelope.result;
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent.results).toEqual([]);
    expect(JSON.stringify(r)).not.toContain('unique-token-zebra-99');
    expect(JSON.stringify(r)).not.toContain('A only');
  });
});
