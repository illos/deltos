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

import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { NoteRefSchema } from '@deltos/shared';
import type { Resource } from '@deltos/shared';
import { guard, type GuardDeps, type AppContext } from '../src/http.js';
import type { Env } from '../src/env.js';

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
  // F8 — audience binding
  it.todo('session signature with audience != server configured origin → 401 (cross-deployment replay fails)')

  // F4 — TLV canonicalization: no field-boundary confusion possible
  it.todo('TLV round-trip: canonicalAuthPayload output for session matches server reconstruction')
  it.todo('session with a TLV signed for purpose=register → 401 (purpose field in TLV prevents cross-purpose reuse)')
  // planSys precision note: each endpoint must check the EXACT purpose string constant (e.g. "session",
  // "register", "step-up") from the TLV — a TLV signed for the right endpoint but with the WRONG
  // purpose literal (e.g. purpose="register" on /session, or a typo/variant) must reject.
  it.todo('signed request with the WRONG per-endpoint purpose string → 401 (constant-purpose binding — AUTH-PROP-4)')

  // F5 — scope clamped at mint
  it.todo('session requestedScope wider than device entitlement → granted scope is clamped, not verbatim requestedScope')
  it.todo('granted scope returned in the session response matches intersection(requested, entitlement)')
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
