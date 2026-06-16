import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { base64urlEncode } from '@deltos/shared';
import app from '../src/index.js';
import type { Env } from '../src/env.js';

/**
 * Auth route tests. As handlers flip live slice-by-slice these grow into full behavioural
 * assertions. Today:
 *   - SLICE (a) — boundary validation is wired on every signed endpoint: an invalid body rejects
 *     at the boundary (400) and a well-formed body passes through to the not-yet-implemented
 *     crypto tail (501) — which also proves the route is mounted (not a 404 fallback).
 *   - SLICE (c) — GET /api/auth/devices is fully live (guard → resolvePrincipal → listDevices),
 *     so it is tested end-to-end against a real D1-shaped SQLite binding.
 * register/session/revoke still 501 (need authCrypto); revoke deliberately NOT flipped — calling
 * revokeByKeyId without first verifying the F9 step-up would be unauthenticated revocation.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));

// Validation/501 paths never touch the DB, so a fake binding is fine for them.
const env = { DB: {}, ENVIRONMENT: 'development' } as unknown as Env;

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

// Canonical, exact-length base64url fixtures (all-zero bytes encode canonically).
const b64 = (bytes: number) => base64urlEncode(new Uint8Array(bytes));
const challengeId = b64(32); // ≥ 32 bytes
const signature = b64(64); // exactly 64 bytes
const signingPublicKey = b64(32); // exactly 32 bytes

const validBody: Record<string, unknown> = {
  challenge: { purpose: 'session', keyId: 'dev-1' },
  register: { challengeId, signature, signingPublicKey, deviceLabel: 'phone' },
  session: { challengeId, signature, keyId: 'dev-1', requestedScope: ['read'] },
  revoke: { challengeId, signature, keyId: 'dev-1', op: 'delete', resource: { kind: 'workspace' } },
};

const expectCode = async (res: Response, status: number, code: string) => {
  expect(res.status).toBe(status);
  const body = (await res.json()) as { error: { code: string } };
  expect(body.error.code).toBe(code);
};

describe('auth routes — slice (a): validation live, crypto tail 501', () => {
  it('POST /challenge: valid body passes validation → 501', async () => {
    await expectCode(await app.request('/api/auth/challenge', json(validBody.challenge), env), 501, 'not_implemented');
  });
  it('POST /challenge: invalid body (bad purpose) → 400', async () => {
    await expectCode(await app.request('/api/auth/challenge', json({ purpose: 'nope' }), env), 400, 'invalid_request');
  });
  it('POST /challenge: non-register purpose without keyId → 400 (cross-field rule)', async () => {
    await expectCode(await app.request('/api/auth/challenge', json({ purpose: 'session' }), env), 400, 'invalid_request');
  });
  it('POST /challenge: purpose=register needs no keyId → 501', async () => {
    await expectCode(await app.request('/api/auth/challenge', json({ purpose: 'register' }), env), 501, 'not_implemented');
  });

  it('POST /register: valid body → 501', async () => {
    await expectCode(await app.request('/api/auth/register', json(validBody.register), env), 501, 'not_implemented');
  });
  it('POST /register: wrong-length pubkey → 400', async () => {
    await expectCode(
      await app.request('/api/auth/register', json({ ...validBody.register, signingPublicKey: b64(31) }), env),
      400,
      'invalid_request',
    );
  });

  it('POST /session: valid body → 501', async () => {
    await expectCode(await app.request('/api/auth/session', json(validBody.session), env), 501, 'not_implemented');
  });
  it('POST /session: empty requestedScope → 400', async () => {
    await expectCode(
      await app.request('/api/auth/session', json({ ...validBody.session, requestedScope: [] }), env),
      400,
      'invalid_request',
    );
  });

  it('POST /devices/:keyId/revoke: valid step-up body → 501 (NOT flipped: needs step-up verify first)', async () => {
    await expectCode(await app.request('/api/auth/devices/dev-1/revoke', json(validBody.revoke), env), 501, 'not_implemented');
  });
  it('POST /devices/:keyId/revoke: malformed signature → 400', async () => {
    await expectCode(
      await app.request('/api/auth/devices/dev-1/revoke', json({ ...validBody.revoke, signature: 'not-base64url!!' }), env),
      400,
      'invalid_request',
    );
  });

  it('unknown /api/auth path still 404s (fallback intact)', async () => {
    const res = await app.request('/api/auth/nope', { method: 'POST' }, env);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// SLICE (c): GET /api/auth/devices live, exercised against a real D1-shaped binding.
// ---------------------------------------------------------------------------

const migrations = ['0000_baseline.sql', '0001_stream-b-sync.sql', '0002_stream-a-auth.sql'].map((f) =>
  readFileSync(join(__dirname, '../migrations', f), 'utf8'),
);

/** Minimal D1Database shim over better-sqlite3 — enough for the listDevices SELECT path. */
function d1Over(raw: Database.Database): D1Database {
  const prepare = (sql: string) => {
    let params: unknown[] = [];
    const stmt = {
      bind(...p: unknown[]) {
        params = p;
        return stmt;
      },
      async first<T>() {
        return (raw.prepare(sql).get(...(params as never[])) ?? null) as T | null;
      },
      async all<T>() {
        return { results: raw.prepare(sql).all(...(params as never[])) as T[] };
      },
      async run() {
        const info = raw.prepare(sql).run(...(params as never[]));
        return { meta: { rows_written: info.changes } };
      },
    };
    return stmt;
  };
  return { prepare } as unknown as D1Database;
}

function seedDevice(raw: Database.Database, keyId: string, accountFingerprint: string, label: string) {
  raw
    .prepare(
      `INSERT INTO devices (keyId, signingPublicKey, accountFingerprint, deviceLabel, createdAt)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(keyId, signingPublicKey, accountFingerprint, label, '2026-06-16T00:00:00.000Z');
}

describe('GET /api/auth/devices (slice c — live)', () => {
  // resolvePrincipal is the dev stub today (id 'local-owner'); listDevices scopes to that id, so the
  // route lists devices registered under the resolved principal's accountFingerprint and excludes
  // other accounts'. When grant-token resolution lands, the same handler lists the real account.
  it("lists the resolved principal's devices and excludes other accounts", async () => {
    const raw = new Database(':memory:');
    for (const m of migrations) raw.exec(m);
    seedDevice(raw, 'dev-mine', 'local-owner', 'My phone');
    seedDevice(raw, 'dev-other', 'someone-else', 'Their phone');

    const res = await app.request('/api/auth/devices', {}, { DB: d1Over(raw), ENVIRONMENT: 'development' } as unknown as Env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { devices: Array<{ keyId: string; deviceLabel: string }> };
    expect(body.devices).toHaveLength(1);
    expect(body.devices[0]).toMatchObject({ keyId: 'dev-mine', deviceLabel: 'My phone' });
  });

  it('refuses (503) the unverified dev stub in production (F13 tripwire)', async () => {
    const raw = new Database(':memory:');
    for (const m of migrations) raw.exec(m);
    const res = await app.request('/api/auth/devices', {}, { DB: d1Over(raw), ENVIRONMENT: 'production' } as unknown as Env);
    expect(res.status).toBe(503);
  });
});
