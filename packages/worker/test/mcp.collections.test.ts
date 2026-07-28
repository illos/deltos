/**
 * MCP collection tools (collections.md §6): list/get/create/update/delete + add/remove notes.
 * Security bar:
 *   - read-only token is DENIED every collection write tool and never SEES them in tools/list;
 *   - 🚨 BOLA: account B cannot get/list/mutate account A's collection (not found / empty);
 *   - create → add → get round-trip; add_notes idempotent + same-notebook conflict;
 *   - delete cascades members.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import app from '../src/index.js';
import type { Env } from '../src/env.js';
import { signupToken } from './helpers/passwordToken.js';
import { allMigrations } from './helpers/migrations.js';
import type { AgentWriteOpt } from '@deltos/shared';

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

const AUD = 'deltos.mcp.collections';
const makeEnv = (raw: Database.Database): Env =>
  ({
    DB: d1Over(raw),
    ENVIRONMENT: 'development',
    AUTH_AUDIENCE: AUD,
    AUTH_PEPPER: 'mcp-collections-pepper',
  }) as unknown as Env;

interface JsonRpcResult {
  jsonrpc: string;
  id: unknown;
  result?: any;
  error?: { code: number; message: string };
}

const rpc = (env: Env, payload: unknown, token?: string) =>
  app.request(
    '/api/mcp',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload),
    },
    env,
  );

async function call(env: Env, token: string, name: string, args: unknown): Promise<any> {
  const res = await rpc(
    env,
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } },
    token,
  );
  return ((await res.json()) as JsonRpcResult).result;
}

async function toolContent(env: Env, token: string, name: string, args: unknown): Promise<any> {
  const r = await call(env, token, name, args);
  if (r?.isError) return r;
  return r?.structuredContent ?? r;
}

async function mintAgentToken(
  env: Env,
  ownerToken: string,
  ownerPassword: string,
  write?: AgentWriteOpt,
  resources?: Array<{ kind: string; id?: string }>,
): Promise<{ token: string; scope: string[]; status: number; body: any }> {
  const res = await app.request(
    '/api/agent-tokens',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({
        label: 'col-agent',
        password: ownerPassword,
        ...(write ? { write } : {}),
        ...(resources ? { resources } : {}),
      }),
    },
    env,
  );
  const body = await res.json();
  if (res.status !== 201) {
    return { token: '', scope: [], status: res.status, body };
  }
  const ok = body as { token: string; scope: string[] };
  return { token: ok.token, scope: ok.scope, status: res.status, body: ok };
}

const WRITE_ALL: AgentWriteOpt = { create: true, update: true, trash: true };

const WRITE_TOOL_NAMES = [
  'create_collection',
  'update_collection',
  'delete_collection',
  'add_notes_to_collection',
  'remove_notes_from_collection',
] as const;

describe('MCP collection tools', () => {
  let env: Env;
  let ownerA: string;
  let passA: string;
  let ownerB: string;
  let passB: string;

  beforeEach(async () => {
    const raw = new Database(':memory:');
    for (const m of ALL_MIGRATIONS) raw.exec(m);
    env = makeEnv(raw);
    passA = 'col-owner-a-password';
    passB = 'col-owner-b-password';
    ({ token: ownerA } = await signupToken(env, 'col-owner-a', passA));
    ({ token: ownerB } = await signupToken(env, 'col-owner-b', passB));
  });

  it('read-only token is DENIED all collection write tools and never sees them in tools/list', async () => {
    const { token: readTok, scope } = await mintAgentToken(env, ownerA, passA);
    expect(scope).not.toContain('create');
    expect(scope).not.toContain('write');
    expect(scope).not.toContain('delete');

    const listed = await call(env, readTok, 'tools/list', {});
    // tools/list is a method, not a tool — call JSON-RPC method directly
    const listRes = await rpc(
      env,
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      readTok,
    );
    const tools = ((await listRes.json()) as JsonRpcResult).result?.tools as Array<{ name: string }>;
    const names = new Set(tools.map((t) => t.name));
    for (const w of WRITE_TOOL_NAMES) {
      expect(names.has(w)).toBe(false);
    }
    // read tools ARE advertised
    expect(names.has('list_collections')).toBe(true);
    expect(names.has('get_collection')).toBe(true);

    // Direct calls denied at chokepoint
    const nb = await toolContent(env, ownerA, 'create_notebook', { name: 'Work' });
    // owner session isn't MCP agent — seed via write agent instead
    void listed;
    void nb;

    const { token: writeTok } = await mintAgentToken(env, ownerA, passA, WRITE_ALL);
    const notebook = await toolContent(env, writeTok, 'create_notebook', { name: 'Work' });
    const notebookId = notebook.notebook.id as string;
    const created = await toolContent(env, writeTok, 'create_collection', {
      name: 'Folder',
      notebookId,
    });
    expect(created.status).toBe('applied');
    const collectionId = created.collection.id as string;

    for (const name of WRITE_TOOL_NAMES) {
      const args =
        name === 'create_collection'
          ? { name: 'X', notebookId }
          : name === 'update_collection'
            ? { collectionId, name: 'Renamed' } // must carry a field — empty update is invalid params
            : name === 'add_notes_to_collection' || name === 'remove_notes_from_collection'
              ? { collectionId, noteIds: ['00000000-0000-4000-8000-000000000001'] }
              : { collectionId };
      const r = await call(env, readTok, name, args);
      // can() denial surfaces as isError tool result (content text mentions forbidden).
      expect(r?.isError).toBe(true);
      expect(JSON.stringify(r)).toMatch(/forbidden|not authorized|denied|scope/i);
    }
  });

  it('create → add → get round-trip; list scoped; delete cascades', async () => {
    const { token } = await mintAgentToken(env, ownerA, passA, WRITE_ALL);

    const nb = await toolContent(env, token, 'create_notebook', { name: 'Work' });
    const notebookId = nb.notebook.id as string;

    const col = await toolContent(env, token, 'create_collection', {
      name: 'Folder',
      notebookId,
      icon: 'folder',
    });
    expect(col.status).toBe('applied');
    const collectionId = col.collection.id as string;

    const note = await toolContent(env, token, 'create_note', {
      title: 'Hello',
      text: 'body',
      notebookId,
    });
    const noteId = note.note.id as string;

    const added = await toolContent(env, token, 'add_notes_to_collection', {
      collectionId,
      noteIds: [noteId],
    });
    expect(added.results[0]).toEqual({ noteId, outcome: 'added' });

    // Idempotent re-add
    const again = await toolContent(env, token, 'add_notes_to_collection', {
      collectionId,
      noteIds: [noteId],
    });
    expect(again.results[0].outcome).toBe('added');

    const got = await toolContent(env, token, 'get_collection', { collectionId });
    expect(got.collection.name).toBe('Folder');
    expect(got.notes.some((n: { id: string }) => n.id === noteId)).toBe(true);

    const listed = await toolContent(env, token, 'list_collections', { notebookId });
    expect(listed.collections).toHaveLength(1);
    expect(listed.collections[0].memberCount).toBe(1);

    // get_note enrichment
    const full = await toolContent(env, token, 'get_note', { id: noteId });
    expect(full.collections.some((c: { id: string }) => c.id === collectionId)).toBe(true);

    const del = await toolContent(env, token, 'delete_collection', { collectionId });
    expect(del.status).toBe('applied');
    const after = await toolContent(env, token, 'list_collections', {});
    expect(after.collections).toHaveLength(0);
  });

  it('add_notes surfaces same-notebook conflict for a note in another notebook', async () => {
    const { token } = await mintAgentToken(env, ownerA, passA, WRITE_ALL);
    const nb1 = await toolContent(env, token, 'create_notebook', { name: 'A' });
    const nb2 = await toolContent(env, token, 'create_notebook', { name: 'B' });
    const col = await toolContent(env, token, 'create_collection', {
      name: 'InA',
      notebookId: nb1.notebook.id,
    });
    const noteB = await toolContent(env, token, 'create_note', {
      title: 'in B',
      text: 'x',
      notebookId: nb2.notebook.id,
    });
    const r = await toolContent(env, token, 'add_notes_to_collection', {
      collectionId: col.collection.id,
      noteIds: [noteB.note.id],
    });
    expect(r.results[0].outcome).toBe('conflict');
  });

  it('🚨 BOLA: account B cannot get/list/mutate account A collection', async () => {
    const { token: tokA } = await mintAgentToken(env, ownerA, passA, WRITE_ALL);
    const { token: tokB } = await mintAgentToken(env, ownerB, passB, WRITE_ALL);

    const nb = await toolContent(env, tokA, 'create_notebook', { name: 'Private' });
    const col = await toolContent(env, tokA, 'create_collection', {
      name: 'Secret',
      notebookId: nb.notebook.id,
    });
    const collectionId = col.collection.id as string;
    const note = await toolContent(env, tokA, 'create_note', {
      title: 'n',
      text: 'x',
      notebookId: nb.notebook.id,
    });
    await toolContent(env, tokA, 'add_notes_to_collection', {
      collectionId,
      noteIds: [note.note.id],
    });

    // B's list is empty (account-scoped)
    const listed = await toolContent(env, tokB, 'list_collections', {});
    expect(listed.collections).toHaveLength(0);

    // get → not found (no leak of name)
    const got = await call(env, tokB, 'get_collection', { collectionId });
    expect(got.isError).toBe(true);
    expect(JSON.stringify(got)).not.toMatch(/Secret/);
    expect(got.content[0].text).toMatch(/not found/i);

    // mutate → not found (account isolation)
    const add = await call(env, tokB, 'add_notes_to_collection', {
      collectionId,
      noteIds: [note.note.id],
    });
    expect(add.isError).toBe(true);
    expect(add.content[0].text).toMatch(/not found/i);

    // A's data intact
    const still = await toolContent(env, tokA, 'get_collection', { collectionId });
    expect(still.collection.name).toBe('Secret');
    expect(still.notes).toHaveLength(1);
  });

  it('write token advertises collection write tools; create_note can file into collectionIds', async () => {
    const { token } = await mintAgentToken(env, ownerA, passA, WRITE_ALL);
    const listRes = await rpc(
      env,
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      token,
    );
    const tools = ((await listRes.json()) as JsonRpcResult).result?.tools as Array<{ name: string }>;
    const names = new Set(tools.map((t) => t.name));
    for (const w of WRITE_TOOL_NAMES) expect(names.has(w)).toBe(true);

    const nb = await toolContent(env, token, 'create_notebook', { name: 'Work' });
    const col = await toolContent(env, token, 'create_collection', {
      name: 'Inbox',
      notebookId: nb.notebook.id,
    });
    const created = await toolContent(env, token, 'create_note', {
      title: 'Filed',
      text: 'hi',
      notebookId: nb.notebook.id,
      collectionIds: [col.collection.id],
    });
    expect(created.status).toBe('applied');
    expect(created.collectionResults?.[0]?.outcome).toBe('added');
    expect(created.note.collections.some((c: { id: string }) => c.id === col.collection.id)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Red-team catch-tests (Lane 3 rev2)
  // ---------------------------------------------------------------------------

  it('[P1b] create_note.collectionIds requires write on collection — create-only notebook token SKIPS filing', async () => {
    // Seed notebook + collection with a workspace write token.
    const { token: seed } = await mintAgentToken(env, ownerA, passA, WRITE_ALL);
    const nb = await toolContent(env, seed, 'create_notebook', { name: 'Work' });
    const notebookId = nb.notebook.id as string;
    const col = await toolContent(env, seed, 'create_collection', {
      name: 'Folder',
      notebookId,
    });
    const collectionId = col.collection.id as string;

    // Notebook-scoped create-only token (no write, no collection grant).
    const { token: nbCreate, status } = await mintAgentToken(
      env,
      ownerA,
      passA,
      { create: true },
      [{ kind: 'notebook', id: notebookId }],
    );
    expect(status).toBe(201);

    const created = await toolContent(env, nbCreate, 'create_note', {
      title: 'Unfiled',
      text: 'x',
      notebookId,
      collectionIds: [collectionId, collectionId], // also exercises dedupe
    });
    expect(created.status).toBe('applied');
    expect(created.note.id).toBeTruthy();
    // Single result (deduped), SKIPPED for lack of write on the collection.
    expect(created.collectionResults).toEqual([{ collectionId, outcome: 'skipped' }]);
    // Owner confirms no membership.
    const got = await toolContent(env, seed, 'get_collection', { collectionId });
    expect(got.notes).toHaveLength(0);
  });

  it('[P1b] workspace write token can file on create (positive)', async () => {
    const { token } = await mintAgentToken(env, ownerA, passA, WRITE_ALL);
    const nb = await toolContent(env, token, 'create_notebook', { name: 'Work' });
    const col = await toolContent(env, token, 'create_collection', {
      name: 'Folder',
      notebookId: nb.notebook.id,
    });
    const created = await toolContent(env, token, 'create_note', {
      title: 'In folder',
      text: 'x',
      notebookId: nb.notebook.id,
      collectionIds: [col.collection.id],
    });
    expect(created.collectionResults?.[0]?.outcome).toBe('added');
    const got = await toolContent(env, token, 'get_collection', { collectionId: col.collection.id });
    expect(got.notes.some((n: { id: string }) => n.id === created.note.id)).toBe(true);
  });

  it('[P1a] enrichment filters collections a fine-grained token cannot read', async () => {
    const { token: seed } = await mintAgentToken(env, ownerA, passA, WRITE_ALL);
    const nb = await toolContent(env, seed, 'create_notebook', { name: 'Work' });
    const col = await toolContent(env, seed, 'create_collection', {
      name: 'SecretFolder',
      notebookId: nb.notebook.id,
    });
    const note = await toolContent(env, seed, 'create_note', {
      title: 'N',
      text: 'x',
      notebookId: nb.notebook.id,
      collectionIds: [col.collection.id],
    });
    const noteId = note.note.id as string;

    // Note-scoped read token — can read the note but not the collection (canWith denies).
    const { token: noteTok, status } = await mintAgentToken(env, ownerA, passA, undefined, [
      { kind: 'note', id: noteId },
    ]);
    expect(status).toBe(201);

    const got = await toolContent(env, noteTok, 'get_note', { id: noteId });
    expect(got.title).toBe('N');
    expect(got.collections).toEqual([]);

    const listed = await toolContent(env, noteTok, 'list_collections', {});
    expect(listed.collections).toEqual([]);

    // Workspace token still sees the enrichment.
    const full = await toolContent(env, seed, 'get_note', { id: noteId });
    expect(full.collections.some((c: { id: string; name: string }) => c.name === 'SecretFolder')).toBe(
      true,
    );
  });

  it('[P1c] POST /api/agent-tokens with collection resource is rejected — nothing persisted', async () => {
    const { token: seed } = await mintAgentToken(env, ownerA, passA, WRITE_ALL);
    const nb = await toolContent(env, seed, 'create_notebook', { name: 'Work' });
    const col = await toolContent(env, seed, 'create_collection', {
      name: 'C',
      notebookId: nb.notebook.id,
    });

    const { status, body } = await mintAgentToken(env, ownerA, passA, WRITE_ALL, [
      { kind: 'collection', id: col.collection.id },
    ]);
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
    expect(JSON.stringify(body)).toMatch(/collection-scoped agent tokens are not supported/i);

    // No agent grant row for that collection kind was minted (list tokens — only prior seed workspace).
    const list = await app.request('/api/agent-tokens', {
      headers: { Authorization: `Bearer ${ownerA}` },
    }, env);
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { tokens: Array<{ resources: Array<{ kind: string }> }> };
    for (const t of listed.tokens ?? []) {
      expect(t.resources.some((r) => r.kind === 'collection')).toBe(false);
    }
  });

  it('[P2] update_collection with only collectionId is invalid params (no version bump)', async () => {
    const { token } = await mintAgentToken(env, ownerA, passA, WRITE_ALL);
    const nb = await toolContent(env, token, 'create_notebook', { name: 'Work' });
    const col = await toolContent(env, token, 'create_collection', {
      name: 'Folder',
      notebookId: nb.notebook.id,
    });
    const r = await call(env, token, 'update_collection', { collectionId: col.collection.id });
    // Zod invalid params → JSON-RPC -32602 or tool error
    const asJson = JSON.stringify(r);
    expect(
      r?.isError === true ||
        /at least one of|invalid|name|icon|color/i.test(asJson) ||
        r === undefined,
    ).toBe(true);
    // If it was a JSON-RPC error at the route layer, call() returns result which may be undefined;
    // re-check via full rpc:
    const full = await rpc(
      env,
      {
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: { name: 'update_collection', arguments: { collectionId: col.collection.id } },
      },
      token,
    );
    const body = (await full.json()) as JsonRpcResult;
    expect(body.error?.code === -32602 || body.result?.isError === true).toBe(true);
  });
});
