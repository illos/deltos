/**
 * Stream A identity acceptance tests — the three end-states: AUTHORIZED / REJECTED / REVOKED.
 *
 * Maps directly to docs/specs/stream-a-acceptance-checklist.md §A–§H and the four core auth
 * security properties (AUTH-PROP-1..4 — checklist synthesis labels; real sources: PIN-ID-2,
 * F4/F8, strawman §3). The F-labels (F2, F5, F6, F9, F13) come from stream-a-auth-secSys-review.md.
 *
 * STRUCTURAL NOTE: tests fall into two tiers.
 *
 *   LIVE — in regular `it()` or `it.skip()` with a body; run today.
 *     · The F13 allowlist tests (§F13) run against the EXISTING `guard()` in http.ts.
 *       Some are CURRENTLY RED — they assert the desired fail-closed behavior that requires
 *       the allowlist inversion in http.ts (changing `=== 'production'` to the closed set
 *       {development, test, local}). They go GREEN when devSys lands that fix.
 *
 *   PENDING — `it.todo()` (no body); compile clean, show as pending in CI.
 *     · All tests that require routes/auth.ts, auth_challenges/devices/grants D1 tables,
 *       canonical.ts, or the real resolvePrincipal + grant-token can() branch.
 *       devSys removes the `.todo` wrapper and fills in the app mount as each chunk lands.
 *
 * WHEN FLIPPING A TODO LIVE:
 *   1. Mount the auth router: `const app = new Hono(); app.route('/api/auth', authModule.auth);`
 *   2. Create a fresh in-memory DB with `freshAuthDb()` (helper below — activates once migration lands).
 *   3. Inject the DB adapter + real `resolvePrincipal` + real `can` into the Hono context.
 *   4. Convert `.todo(desc)` → an actual `it(desc, async () => ...)` with the test body.
 *
 * secSys focus areas carried forward:
 *   - §A AUTH-PROP-1..4 (replay, freshness, pubkey-binding, intent-binding)
 *   - F2 (fingerprint server-enforced), F13 (allowlist tripwire), PIN-ID-1/5 (id-not-authn, revoke)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  NoteRefSchema, ResourceSchema,
  canonicalAuthPayload, base64urlEncode,
  type Resource,
} from '@deltos/shared';
import { guard, type GuardDeps, type AppContext } from '../src/http.js';
import type { Env } from '../src/env.js';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { computeFingerprint, hashToken, clampScope, verifySession, verifyRegister, verifyStepUp } from '../src/authCrypto.js';

// noble Ed25519 needs its SHA-512 wired once (same pattern as authCrypto.ts and authCrypto.test.ts).
if (!ed.hashes.sha512) ed.hashes.sha512 = sha512;

// ---------------------------------------------------------------------------
// D1/SQLite test infrastructure — mirrors conflict.test.ts pattern
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));

const ALL_MIGRATIONS = [
  '0000_baseline.sql',
  '0001_stream-b-sync.sql',
  '0002_stream-a-auth.sql',
].map((f) => readFileSync(join(__dirname, '../migrations', f), 'utf8'));

/**
 * Fresh in-memory DB with all migrations applied. Returns `raw` (better-sqlite3 Database)
 * for schema introspection tests; a `db` D1-compatible adapter will be added once authStore
 * functions need it.
 */
function freshAuthDb(): Database.Database {
  const raw = new Database(':memory:');
  for (const sql of ALL_MIGRATIONS) raw.exec(sql);
  return raw;
}

// ---------------------------------------------------------------------------
// Helpers shared across live sections
// ---------------------------------------------------------------------------

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const noteRes = (n: number): Resource => ({ kind: 'note', id: uuid(n) });

/** Build a minimal one-route app that exercises the guard layer (same pattern as chokepoint.test.ts). */
function guardApp(deps: GuardDeps, handle: ReturnType<typeof vi.fn>) {
  const app = new Hono<{ Bindings: Env }>();
  app.get(
    '/t/:id',
    guard(
      {
        op: 'read',
        schema: NoteRefSchema,
        input: (c) => ({ id: c.req.param('id') }),
        resource: (): Resource => noteRes(1),
        handle,
      },
      deps,
    ),
  );
  return app;
}

// ---------------------------------------------------------------------------
// §F13 — tripwire env allowlist: fail-CLOSED (secSys checklist §C)
//
// Current http.ts fires the tripwire only when ENVIRONMENT === 'production' (fail-OPEN: an
// unset or typo'd var serves the unverified stub). The required behavior (F13) fires on
// EVERYTHING EXCEPT an exact-match set {development, test, local}.
//
// Live tests are grouped by current status so the diff is clear when the fix lands in http.ts:
//   GROUP A — already correct (GREEN before and after the fix)
//   GROUP B — currently wrong (RED now, GREEN after the fix)
// ---------------------------------------------------------------------------

describe('F13 — tripwire env allowlist', () => {

  // ------ GROUP A: already correct (GREEN now and after fix) ------

  it('ENVIRONMENT=production → 503 refused (already correct, must stay correct)', async () => {
    const handle = vi.fn((_req: unknown, c: AppContext) => c.json({ ok: true }));
    const env = { DB: {}, ENVIRONMENT: 'production' } as unknown as Env;
    const res = await guardApp({ can: async () => true }, handle).request(`/t/${uuid(1)}`, {}, env);
    expect(res.status).toBe(503);
    expect(handle).not.toHaveBeenCalled();
  });

  it('ENVIRONMENT=development → unverified stub allowed through (correct, must stay correct)', async () => {
    const handle = vi.fn((_req: unknown, c: AppContext) => c.json({ ok: true }));
    const env = { DB: {}, ENVIRONMENT: 'development' } as unknown as Env;
    const res = await guardApp({ can: async () => true }, handle).request(`/t/${uuid(1)}`, {}, env);
    expect(res.status).toBe(200);
    expect(handle).toHaveBeenCalledOnce();
  });

  // ------ GROUP B: fail-CLOSED fix required in http.ts (RED now, GREEN after fix) ------
  // These assert that UNSET or UNRECOGNISED ENVIRONMENT values refuse the unverified stub.
  // The fix: change `=== 'production'` to `!new Set(['development','test','local']).has(ENVIRONMENT ?? '')`.

  it('ENVIRONMENT=undefined → 503 refused [RED until F13 allowlist fix in http.ts]', async () => {
    const handle = vi.fn((_req: unknown, c: AppContext) => c.json({ ok: true }));
    const env = { DB: {} } as unknown as Env; // ENVIRONMENT unset
    const res = await guardApp({ can: async () => true }, handle).request(`/t/${uuid(1)}`, {}, env);
    expect(res.status).toBe(503);
    expect(handle).not.toHaveBeenCalled();
  });

  it('ENVIRONMENT=staging → 503 refused [RED until F13 allowlist fix in http.ts]', async () => {
    const handle = vi.fn((_req: unknown, c: AppContext) => c.json({ ok: true }));
    const env = { DB: {}, ENVIRONMENT: 'staging' } as unknown as Env;
    const res = await guardApp({ can: async () => true }, handle).request(`/t/${uuid(1)}`, {}, env);
    expect(res.status).toBe(503);
    expect(handle).not.toHaveBeenCalled();
  });

  it('ENVIRONMENT=DEVELOPMENT → 503 refused — allowlist is exact-match, case-sensitive [RED until fix]', async () => {
    const handle = vi.fn((_req: unknown, c: AppContext) => c.json({ ok: true }));
    const env = { DB: {}, ENVIRONMENT: 'DEVELOPMENT' } as unknown as Env;
    const res = await guardApp({ can: async () => true }, handle).request(`/t/${uuid(1)}`, {}, env);
    expect(res.status).toBe(503);
    expect(handle).not.toHaveBeenCalled();
  });

  it('ENVIRONMENT=test → allowed through (exact-match allowlist; GREEN after fix)', async () => {
    const handle = vi.fn((_req: unknown, c: AppContext) => c.json({ ok: true }));
    const env = { DB: {}, ENVIRONMENT: 'test' } as unknown as Env;
    const res = await guardApp({ can: async () => true }, handle).request(`/t/${uuid(1)}`, {}, env);
    expect(res.status).toBe(200);
    expect(handle).toHaveBeenCalledOnce();
  });

  it('ENVIRONMENT=local → allowed through (exact-match allowlist; GREEN after fix)', async () => {
    const handle = vi.fn((_req: unknown, c: AppContext) => c.json({ ok: true }));
    const env = { DB: {}, ENVIRONMENT: 'local' } as unknown as Env;
    const res = await guardApp({ can: async () => true }, handle).request(`/t/${uuid(1)}`, {}, env);
    expect(res.status).toBe(200);
    expect(handle).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// D1 auth schema — migration 0002 (b835804)
//
// Schema-shape tests: table existence, column types, nullability, constraints, indexes.
// These run against a fresh in-memory SQLite DB with all three migrations applied.
// LIVE — no authStore or canonical.ts required.
//
// Key security invariants exercised at the schema level:
//   AUTH-PROP-2 storage: expiresAtMs is INTEGER (epoch-millis instant compare, not lexical ISO)
//   F6:              tokenHash UNIQUE — hashed-only storage, no raw bearer in DB
//   PIN-ID-5:        mintedByKeyId nullable (device grants) + grants.revokedAt for immediate deny
//   F2:              accountFingerprint NOT NULL (server-COMPUTED, always present in devices row)
// ---------------------------------------------------------------------------

describe('D1 auth schema — migration 0002', () => {
  let db: Database.Database;
  beforeEach(() => { db = freshAuthDb(); });

  // --- meta sentinel ---

  it('streamAAuthSchemaVersion meta row = "1" confirms migration applied', () => {
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'streamAAuthSchemaVersion'`).get() as { value: string } | undefined;
    expect(row?.value).toBe('1');
  });

  // --- devices table ---

  it('devices table: all columns present with correct types and nullability', () => {
    const cols = db.prepare(`PRAGMA table_info(devices)`).all() as Array<{ name: string; type: string; notnull: number; pk: number }>;
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]));

    expect(byName['keyId']?.pk).toBe(1);            // PRIMARY KEY
    expect(byName['keyId']?.type).toBe('TEXT');
    expect(byName['keyId']?.notnull).toBe(1);

    expect(byName['signingPublicKey']?.type).toBe('TEXT');
    expect(byName['signingPublicKey']?.notnull).toBe(1);

    expect(byName['accountFingerprint']?.type).toBe('TEXT');
    expect(byName['accountFingerprint']?.notnull).toBe(1); // F2: server-COMPUTED, always present

    expect(byName['deviceLabel']?.type).toBe('TEXT');
    expect(byName['deviceLabel']?.notnull).toBe(1);

    expect(byName['createdAt']?.type).toBe('TEXT');
    expect(byName['createdAt']?.notnull).toBe(1);

    expect(byName['revokedAt']?.type).toBe('TEXT');
    expect(byName['revokedAt']?.notnull).toBe(0); // nullable — IS NOT NULL = revoked (PIN-ID-5)
  });

  it('devices_byAccount index exists on (accountFingerprint) for per-account device listing', () => {
    const indexes = db.prepare(`PRAGMA index_list(devices)`).all() as Array<{ name: string }>;
    expect(indexes.some((i) => i.name === 'devices_byAccount')).toBe(true);
  });

  // --- authChallenges table ---

  it('authChallenges.expiresAtMs is INTEGER — epoch-millis instant compare, not lexical ISO (AUTH-PROP-2 storage)', () => {
    const cols = db.prepare(`PRAGMA table_info(authChallenges)`).all() as Array<{ name: string; type: string; notnull: number }>;
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
    expect(byName['expiresAtMs']?.type).toBe('INTEGER');
    expect(byName['expiresAtMs']?.notnull).toBe(1);
  });

  it('authChallenges.expiresAtMs integer compare correctly identifies fresh vs stale challenges', () => {
    const nowMs = 1_000_000_000_000;
    db.prepare(
      `INSERT INTO authChallenges (challengeId, nonce, purpose, issuedAt, expiresAtMs, consumed)
       VALUES ('c1','n1','session','2001-09-09T01:46:40.000Z', ?, 0)`,
    ).run(nowMs + 60_000);

    const fresh = db.prepare(`SELECT challengeId FROM authChallenges WHERE expiresAtMs > ?`).get(nowMs);
    expect(fresh).not.toBeNull();

    const stale = db.prepare(`SELECT challengeId FROM authChallenges WHERE expiresAtMs > ?`).get(nowMs + 120_000);
    expect(stale).toBeUndefined();
  });

  it('authChallenges.keyId is nullable (NULL for purpose=register — no key exists yet at enrollment)', () => {
    const cols = db.prepare(`PRAGMA table_info(authChallenges)`).all() as Array<{ name: string; notnull: number }>;
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
    expect(byName['keyId']?.notnull).toBe(0);
  });

  it('authChallenges.consumed defaults to 0 (unconsumed on creation)', () => {
    const cols = db.prepare(`PRAGMA table_info(authChallenges)`).all() as Array<{ name: string; dflt_value: string | null }>;
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
    expect(byName['consumed']?.dflt_value).toBe('0');
  });

  it('authChallenges_byExpiry index exists on (expiresAtMs) for sweep-expired-challenges', () => {
    const indexes = db.prepare(`PRAGMA index_list(authChallenges)`).all() as Array<{ name: string }>;
    expect(indexes.some((i) => i.name === 'authChallenges_byExpiry')).toBe(true);
  });

  // --- grants table ---

  it('grants.tokenHash UNIQUE — raw token never stored; lookup hashes the presented token (F6)', () => {
    const insert = db.prepare(
      `INSERT INTO grants (grantId, tokenHash, principalKind, principalId, mintedByKeyId,
                           resourceKind, scope, createdAt)
       VALUES (?, ?, 'device', 'k1', 'k1', 'workspace', '["read"]', '2026-01-01T00:00:00.000Z')`,
    );
    insert.run('g1', 'hash-aaa');
    // Duplicate tokenHash with a different grantId must violate the UNIQUE constraint.
    expect(() => insert.run('g2', 'hash-aaa')).toThrow(/UNIQUE/);
  });

  it('grants.expiresAtMs is INTEGER (nullable — NULL = no-expiry; instant compare at resolve)', () => {
    const cols = db.prepare(`PRAGMA table_info(grants)`).all() as Array<{ name: string; type: string; notnull: number }>;
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
    expect(byName['expiresAtMs']?.type).toBe('INTEGER');
    expect(byName['expiresAtMs']?.notnull).toBe(0); // nullable
  });

  it('grants.mintedByKeyId nullable (NULL for capability grants; device grants carry keyId for revokeByKeyId)', () => {
    const cols = db.prepare(`PRAGMA table_info(grants)`).all() as Array<{ name: string; notnull: number }>;
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
    expect(byName['mintedByKeyId']?.notnull).toBe(0);
  });

  it('grants.revokedAt nullable TEXT — IS NOT NULL = immediate deny (PIN-ID-5)', () => {
    const cols = db.prepare(`PRAGMA table_info(grants)`).all() as Array<{ name: string; type: string; notnull: number }>;
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
    expect(byName['revokedAt']?.type).toBe('TEXT');
    expect(byName['revokedAt']?.notnull).toBe(0);
  });

  it('grants.scope is TEXT (JSON Scope[] — clamped at mint per F5, stored as serialized array)', () => {
    const cols = db.prepare(`PRAGMA table_info(grants)`).all() as Array<{ name: string; type: string; notnull: number }>;
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
    expect(byName['scope']?.type).toBe('TEXT');
    expect(byName['scope']?.notnull).toBe(1);
  });

  it('grants_byMintedKey index exists on (mintedByKeyId) for revokeByKeyId sweep (PIN-ID-5)', () => {
    const indexes = db.prepare(`PRAGMA index_list(grants)`).all() as Array<{ name: string }>;
    expect(indexes.some((i) => i.name === 'grants_byMintedKey')).toBe(true);
  });

  // --- authStore BEHAVIOR — covered by devSys2 ---
  // authStore.test.ts (d9e2dd7, 14 tests) and authStore.behavior.test.ts (c6b9176, 19 adversarial) own:
  //   · createChallenge consumed=0, expiresAtMs = issuedMs + TTL_MS
  //   · consumeChallenge atomic CAS (rows-affected=1 fresh, 0 stale/spent) — AUTH-PROP-1+2
  //   · concurrent double-consume: exactly one wins (replay race)
  //   · registerDevice: accountFingerprint = base64url(SHA-256(signingPublicKey)) — server-computed (F2)
  //   · registerDevice: duplicate keyId → UNIQUE PK throws; shared signingPublicKey allowed (multi-device)
  //   · mintGrant: tokenHash = base64url(SHA-256(token)); raw token never stored (F6)
  //   · resolveGrant: returns row regardless of revoked/expired; revokedAt IS NOT NULL → row present
  //   · resolveGrant: expiresAtMs instant-compare (chokepoint, not layer, decides deny)
  //   · revokeByKeyId: device row + grants WHERE mintedByKeyId=keyId; capability grants untouched (PIN-ID-5)
  //   · getDevice: revoked row still resolves; caller checks revokedAt
  // Route-level integration covering all of the above (authorized/rejected/revoked) will flip §F todos.
});

// ---------------------------------------------------------------------------
// Wire-schema crypto layer — canonical.ts + Ed25519 signing (AUTH-PROP-3/4)
//
// Tests the SECURITY PROPERTIES that emerge from combining canonicalAuthPayload with an Ed25519
// signature. The shared canonical.test.ts covers TLV byte-structure; here we cover the SIGNING
// invariants — whether the bound fields actually prevent cross-purpose / cross-audience /
// cross-keypair reuse of a captured signature.
//
// AUTH-PROP-3: pubkey↔account binding — signature from keypair A cannot verify with keypair B.
// AUTH-PROP-4: purpose / audience / op / resource binding — the TLV field set for each purpose
//   makes same-nonce/same-challengeId signatures non-transferable across endpoints or deployments.
//
// LIVE — requires only canonical.ts (c803e54) + WebCrypto Ed25519 (Node 22 / Workers native).
// Route-handler .todo()s (the "→ 401" variants) remain below; they flip when routes/auth.ts lands.
// ---------------------------------------------------------------------------

const AUDIENCE = 'https://deltos.test';
const AUDIENCE_B = 'https://deltos-b.test';
// 32-byte floor for challengeId and nonce (min: 32 requirement from ChallengeIdSchema / NonceSchema)
const CHALLENGE_ID = base64urlEncode(new Uint8Array(32).fill(0xcc));
const NONCE_BYTES = new Uint8Array(32).fill(0xdd);
const PUBKEY_32 = new Uint8Array(32).fill(0xee);
const KEY_ID = 'device-key-1';
const NOTE_1 = ResourceSchema.parse({ kind: 'note', id: '00000000-0000-4000-8000-000000000001' });
const NOTE_2 = ResourceSchema.parse({ kind: 'note', id: '00000000-0000-4000-8000-000000000002' });

async function freshKeypair(): Promise<CryptoKeyPair> {
  // Node 22 WebCrypto natively supports Ed25519 generateKey + sign + verify.
  return crypto.subtle.generateKey(
    { name: 'Ed25519' } as EcKeyGenParams,
    true,
    ['sign', 'verify'],
  ) as Promise<CryptoKeyPair>;
}
async function edSign(key: CryptoKey, payload: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' } as Algorithm, key, payload));
}
async function edVerify(key: CryptoKey, sig: Uint8Array, payload: Uint8Array): Promise<boolean> {
  return crypto.subtle.verify({ name: 'Ed25519' } as Algorithm, key, sig, payload);
}

describe('wire-schema crypto layer — canonical + Ed25519 signing (AUTH-PROP-3/4)', () => {

  it('sign + verify round-trip: canonicalAuthPayload session payload verifies with the correct public key', async () => {
    const kp = await freshKeypair();
    const payload = canonicalAuthPayload({
      purpose: 'session', audience: AUDIENCE, challengeId: CHALLENGE_ID,
      nonce: NONCE_BYTES, keyId: KEY_ID, requestedScope: ['read'],
    });
    const sig = await edSign(kp.privateKey, payload);
    expect(await edVerify(kp.publicKey, sig, payload)).toBe(true);
  });

  it('AUTH-PROP-4 purpose-binding: session signature fails to verify against a register payload (cross-purpose reuse blocked)', async () => {
    const kp = await freshKeypair();
    const sessionPayload = canonicalAuthPayload({
      purpose: 'session', audience: AUDIENCE, challengeId: CHALLENGE_ID,
      nonce: NONCE_BYTES, keyId: KEY_ID, requestedScope: ['read'],
    });
    const registerPayload = canonicalAuthPayload({
      purpose: 'register', audience: AUDIENCE, challengeId: CHALLENGE_ID,
      nonce: NONCE_BYTES, signingPublicKey: PUBKEY_32, deviceLabel: 'my-device',
    });
    const sessionSig = await edSign(kp.privateKey, sessionPayload);
    expect(await edVerify(kp.publicKey, sessionSig, sessionPayload)).toBe(true);
    expect(await edVerify(kp.publicKey, sessionSig, registerPayload)).toBe(false);
  });

  it('AUTH-PROP-4 purpose-binding: step-up signature fails to verify against a session payload', async () => {
    const kp = await freshKeypair();
    const stepUpPayload = canonicalAuthPayload({
      purpose: 'step-up', audience: AUDIENCE, challengeId: CHALLENGE_ID,
      nonce: NONCE_BYTES, keyId: KEY_ID, op: 'delete', resource: NOTE_1,
    });
    const sessionPayload = canonicalAuthPayload({
      purpose: 'session', audience: AUDIENCE, challengeId: CHALLENGE_ID,
      nonce: NONCE_BYTES, keyId: KEY_ID, requestedScope: ['delete'],
    });
    const stepUpSig = await edSign(kp.privateKey, stepUpPayload);
    expect(await edVerify(kp.publicKey, stepUpSig, stepUpPayload)).toBe(true);
    expect(await edVerify(kp.publicKey, stepUpSig, sessionPayload)).toBe(false);
  });

  it('AUTH-PROP-4 audience-binding: session sig for audience A fails to verify against audience B — cross-deployment replay blocked (F8)', async () => {
    const kp = await freshKeypair();
    const payloadA = canonicalAuthPayload({
      purpose: 'session', audience: AUDIENCE, challengeId: CHALLENGE_ID,
      nonce: NONCE_BYTES, keyId: KEY_ID, requestedScope: ['read'],
    });
    const payloadB = canonicalAuthPayload({
      purpose: 'session', audience: AUDIENCE_B, challengeId: CHALLENGE_ID,
      nonce: NONCE_BYTES, keyId: KEY_ID, requestedScope: ['read'],
    });
    const sigA = await edSign(kp.privateKey, payloadA);
    expect(await edVerify(kp.publicKey, sigA, payloadA)).toBe(true);
    expect(await edVerify(kp.publicKey, sigA, payloadB)).toBe(false);
  });

  it('AUTH-PROP-3 pubkey-binding: session sig from keypair A fails to verify against keypair B — no confused-deputy (PIN-ID-2/F2)', async () => {
    const kpA = await freshKeypair();
    const kpB = await freshKeypair();
    const payload = canonicalAuthPayload({
      purpose: 'session', audience: AUDIENCE, challengeId: CHALLENGE_ID,
      nonce: NONCE_BYTES, keyId: KEY_ID, requestedScope: ['read'],
    });
    const sigA = await edSign(kpA.privateKey, payload);
    expect(await edVerify(kpA.publicKey, sigA, payload)).toBe(true);
    expect(await edVerify(kpB.publicKey, sigA, payload)).toBe(false);
  });

  it('AUTH-PROP-4 step-up resource-binding: step-up for (delete, note-1) fails to verify against (delete, note-2)', async () => {
    const kp = await freshKeypair();
    const payload1 = canonicalAuthPayload({
      purpose: 'step-up', audience: AUDIENCE, challengeId: CHALLENGE_ID,
      nonce: NONCE_BYTES, keyId: KEY_ID, op: 'delete', resource: NOTE_1,
    });
    const payload2 = canonicalAuthPayload({
      purpose: 'step-up', audience: AUDIENCE, challengeId: CHALLENGE_ID,
      nonce: NONCE_BYTES, keyId: KEY_ID, op: 'delete', resource: NOTE_2,
    });
    const sig1 = await edSign(kp.privateKey, payload1);
    expect(await edVerify(kp.publicKey, sig1, payload1)).toBe(true);
    expect(await edVerify(kp.publicKey, sig1, payload2)).toBe(false);
  });

  it('AUTH-PROP-4 scope-binding: {read,write} and {write,read} produce byte-identical payloads (canonical scope — R3-3)', () => {
    const base = { audience: AUDIENCE, challengeId: CHALLENGE_ID, nonce: NONCE_BYTES, keyId: KEY_ID };
    const p1 = canonicalAuthPayload({ purpose: 'session', ...base, requestedScope: ['read', 'write'] });
    const p2 = canonicalAuthPayload({ purpose: 'session', ...base, requestedScope: ['write', 'read'] });
    expect(p1).toEqual(p2);
  });

  it('tampered single byte in signature → verification fails (AUTH-PROP-1/3 combined)', async () => {
    const kp = await freshKeypair();
    const payload = canonicalAuthPayload({
      purpose: 'session', audience: AUDIENCE, challengeId: CHALLENGE_ID,
      nonce: NONCE_BYTES, keyId: KEY_ID, requestedScope: ['read'],
    });
    const sig = await edSign(kp.privateKey, payload);
    sig[0] ^= 0xff;
    expect(await edVerify(kp.publicKey, sig, payload)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// authCrypto layer acceptance — F2 fingerprint / F6 token-hash / TLV verify integration
// (authCrypto.ts@3c29417)
//
// Tests the ACCEPTANCE-LEVEL security contracts exported by authCrypto.ts:
//   F2 — computeFingerprint = base64url(SHA-256(signingPublicKey)); byte-identical to the client's
//         Identity.id (PROP-3 cross-boundary invariant). The frozen vector asserted here MUST match
//         what the client derives, so any impl drift breaks this test immediately.
//   F6 — hashToken = base64url(SHA-256(token)); the at-rest grant hash. A raw token that ever
//         appears in the DB breaks F6 — this test pins the deterministic function output.
//   F5 — clampScope: server-enforced; a wider requestedScope is clamped to the entitlement, never
//         passed verbatim (closes scope-escalation).
//   TLV round-trip — verifySession reconstructs the canonical TLV from SERVER-HELD values and verifies
//         the client-submitted signature: this is the core of AUTH-PROP-3/4 integration.
//
// Signing uses @noble/ed25519 (same lib authCrypto.ts verifies with — no cross-impl risk).
// The authCrypto.test.ts unit layer covers per-function edge cases; this block covers CROSS-MODULE
// integration (canonical.ts TLV + authCrypto verify) at the acceptance boundary.
// ---------------------------------------------------------------------------

// Deterministic keypair for TLV verify integration tests (same approach as authCrypto.test.ts).
const AC_PRIV = new Uint8Array(32).fill(7);
const AC_PUB = ed.getPublicKey(AC_PRIV);
const AC_PUB_B64 = base64urlEncode(AC_PUB);
const AC_AUD = 'deltos.acceptance-test';
const AC_NONCE = new Uint8Array(32).fill(8);
const AC_NONCE_B64 = base64urlEncode(AC_NONCE);
const AC_CHALLENGE_ID = base64urlEncode(new Uint8Array(32).fill(2));
const nobleSign = (msg: Uint8Array) => base64urlEncode(ed.sign(msg, AC_PRIV));

describe('authCrypto layer acceptance — F2/F6/F5 + TLV verify integration (AUTH-PROP-3/4)', () => {

  it('F2: computeFingerprint = base64url(SHA-256(signingPublicKey)) — PROP-3 cross-boundary vector pinned', () => {
    // Same frozen pubkey used in authCrypto.test.ts — this is the client Identity.id cross-boundary pin.
    // If either the client derivation or server computeFingerprint drifts, one of these vectors breaks.
    const fromHex = (h: string) => new Uint8Array(h.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
    const pubkey = fromHex('d72f09afbc5466596b386cc67c3e1e59baf30f21a329faf3c5ccd3cadac8f3ce');
    expect(computeFingerprint(pubkey)).toBe('ZIqDVWjXSdI6CQ_HTSFmx0mRGM1LIzgEFMpspKdW11Q');
  });

  it('F6: hashToken is deterministic base64url(SHA-256(token)) — raw token never stored', () => {
    const h = hashToken('tok-acceptance');
    expect(h).toBe(hashToken('tok-acceptance'));        // deterministic
    expect(h).not.toBe(hashToken('tok-acceptance-2'));  // distinct inputs → distinct hashes
    // Length: SHA-256 = 32 bytes → 43 unpadded base64url chars.
    expect(h.length).toBe(43);
  });

  it('F5: clampScope intersects requestedScope with entitlement in canonical SCOPES order (scope-escalation closed)', () => {
    // read < write < delete < share (canonical SCOPES order)
    expect(clampScope(['delete', 'write', 'read'], ['read', 'write'])).toEqual(['read', 'write']);
    expect(clampScope(['delete', 'share'], ['read', 'write'])).toEqual([]);
  });

  it('F5: wider requestedScope than entitlement → granted scope is clamped, not requestedScope verbatim', () => {
    const clamped = clampScope(['read', 'write', 'delete'], ['read']);
    expect(clamped).toEqual(['read']);
    expect(clamped).not.toContain('write');
    expect(clamped).not.toContain('delete');
  });

  it('TLV round-trip — verifySession accepts signature signed over canonical session payload (AUTH-PROP-3/4 integration)', () => {
    // This is the core integration: client signs canonical TLV; server reconstructs from server-held
    // values (challengeId, nonce, keyId, audience) + request intent (requestedScope) and verifies.
    // canonical.ts + authCrypto.ts must agree or this fails — no workaround.
    const msg = canonicalAuthPayload({
      purpose: 'session', audience: AC_AUD, challengeId: AC_CHALLENGE_ID,
      nonce: AC_NONCE, keyId: 'KID-acc', requestedScope: ['read', 'write'],
    });
    expect(verifySession({
      audience: AC_AUD, challengeId: AC_CHALLENGE_ID,
      nonce: AC_NONCE_B64, keyId: 'KID-acc',
      requestedScope: ['read', 'write'],
      signature: nobleSign(msg),
      signingPublicKey: AC_PUB_B64,
    })).toBe(true);
  });

  it('TLV reconstruction fails on wrong audience — cross-deployment session replay blocked (F8)', () => {
    const msg = canonicalAuthPayload({
      purpose: 'session', audience: AC_AUD, challengeId: AC_CHALLENGE_ID,
      nonce: AC_NONCE, keyId: 'KID-acc', requestedScope: ['read'],
    });
    expect(verifySession({
      audience: 'evil.example.com', challengeId: AC_CHALLENGE_ID,
      nonce: AC_NONCE_B64, keyId: 'KID-acc',
      requestedScope: ['read'],
      signature: nobleSign(msg),
      signingPublicKey: AC_PUB_B64,
    })).toBe(false);
  });

  it('TLV reconstruction fails on wrong keyId — keyId is inside the signed payload, not just the challenge', () => {
    const msg = canonicalAuthPayload({
      purpose: 'session', audience: AC_AUD, challengeId: AC_CHALLENGE_ID,
      nonce: AC_NONCE, keyId: 'KID-acc', requestedScope: ['read'],
    });
    expect(verifySession({
      audience: AC_AUD, challengeId: AC_CHALLENGE_ID,
      nonce: AC_NONCE_B64, keyId: 'KID-DIFFERENT',
      requestedScope: ['read'],
      signature: nobleSign(msg),
      signingPublicKey: AC_PUB_B64,
    })).toBe(false);
  });

  it('verifyRegister: key-control proof — signature against the SUBMITTED pubkey proves private-key control (AUTH-PROP-3)', () => {
    const msg = canonicalAuthPayload({
      purpose: 'register', audience: AC_AUD, challengeId: AC_CHALLENGE_ID,
      nonce: AC_NONCE, signingPublicKey: AC_PUB, deviceLabel: 'acceptance-phone',
    });
    expect(verifyRegister({
      audience: AC_AUD, challengeId: AC_CHALLENGE_ID, nonce: AC_NONCE_B64,
      signingPublicKey: AC_PUB_B64, deviceLabel: 'acceptance-phone', signature: nobleSign(msg),
    })).toBe(true);
  });

  it('verifyStepUp: verified facts (keyId, op, resource) bound to the signed TLV — cannot be swapped at the chokepoint', () => {
    const resource = ResourceSchema.parse({ kind: 'note', id: '00000000-0000-4000-8000-aaaaaaaaaaaa' });
    const msg = canonicalAuthPayload({
      purpose: 'step-up', audience: AC_AUD, challengeId: AC_CHALLENGE_ID,
      nonce: AC_NONCE, keyId: 'KID-acc', op: 'delete', resource,
    });
    const verified = verifyStepUp({
      audience: AC_AUD, challengeId: AC_CHALLENGE_ID, nonce: AC_NONCE_B64,
      keyId: 'KID-acc', op: 'delete', resource, signature: nobleSign(msg),
      signingPublicKey: AC_PUB_B64,
    });
    expect(verified).not.toBeNull();
    expect(verified!.op).toBe('delete');
    expect(verified!.resource).toEqual(resource);
    expect(verified!.keyId).toBe('KID-acc');
  });
});

// ---------------------------------------------------------------------------
// AUTH-PROP-1 — replay resistance
// [strawman §3.2; PIN-ID-2; checklist §A]
//
// A captured session/step-up/register signature cannot be reused:
//   · random 32-byte nonce in the signed TLV
//   · atomic single-use challenge consume (rows-affected = 1; replay → 0 → reject)
// ---------------------------------------------------------------------------

describe('AUTH-PROP-1 — replay resistance', () => {
  it.todo('POST /api/auth/session with an already-consumed challengeId → 401 (rows-affected = 0)')
  it.todo('two concurrent /session calls with the same challengeId — exactly one 200, one 401')
  it.todo('POST /api/auth/register with a consumed register-challenge → 401')
  it.todo('step-up request with a consumed challengeId → 401 at the step-up validation layer')
});

// ---------------------------------------------------------------------------
// AUTH-PROP-2 — challenge freshness
// [strawman §3.2; secSys F11; checklist §A]
//
// Challenges carry a short TTL (~60s), stored UNCONSUMED. Expiry is checked against the
// STORED expiresAt vs server-now (never a client-supplied value).
// ---------------------------------------------------------------------------

describe('AUTH-PROP-2 — challenge freshness', () => {
  it.todo('GET /api/auth/challenge → challengeId + nonce + expiresAt in the future')
  it.todo('expiresAt is an ISO-8601 UTC timestamp roughly now + TTL seconds')
  it.todo('session with a challenge past its stored expiresAt → 401 stale')
  it.todo('expiry checked against STORED expiresAt, not any client-supplied value')
  // planSys precision note: freshness is instant-compared (parsed UTC), NOT lexical string comparison.
  // A timestamp like "2099-01-01T00:00:00.000Z" is lexically > server-now but must be
  // checked as a parsed instant so a future-backdated or timezone-shifted string cannot bypass TTL.
  it.todo('stale challenge whose timestamp is LEXICALLY LARGER but an EARLIER instant → 401 (freshness is instant-compared, not lexical)')
});

// ---------------------------------------------------------------------------
// AUTH-PROP-3 — pubkey↔account binding (no confused deputy)
// [strawman §3.3–3.4; PIN-ID-2; secSys F2; checklist §A]
//
// Server resolves signingPublicKey for keyId server-side (never from the request body).
// keyId is inside the signed TLV. An attacker signing with THEIR key for a victim's keyId
// fails verification because the server-resolved pubkey for that keyId belongs to the victim.
// Registration enforces accountFingerprint == base64url(SHA-256(signingPublicKey)) (F2).
// ---------------------------------------------------------------------------

describe('AUTH-PROP-3 — pubkey↔account binding (F2 + PIN-ID-2)', () => {
  // F2 — registration enforces the fingerprint binding server-side
  it.todo('POST /api/auth/register: server computes and uses accountFingerprint = base64url(SHA-256(signingPublicKey))')
  it.todo('POST /api/auth/register: client-supplied accountFingerprint that disagrees with SHA-256(pubkey) → 400 (F2 lock)')
  it.todo('POST /api/auth/register: attacker cannot register a victim fingerprint with their own pubkey (F2 closes the takeover)')

  // Server-side pubkey resolution
  it.todo('POST /api/auth/session: pubkey for keyId resolved server-side — request body cannot supply a substitute key')
  it.todo('POST /api/auth/session: signature made with a DIFFERENT private key for a valid keyId → 401')
  it.todo('POST /api/auth/session: unknown keyId (not in DeviceRegistry) → 401')
});

// ---------------------------------------------------------------------------
// AUTH-PROP-4 — intent / scope / audience binding
// [strawman §3 TLV payload; F4, F8; checklist §A]
//
// The signed TLV binds purpose (session/step-up/register), audience (deployment origin),
// and operation-specific fields so a signature cannot be repurposed across operations or deployments.
// ---------------------------------------------------------------------------

describe('AUTH-PROP-4 — intent / scope / audience binding (F4, F5, F8)', () => {
  // F8 — audience binding (route-level test: waits for routes/auth.ts handler bodies)
  it.todo('session signature with audience != server configured origin → 401 (cross-deployment replay fails)')

  // F4 — TLV canonicalization: no field-boundary confusion possible
  // LIVE — covered by authCrypto layer acceptance block above (verifySession TLV round-trip tests)
  it('TLV round-trip: canonicalAuthPayload output for session matches server reconstruction — authCrypto verify integration', () => {
    const msg = canonicalAuthPayload({
      purpose: 'session', audience: AC_AUD, challengeId: AC_CHALLENGE_ID,
      nonce: AC_NONCE, keyId: 'KID-prop4', requestedScope: ['read'],
    });
    expect(verifySession({
      audience: AC_AUD, challengeId: AC_CHALLENGE_ID,
      nonce: AC_NONCE_B64, keyId: 'KID-prop4',
      requestedScope: ['read'],
      signature: nobleSign(msg),
      signingPublicKey: AC_PUB_B64,
    })).toBe(true);
  });
  it.todo('session with a TLV signed for purpose=register → 401 (purpose field in TLV prevents cross-purpose reuse)')
  // planSys precision note: each endpoint must check the EXACT purpose string constant (e.g. "session",
  // "register", "step-up") from the TLV — a TLV signed for the right endpoint but with the WRONG
  // purpose literal (e.g. purpose="register" on /session, or a typo/variant) must reject.
  it.todo('signed request with the WRONG per-endpoint purpose string → 401 (constant-purpose binding — AUTH-PROP-4)')

  // F5 — scope clamped at mint: LIVE — authCrypto.clampScope is available
  it('session requestedScope wider than device entitlement → clampScope returns only the intersection (F5)', () => {
    // Server clamps at mint: {read, write, delete} ∩ {read} = {read}
    expect(clampScope(['read', 'write', 'delete'], ['read'])).toEqual(['read']);
  });
  it('clampScope output is in canonical SCOPES order, not requestedScope order (scope-ordering malleability closed)', () => {
    // client sends write before read; canonical order is read < write
    expect(clampScope(['write', 'read'], ['read', 'write'])).toEqual(['read', 'write']);
  });
});

// ---------------------------------------------------------------------------
// §D — Route acceptance (POST /api/auth/challenge, /register, /session; devices)
// [checklist §D]
// ---------------------------------------------------------------------------

describe('POST /api/auth/challenge', () => {
  it.todo('request with valid keyId + purpose=session → { challengeId, nonce, expiresAt }')
  it.todo('two calls to /challenge with the same keyId → distinct challengeIds (random nonces)')
  it.todo('request with purpose=register (no existing keyId required) → fresh register challenge')
  it.todo('unknown keyId for purpose=session → 404 or 401 (no challenge minted for unregistered key)')
  it.todo('returned nonce is at least 32 bytes when decoded from base64url')
});

describe('POST /api/auth/register', () => {
  it.todo('valid signingPublicKey + valid register-TLV signature + consumed challenge → 201 device registered')
  it.todo('device row created in DeviceRegistry with keyId, accountFingerprint, deviceLabel')
  it.todo('second register with the same signingPublicKey → 409 (no silent overwrite — PIN-ID-8 analog)')
  it.todo('register challenge is single-use: re-using it → 401')
  it.todo('enrollNew guard: the enroll flow must be gated behind explicit fresh-account intent (PIN-ID-8)')
  it.todo('enrollExisting (recovery) path uses enrollExisting(mnemonic), never enrollNew (PIN-ID-8)')
});

describe('POST /api/auth/session (mint grant token)', () => {
  it.todo('valid keypair + correct challenge + correct TLV signature → 200 { token, expiresAt }')
  it.todo('returned token is at least 32 bytes (base64url decoded)')
  it.todo('token stored in grants table as SHA-256(token) — raw token NOT in DB (F6)')
  it.todo('tampered TLV signature (one byte flipped) → 401')
  it.todo('expired challengeId → 401 (AUTH-PROP-2)')
  it.todo('already-consumed challengeId → 401 (AUTH-PROP-1)')
  it.todo('keyId not matching the issued challenge → 401 (challenge.keyId vs request.keyId mismatch)')
  it.todo('unknown keyId (not registered) → 401')
  it.todo('requestedScope wider than entitlement → clamped, not rejected (F5)')
});

describe('Device management — list + revoke', () => {
  it.todo('GET /api/auth/devices → list of registered devices for the account (requires bearer auth)')
  it.todo('DELETE /api/auth/devices/:deviceId → requires signed-request step-up (F9 sensitive set)')
  it.todo('step-up: StepUpRequest with valid op=delete, resource=deviceId, fresh challenge → step-up accepted')
  it.todo('step-up: signed-request (op=delete, resourceP) presented on (op=delete, resourceQ) → 403 at can()')
  it.todo('revoke succeeds → device row marked revoked / grant row revoked → subsequent bearer → 403')
});

// ---------------------------------------------------------------------------
// §F ACCEPTANCE — AUTHORIZED / REJECTED / REVOKED
// These are the three end-states the pilot brief names. Each maps to checklist §F.
// [checklist §F; slice §Stream A acceptance]
// ---------------------------------------------------------------------------

describe('AUTHORIZED — valid unrevoked grant token + correct scope → access granted', () => {
  it.todo('enroll → challenge → session → bearer token → note.get returns 200 (the full flow)')
  it.todo('resolvePrincipal parses Authorization: Bearer <token>, hashes it, resolves grant row → RequestPrincipal { method: "grant-token", grantId }')
  it.todo('can(principal { method: "grant-token" }, "read", workspace) → true for an active unrevoked grant with read scope')
  it.todo('can(principal { method: "grant-token" }, "write", workspace) → true for a grant that includes write scope')
  it.todo('grant token with expiresAt in the future → access granted; past expiresAt → 403')
  it.todo('access is scoped: granted scope does not include "delete" → can(..., "delete", ...) → false')
});

describe('REJECTED — any of these must deny, fail-closed', () => {
  // PIN-ID-1 — id alone never authorizes
  it.todo('request body carrying only accountFingerprint / Identity.id with no bearer token → no auth proof → 401 or 403')
  it.todo('no Authorization header → resolvePrincipal yields unverified; dev → through (unverified stub); prod allowlist → 503')

  // Signature failures
  it.todo('tampered TLV signature in /session → 401 (fail-closed, signature does not verify)')
  it.todo('TLV signed with WRONG private key for the registered keyId → 401')
  it.todo('TLV signed for purpose=register used on /session → 401 (AUTH-PROP-4 — purpose mismatch)')

  // Challenge freshness / single-use
  it.todo('replayed challengeId (consumed) → 401 (AUTH-PROP-1)')
  it.todo('stale challenge (expiresAt in the past) → 401 (AUTH-PROP-2)')

  // Registration safety
  it.todo('register with computed fingerprint != SHA-256(submitted pubkey) → 400 (F2 — account takeover prevented)')

  // Unrecognized method
  it.todo('PrincipalVerification with unrecognized method → can() default-deny → 403 (F10)')
  it.todo('unverified method outside allowlist env → 503 (F13)')

  // Step-up cross-(op,resource) mismatch (tested live in can.test.ts; retained here as integration)
  it.todo('signed-request step-up (op=delete, resource=noteA) on request (op=read, resource=noteA) → 403 at can()')
  it.todo('signed-request step-up (op=delete, resource=noteA) on request (op=delete, resource=noteB) → 403 at can()')
});

describe('REVOKED — device revocation makes the next request deny immediately (PIN-ID-5)', () => {
  it.todo('revoke device via DELETE /api/auth/devices/:deviceId with valid step-up → 200')
  it.todo('bearer token for the revoked device on note.get → 403 immediately (no validity window)')
  it.todo('revocation resolves the registry row every request — no cached-valid window after revoke')
  it.todo('revoking device A does not affect device B bearer token on the same account')
  it.todo('PIN-ID-5/F1 limitation: a holder of the mnemonic can enrollExisting and mint a fresh token — revoke ≠ cryptographic lockout')
});

// ---------------------------------------------------------------------------
// §G — Reuse-discipline gate (audited by secSys on each Stream A chunk)
// These are audit notes, not automated tests — captured as todo so they appear in the
// acceptance run output and can be manually cleared by secSys during code review.
// ---------------------------------------------------------------------------

describe('§G — reuse-discipline gate (manual audit — secSys clears each)', () => {
  it.todo('routes/auth.ts: no AppOwner / Evolu-isms past KeyDerivation; no cookie-auth leftovers')
  it.todo('@evolu/common: if used, zero Evolu-isms leak past KeyDerivation; @noble/ed25519 is generic crypto (reuse-clean)')
  it.todo('canonical.ts / requests.ts: no trkr vestiges; TLV framing is clean deltos-native')
});

// ---------------------------------------------------------------------------
// §H — End-to-end done-sentence (integration, wired in Stream D)
// Kept here as a placeholder so the acceptance harness is complete; moved to integration test
// when Stream D mounts A+B+C.
// ---------------------------------------------------------------------------

describe('§H — Stream A done-sentence (integration — move to Stream D harness when wired)', () => {
  it.todo('enroll new account: passkey + 24-word phrase shown once, guarded behind fresh-account intent (PIN-ID-8)')
  it.todo('lock / unlock via passkey (local unlock of at-rest blob — PIN-ID-4)')
  it.todo('recover on a fresh device via recovery phrase (enrollExisting)')
  it.todo('QR-join a second device with out-of-band confirmation code (PIN-ID-7)')
  it.todo('every authenticated request carries a verifiable signed-challenge grant; none authorize on id alone')
  it.todo('revoke a device by revoking its grant → immediate deny on next request')
});
