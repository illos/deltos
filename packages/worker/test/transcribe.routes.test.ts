import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import app from '../src/index.js';
import type { Env } from '../src/env.js';

/**
 * Voice-to-text TRANSCRIBE route tests (custom-keyboard spec §6, stage 2). The route is decoupled plumbing:
 * authenticate → run Workers AI Whisper → return the transcript. These tests are hermetic — the AI binding
 * is a stub (Workers AI has NO local inference, so a real binding can't run here anyway), and the F13
 * fail-closed auth guard is exercised by toggling ENVIRONMENT. One test mints a real session to prove a
 * valid bearer is accepted in production (the security-relevant path).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const T = 30_000; // the one real-bearer test runs Argon2id at target params — keep the timeout generous.

const migrations = [
  '0000_baseline.sql',
  '0001_stream-b-sync.sql',
  '0002_stream-a-auth.sql',
  '0003_account-identity.sql',
  '0004_password-auth.sql',
  '0005_recovery-established.sql',
  '0006_account-sync-seq.sql',
  '0007_reconcile-account-sync-seq.sql',
  '0008_notebooks.sql',
  '0009_backfill-default-notebooks.sql',
  '0010_nullable-notebookid-all-notes.sql',
  '0011_drop-isdefault-notebooksyncseg-notes_pull.sql',
  '0012_custom-dictionary.sql',
  '0013_agent-token-label.sql',
  '0014_grant-family-link.sql',
  '0015_audit-log.sql',
  '0016_usage-counter.sql',
  '0017_oauth-provider.sql', '0018_fts5-note-search.sql', '0019_note-routing-guide.sql', '0020_grant-sets.sql', '0021_oauth-refresh-token.sql',].map((f) => readFileSync(join(__dirname, '../migrations', f), 'utf8'));

function d1Over(raw: Database.Database): D1Database {
  const prepare = (sql: string) => {
    const stmt = {
      sql,
      _params: [] as unknown[],
      bind(...p: unknown[]) {
        stmt._params = p;
        return stmt;
      },
      async first<T2>() {
        return (raw.prepare(sql).get(...(stmt._params as never[])) ?? null) as T2 | null;
      },
      async all<T2>() {
        return { results: raw.prepare(sql).all(...(stmt._params as never[])) as T2[] };
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

function freshDb(): Database.Database {
  const raw = new Database(':memory:');
  for (const m of migrations) raw.exec(m);
  return raw;
}

/** A stub Workers AI binding. Records the input it was called with so we can assert the v3-turbo contract
 *  (base64 audio, NOT a uint8 array), and lets a test force a failure. */
function stubAI(opts: { text?: string; throws?: boolean } = {}) {
  const calls: Array<{ model: string; input: { audio: unknown } }> = [];
  const ai = {
    run: vi.fn(async (model: string, input: { audio: unknown }) => {
      calls.push({ model, input });
      if (opts.throws) throw new Error('model unavailable');
      return { text: opts.text ?? 'hello world' };
    }),
  };
  return { ai, calls };
}

const makeEnv = (over: Partial<Env> = {}, raw?: Database.Database): Env =>
  ({
    DB: d1Over(raw ?? freshDb()),
    ENVIRONMENT: 'development',
    AUTH_AUDIENCE: 'deltos.test',
    AUTH_PEPPER: 'unit-test-pepper',
    TOTP_ENC_KEY: 'unit-test-totp-key',
    ...over,
  }) as unknown as Env;

/** POST raw bytes (audio body) to /api/transcribe (or a variant with query params). */
const postAudio = (env: Env, body: BodyInit, headers: Record<string, string> = {}, path = '/api/transcribe') =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'audio/webm', ...headers }, body }, env);

/** A non-trivial fake audio payload. */
const fakeAudio = (bytes = 2048) => new Uint8Array(bytes).fill(7);

describe('POST /api/transcribe — voice-to-text (spec §6)', () => {
  it('dev environment: transcribes without a bearer (the unverified stub is allowed in non-prod)', async () => {
    const { ai, calls } = stubAI({ text: 'the quick brown fox' });
    const res = await postAudio(makeEnv({ AI: ai as unknown as Ai }), fakeAudio());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ transcript: 'the quick brown fox' });
    // The v3-turbo contract: audio is passed as a base64 STRING, not a number[] (the legacy whisper shape).
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe('@cf/openai/whisper-large-v3-turbo');
    expect(typeof calls[0].input.audio).toBe('string');
  });

  it('production + NO bearer: rejected 401 before any (paid) inference runs (F13 fail-closed)', async () => {
    const { ai } = stubAI();
    const res = await postAudio(makeEnv({ ENVIRONMENT: 'production', AI: ai as unknown as Ai }), fakeAudio());
    expect(res.status).toBe(401);
    expect(ai.run).not.toHaveBeenCalled();
  });

  it(
    'production + VALID bearer: a real authenticated session transcribes',
    async () => {
      const raw = freshDb();
      const { ai } = stubAI({ text: 'authenticated transcript' });
      const env = makeEnv({ ENVIRONMENT: 'production', AI: ai as unknown as Ai }, raw);

      // Mint a real session the same way the auth suite does: signup returns a live access bearer.
      const signup = await app.request(
        '/api/auth/signup',
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'voiceuser', password: 'correct horse battery staple' }) },
        env,
      );
      expect(signup.status).toBe(201);
      const { token } = (await signup.json()) as { token: string };

      const res = await postAudio(env, fakeAudio(), { Authorization: `Bearer ${token}` });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ transcript: 'authenticated transcript' });
    },
    T,
  );

  it('AI binding unbound: fail-closed 503 (no silent degrade)', async () => {
    const res = await postAudio(makeEnv({ AI: undefined }), fakeAudio());
    expect(res.status).toBe(503);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('ai_not_configured');
  });

  it('empty body: 400 invalid_request', async () => {
    const { ai } = stubAI();
    const res = await postAudio(makeEnv({ AI: ai as unknown as Ai }), new Uint8Array(0));
    expect(res.status).toBe(400);
    expect(ai.run).not.toHaveBeenCalled();
  });

  it('Content-Length precheck: 413 before buffering when declared size exceeds cap', async () => {
    const { ai } = stubAI();
    // Body is tiny (1 KB) but Content-Length declares 6 MB > the 5 MB dictation cap.
    // The route must 413 BEFORE calling arrayBuffer() so no large allocation occurs.
    const res = await postAudio(
      makeEnv({ AI: ai as unknown as Ai }),
      new Uint8Array(1024),
      { 'content-length': String(6 * 1024 * 1024) },
    );
    expect(res.status).toBe(413);
    expect(ai.run).not.toHaveBeenCalled();
  });

  it('oversize body: 413 payload_too_large (defensive cap before inference)', async () => {
    const { ai } = stubAI();
    // 6 MB > the 5 MB dictation cap. Content-Length fires first here (body and header agree).
    const res = await postAudio(makeEnv({ AI: ai as unknown as Ai }), new Uint8Array(6 * 1024 * 1024));
    expect(res.status).toBe(413);
    expect(ai.run).not.toHaveBeenCalled();
  });

  it('?final=1 Content-Length precheck: 413 when declared size > 25MB final cap', async () => {
    const { ai } = stubAI();
    // Body is tiny (1 KB) but Content-Length declares 26 MB > the 25 MB final cap.
    const res = await postAudio(
      makeEnv({ AI: ai as unknown as Ai }),
      new Uint8Array(1024),
      { 'content-length': String(26 * 1024 * 1024) },
      '/api/transcribe?final=1',
    );
    expect(res.status).toBe(413);
    expect(ai.run).not.toHaveBeenCalled();
  });

  it('?final=1 body 6MB: accepted (final cap = 25MB; proves two-cap select — default cap = 5MB would reject this)', async () => {
    const { ai } = stubAI({ text: 'long recording transcript' });
    // 6 MB < the 25 MB final cap but > the 5 MB default cap — the two-cap select is the only reason this passes.
    const res = await postAudio(
      makeEnv({ AI: ai as unknown as Ai }),
      new Uint8Array(6 * 1024 * 1024).fill(7),
      {},
      '/api/transcribe?final=1',
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ transcript: 'long recording transcript' });
    expect(ai.run).toHaveBeenCalledOnce();
  });

  it('model failure: surfaces a clean 502, not a 500 stack', async () => {
    const { ai } = stubAI({ throws: true });
    const res = await postAudio(makeEnv({ AI: ai as unknown as Ai }), fakeAudio());
    expect(res.status).toBe(502);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('transcription_failed');
  });

  it('over the daily quota: 429 quota_exceeded BEFORE any (paid) inference (Tier-2 denial-of-wallet, ROAD-0005 P4)', async () => {
    const raw = freshDb();
    const today = new Date().toISOString().slice(0, 10); // today's UTC day bucket
    // Pre-seed the durable counter AT the cap for the dev account (principal.id = 'local-account' for the
    // non-prod unverified principal) so the very next call is over budget — no need to make 1000 real calls.
    raw
      .prepare(`INSERT INTO usageCounter (accountId, metric, dayBucket, count, updatedAt) VALUES (?, 'transcribe', ?, 1000, ?)`)
      .run('local-account', today, new Date().toISOString());

    const { ai } = stubAI();
    const res = await postAudio(makeEnv({ AI: ai as unknown as Ai }, raw), fakeAudio());
    expect(res.status).toBe(429);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('quota_exceeded');
    expect(ai.run).not.toHaveBeenCalled(); // charged BEFORE buffering/inference — no paid work on a rejected call
  });

  it('under quota: a normal call succeeds AND bumps the durable usageCounter row (Tier-2 charge)', async () => {
    const raw = freshDb();
    const today = new Date().toISOString().slice(0, 10);
    const { ai } = stubAI({ text: 'metered transcript' });
    const res = await postAudio(makeEnv({ AI: ai as unknown as Ai }, raw), fakeAudio());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ transcript: 'metered transcript' });
    // The charge incremented the per-account/per-UTC-day counter from 0 → 1.
    const row = raw
      .prepare(`SELECT count FROM usageCounter WHERE accountId = ? AND metric = ? AND dayBucket = ?`)
      .get('local-account', 'transcribe', today) as { count: number } | undefined;
    expect(row?.count).toBe(1);
  });
});
