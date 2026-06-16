import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import {
  base64urlEncode,
  base64urlDecodeStrict,
  canonicalAuthPayload,
  type Op,
  type Resource,
  type Scope,
} from '@deltos/shared';
import app from '../src/index.js';
import { computeFingerprint } from '../src/authCrypto.js';
import type { Env } from '../src/env.js';

/**
 * Auth route tests — the end-to-end identity path going live. Routes orchestrate authStore + the
 * authCrypto verify layer; the security properties (PROP-1..4 / R3-2 / F2 / F8) live in HOW the
 * handlers CALL authCrypto (it cannot prove its params are server-sourced), so these tests pin the
 * route wiring, not the crypto: validation, the server-held-value plumbing, and the secSys CF-1..4
 * gates — including the required "sign with a non-registered key for a registered keyId ⇒ reject".
 */

const __dirname = dirname(fileURLToPath(import.meta.url));

// authCrypto sets this on import; set it here too so the test can sign (idempotent, same module).
if (!ed.hashes.sha512) ed.hashes.sha512 = sha512;

const AUD = 'deltos.test';
const migrations = [
  '0000_baseline.sql',
  '0001_stream-b-sync.sql',
  '0002_stream-a-auth.sql',
  '0003_account-identity.sql',
].map((f) => readFileSync(join(__dirname, '../migrations', f), 'utf8'));

/** Minimal D1Database shim over better-sqlite3 — supports the prepare/bind/first/all + batch the routes hit. */
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

function freshDb(): Database.Database {
  const raw = new Database(':memory:');
  for (const m of migrations) raw.exec(m);
  return raw;
}

const makeEnv = (raw: Database.Database, over: Partial<Env> = {}): Env =>
  ({ DB: d1Over(raw), ENVIRONMENT: 'development', AUTH_AUDIENCE: AUD, ...over }) as unknown as Env;

const postJson = (env: Env, path: string, body: unknown) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, env);

// Deterministic Ed25519 keypairs from fixed seeds (valid: ed25519 clamps internally).
function keypair(seedByte: number) {
  const priv = new Uint8Array(32).fill(seedByte);
  const pub = ed.getPublicKey(priv);
  return { priv, pub, pubB64: base64urlEncode(pub) };
}
const signB64 = (priv: Uint8Array, message: Uint8Array) => base64urlEncode(ed.sign(message, priv));

interface Challenge { challengeId: string; nonce: string; expiresAt: string; expiresAtMs: number }
async function mintChallenge(env: Env, body: unknown): Promise<Challenge> {
  const res = await postJson(env, '/api/auth/challenge', body);
  expect(res.status).toBe(200);
  return (await res.json()) as Challenge;
}

/** Register a device end-to-end; returns its keyId + accountFingerprint + keypair. */
async function registerDevice(env: Env, kp: ReturnType<typeof keypair>, label = 'phone') {
  const ch = await mintChallenge(env, { purpose: 'register' });
  const signature = signB64(
    kp.priv,
    canonicalAuthPayload({
      purpose: 'register',
      audience: AUD,
      challengeId: ch.challengeId,
      nonce: base64urlDecodeStrict(ch.nonce),
      signingPublicKey: kp.pub,
      deviceLabel: label,
    }),
  );
  const res = await postJson(env, '/api/auth/register', {
    challengeId: ch.challengeId,
    signingPublicKey: kp.pubB64,
    deviceLabel: label,
    signature,
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { keyId: string; accountFingerprint: string };
}

const expectCode = async (res: Response, status: number, code: string) => {
  expect(res.status).toBe(status);
  expect(((await res.json()) as { error: { code: string } }).error.code).toBe(code);
};

const b64 = (n: number) => base64urlEncode(new Uint8Array(n));

// ---------------------------------------------------------------------------
describe('POST /api/auth/challenge', () => {
  it('mints a challenge for a valid session request', async () => {
    const env = makeEnv(freshDb());
    const ch = await mintChallenge(env, { purpose: 'session', keyId: 'dev-1' });
    expect(base64urlDecodeStrict(ch.challengeId).length).toBeGreaterThanOrEqual(32);
    expect(base64urlDecodeStrict(ch.nonce).length).toBeGreaterThanOrEqual(32);
    expect(ch.expiresAtMs).toBeGreaterThan(0);
  });
  it('register purpose needs no keyId', async () => {
    await mintChallenge(makeEnv(freshDb()), { purpose: 'register' });
  });
  it('session purpose without keyId → 400 (discriminated union)', async () => {
    await expectCode(await postJson(makeEnv(freshDb()), '/api/auth/challenge', { purpose: 'session' }), 400, 'invalid_request');
  });
  it('unknown purpose → 400', async () => {
    await expectCode(await postJson(makeEnv(freshDb()), '/api/auth/challenge', { purpose: 'nope' }), 400, 'invalid_request');
  });
});

describe('POST /api/auth/register', () => {
  it('valid register-TLV signature → 201, server-COMPUTED fingerprint (F2)', async () => {
    const raw = freshDb();
    const env = makeEnv(raw);
    const kp = keypair(1);
    const body = await registerDevice(env, kp);
    expect(body.keyId).toBeTruthy();
    expect(body.accountFingerprint).toBe(computeFingerprint(kp.pub));
    // v1 populates the per-device-key seam column with the account key (not NULL).
    const row = raw.prepare('SELECT signingPublicKey, deviceSigningPublicKey FROM devices WHERE keyId = ?').get(body.keyId) as { signingPublicKey: string; deviceSigningPublicKey: string | null };
    expect(row.deviceSigningPublicKey).toBe(kp.pubB64);
    expect(row.signingPublicKey).toBe(kp.pubB64);
  });
  it('wrong-length pubkey → 400 at the boundary', async () => {
    const env = makeEnv(freshDb());
    const ch = await mintChallenge(env, { purpose: 'register' });
    await expectCode(
      await postJson(env, '/api/auth/register', { challengeId: ch.challengeId, signingPublicKey: b64(31), deviceLabel: 'x', signature: b64(64) }),
      400,
      'invalid_request',
    );
  });
  it('missing AUTH_AUDIENCE → 503 (fail-closed)', async () => {
    const env = makeEnv(freshDb(), { AUTH_AUDIENCE: undefined });
    const ch = await mintChallenge(env, { purpose: 'register' });
    await expectCode(
      await postJson(env, '/api/auth/register', { challengeId: ch.challengeId, signingPublicKey: b64(32), deviceLabel: 'x', signature: b64(64) }),
      503,
      'auth_not_configured',
    );
  });
  it('bad signature → 401 (challenge consumed, verify fails)', async () => {
    const env = makeEnv(freshDb());
    const kp = keypair(1);
    const ch = await mintChallenge(env, { purpose: 'register' });
    await expectCode(
      await postJson(env, '/api/auth/register', { challengeId: ch.challengeId, signingPublicKey: kp.pubB64, deviceLabel: 'x', signature: b64(64) }),
      401,
      'unauthorized',
    );
  });
  it('replayed challenge → 401 (single-use consume)', async () => {
    const env = makeEnv(freshDb());
    const kp = keypair(1);
    await registerDevice(env, kp); // consumes its challenge
    // A second register reusing nothing is fine; prove a CONSUMED challengeId cannot be reused:
    const ch = await mintChallenge(env, { purpose: 'register' });
    const sig = signB64(kp.priv, canonicalAuthPayload({ purpose: 'register', audience: AUD, challengeId: ch.challengeId, nonce: base64urlDecodeStrict(ch.nonce), signingPublicKey: kp.pub, deviceLabel: 'phone' }));
    const first = await postJson(env, '/api/auth/register', { challengeId: ch.challengeId, signingPublicKey: kp.pubB64, deviceLabel: 'phone', signature: sig });
    expect(first.status).toBe(201);
    const replay = await postJson(env, '/api/auth/register', { challengeId: ch.challengeId, signingPublicKey: kp.pubB64, deviceLabel: 'phone', signature: sig });
    await expectCode(replay, 401, 'unauthorized');
  });
});

describe('POST /api/auth/session', () => {
  const sessionSig = (priv: Uint8Array, ch: Challenge, keyId: string, requestedScope: Scope[]) =>
    signB64(priv, canonicalAuthPayload({ purpose: 'session', audience: AUD, challengeId: ch.challengeId, nonce: base64urlDecodeStrict(ch.nonce), keyId, requestedScope }));

  it('valid session-TLV → 200 token; grant persisted hashed + mintedByKeyId', async () => {
    const raw = freshDb();
    const env = makeEnv(raw);
    const kp = keypair(1);
    const { keyId } = await registerDevice(env, kp);
    const ch = await mintChallenge(env, { purpose: 'session', keyId });
    const res = await postJson(env, '/api/auth/session', { challengeId: ch.challengeId, keyId, requestedScope: ['read', 'write'], signature: sessionSig(kp.priv, ch, keyId, ['read', 'write']) });
    expect(res.status).toBe(200);
    const { token, expiresAt } = (await res.json()) as { token: string; expiresAt: string };
    expect(base64urlDecodeStrict(token).length).toBeGreaterThanOrEqual(32);
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now());
    const grant = raw.prepare('SELECT tokenHash, mintedByKeyId, scope FROM grants').get() as { tokenHash: string; mintedByKeyId: string; scope: string };
    expect(grant.tokenHash).not.toBe(token); // stored hashed (F6), never raw
    expect(grant.mintedByKeyId).toBe(keyId);
  });

  it('CF-1: signing with a NON-registered key for a registered keyId → 401', async () => {
    const env = makeEnv(freshDb());
    const real = keypair(1);
    const attacker = keypair(2);
    const { keyId } = await registerDevice(env, real);
    const ch = await mintChallenge(env, { purpose: 'session', keyId });
    // The server resolves the pubkey from getDevice(keyId)=real; a signature by `attacker` cannot verify.
    const res = await postJson(env, '/api/auth/session', { challengeId: ch.challengeId, keyId, requestedScope: ['read'], signature: sessionSig(attacker.priv, ch, keyId, ['read']) });
    await expectCode(res, 401, 'unauthorized');
  });

  it('keyId mismatch vs the challenge → 401 (R3-2)', async () => {
    const env = makeEnv(freshDb());
    const kp = keypair(1);
    const { keyId } = await registerDevice(env, kp);
    const ch = await mintChallenge(env, { purpose: 'session', keyId: 'other-key' }); // challenge bound to a different keyId
    const res = await postJson(env, '/api/auth/session', { challengeId: ch.challengeId, keyId, requestedScope: ['read'], signature: sessionSig(kp.priv, ch, keyId, ['read']) });
    await expectCode(res, 401, 'unauthorized');
  });

  it('revoked device → 401', async () => {
    const raw = freshDb();
    const env = makeEnv(raw);
    const kp = keypair(1);
    const { keyId } = await registerDevice(env, kp);
    raw.prepare('UPDATE devices SET revokedAt = ? WHERE keyId = ?').run('2026-06-16T00:00:00.000Z', keyId);
    const ch = await mintChallenge(env, { purpose: 'session', keyId });
    const res = await postJson(env, '/api/auth/session', { challengeId: ch.challengeId, keyId, requestedScope: ['read'], signature: sessionSig(kp.priv, ch, keyId, ['read']) });
    await expectCode(res, 401, 'unauthorized');
  });
});

describe('POST /api/auth/devices/:keyId/revoke (F9 step-up)', () => {
  const stepUpSig = (priv: Uint8Array, ch: Challenge, keyId: string, op: Op, resource: Resource) =>
    signB64(priv, canonicalAuthPayload({ purpose: 'step-up', audience: AUD, challengeId: ch.challengeId, nonce: base64urlDecodeStrict(ch.nonce), keyId, op, resource }));

  it('valid step-up (delete, workspace) → 200 revoked; device + its grants revoked', async () => {
    const raw = freshDb();
    const env = makeEnv(raw);
    const kp = keypair(1);
    const { keyId } = await registerDevice(env, kp);
    // mint a grant first so we can prove its revocation
    const sch = await mintChallenge(env, { purpose: 'session', keyId });
    await postJson(env, '/api/auth/session', { challengeId: sch.challengeId, keyId, requestedScope: ['read'], signature: signB64(kp.priv, canonicalAuthPayload({ purpose: 'session', audience: AUD, challengeId: sch.challengeId, nonce: base64urlDecodeStrict(sch.nonce), keyId, requestedScope: ['read'] })) });

    const ch = await mintChallenge(env, { purpose: 'step-up', keyId });
    const res = await postJson(env, `/api/auth/devices/${keyId}/revoke`, { challengeId: ch.challengeId, keyId, op: 'delete', resource: { kind: 'workspace' }, signature: stepUpSig(kp.priv, ch, keyId, 'delete', { kind: 'workspace' }) });
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toEqual({ keyId, revoked: true });
    expect((raw.prepare('SELECT revokedAt FROM devices WHERE keyId = ?').get(keyId) as { revokedAt: string | null }).revokedAt).not.toBeNull();
    expect((raw.prepare('SELECT revokedAt FROM grants WHERE mintedByKeyId = ?').get(keyId) as { revokedAt: string | null }).revokedAt).not.toBeNull();
  });

  it('step-up not bound to (delete, workspace) → 403', async () => {
    const env = makeEnv(freshDb());
    const kp = keypair(1);
    const { keyId } = await registerDevice(env, kp);
    const ch = await mintChallenge(env, { purpose: 'step-up', keyId });
    const res = await postJson(env, `/api/auth/devices/${keyId}/revoke`, { challengeId: ch.challengeId, keyId, op: 'read', resource: { kind: 'workspace' }, signature: stepUpSig(kp.priv, ch, keyId, 'read', { kind: 'workspace' }) });
    await expectCode(res, 403, 'forbidden');
  });

  it('bad step-up signature → 401', async () => {
    const env = makeEnv(freshDb());
    const kp = keypair(1);
    const { keyId } = await registerDevice(env, kp);
    const ch = await mintChallenge(env, { purpose: 'step-up', keyId });
    const res = await postJson(env, `/api/auth/devices/${keyId}/revoke`, { challengeId: ch.challengeId, keyId, op: 'delete', resource: { kind: 'workspace' }, signature: b64(64) });
    await expectCode(res, 401, 'unauthorized');
  });

  it('unknown target device → 404 (after a valid step-up)', async () => {
    const env = makeEnv(freshDb());
    const kp = keypair(1);
    const { keyId } = await registerDevice(env, kp);
    const ch = await mintChallenge(env, { purpose: 'step-up', keyId });
    const res = await postJson(env, `/api/auth/devices/no-such-device/revoke`, { challengeId: ch.challengeId, keyId, op: 'delete', resource: { kind: 'workspace' }, signature: stepUpSig(kp.priv, ch, keyId, 'delete', { kind: 'workspace' }) });
    await expectCode(res, 404, 'not_found');
  });

  it('BOLA: account A cannot revoke account B device → 404, B stays un-revoked', async () => {
    const raw = freshDb();
    const env = makeEnv(raw);
    const kpA = keypair(1);
    const kpB = keypair(2); // distinct keypair ⇒ distinct accountFingerprint ⇒ distinct account
    const a = await registerDevice(env, kpA, 'A phone');
    const b = await registerDevice(env, kpB, 'B phone');
    // A mints a VALID (delete, workspace) step-up for A's OWN account, then targets B's device.
    const ch = await mintChallenge(env, { purpose: 'step-up', keyId: a.keyId });
    const res = await postJson(env, `/api/auth/devices/${b.keyId}/revoke`, { challengeId: ch.challengeId, keyId: a.keyId, op: 'delete', resource: { kind: 'workspace' }, signature: stepUpSig(kpA.priv, ch, a.keyId, 'delete', { kind: 'workspace' }) });
    await expectCode(res, 404, 'not_found'); // 404, not 403 — no cross-account existence oracle
    // No partial mutation: B's device is untouched.
    expect((raw.prepare('SELECT revokedAt FROM devices WHERE keyId = ?').get(b.keyId) as { revokedAt: string | null }).revokedAt).toBeNull();
  });
});

describe('GET /api/auth/devices', () => {
  it("lists the resolved principal's account devices and excludes other accounts (scoped by accountId)", async () => {
    const raw = freshDb();
    const seedDevice = (keyId: string, fp: string, label: string) =>
      raw.prepare('INSERT INTO devices (keyId, signingPublicKey, deviceSigningPublicKey, accountFingerprint, deviceLabel, createdAt) VALUES (?,?,?,?,?,?)').run(keyId, b64(32), b64(32), fp, label, '2026-06-16T00:00:00.000Z');
    const seedCred = (fp: string, accountId: string) =>
      raw.prepare('INSERT INTO accountCredentials (accountFingerprint, accountId, credentialType, addedAt) VALUES (?,?,?,?)').run(fp, accountId, 'signing-key-v1', '2026-06-16T00:00:00.000Z');
    // The dev stub principal.id = 'local-account' (LOCAL_OWNER sentinel = an accountId, NOT a fingerprint).
    // listDevicesByAccount resolves the account's devices via accountCredentials — so this exercises
    // cross-account isolation THROUGH the re-pointed id: A's device is visible, B's is not.
    seedDevice('dev-mine', 'fp-mine', 'My phone'); seedCred('fp-mine', 'local-account');
    seedDevice('dev-other', 'fp-other', 'Their phone'); seedCred('fp-other', 'acct-other');
    const res = await app.request('/api/auth/devices', {}, makeEnv(raw));
    expect(res.status).toBe(200);
    const { devices } = (await res.json()) as { devices: Array<{ keyId: string }> };
    expect(devices).toHaveLength(1);
    expect(devices[0].keyId).toBe('dev-mine');
  });

  it('refuses (503) the unverified dev stub in production (F13 tripwire)', async () => {
    const res = await app.request('/api/auth/devices', {}, makeEnv(freshDb(), { ENVIRONMENT: 'production' }));
    expect(res.status).toBe(503);
  });
});

describe('routing fallback', () => {
  it('unknown /api/auth path still 404s', async () => {
    const res = await app.request('/api/auth/nope', { method: 'POST' }, makeEnv(freshDb()));
    expect(res.status).toBe(404);
  });
});
