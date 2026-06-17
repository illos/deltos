import { argon2id } from '@noble/hashes/argon2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes, randomBytes } from '@noble/hashes/utils.js';
import { base64urlEncode, base64urlDecodeStrict } from '@deltos/shared';

/**
 * Password + recovery-phrase crypto for the auth pivot (`docs/specs/auth-pivot-password.md`,
 * security model `[[auth-pivot-security-model]]`). The worker NEVER stores a raw password or phrase —
 * only an Argon2id PHC verifier. Three security invariants live here (secSys reviews them):
 *
 *  1. **Argon2id via the already-vendored pure-JS `@noble/hashes`** (no new dep, no WASM — ladder
 *     rung 1). Params `m=19456 KiB, t=2, p=1` (OWASP floor), per-credential random 16B salt, 32B output.
 *     `AP-M1` measures the real-CF-Workers cost and TUNES these params; the algorithm is fixed.
 *  2. **PEPPER as a Worker secret, HMAC'd BEFORE the hash** (AP-T6): the Argon2id input is
 *     `HMAC-SHA256(pepper, password)`, never the raw password. A D1-only leak (PHC strings, no pepper)
 *     is therefore NOT offline-crackable — the attacker is missing the Worker-secret key.
 *  3. **Constant-time compare** of the recomputed hash, and **no early return on an unknown user**:
 *     the route runs {@link dummyHash} so an unknown-username login does the SAME Argon2id work, leaving
 *     no account-existence timing oracle (AP-T5). Gate-before-hash (AP-T4) lives in the route.
 *
 * PHC string: `$argon2id$v=19$m=<m>,t=<t>,p=<p>$<saltB64url>$<hashB64url>`. The salt/hash segments are
 * UNPADDED base64url (deltos' one canonical binary codec — the Workers runtime has no `Buffer`, and
 * this verifier is in-house, never fed to an external argon2 implementation, so standard-base64 PHC
 * interop is not a requirement). The structure is otherwise the conventional PHC layout.
 */

export interface Argon2Params {
  /** Memory cost in KiB. */
  m: number;
  /** Time cost (iterations). */
  t: number;
  /** Parallelism. */
  p: number;
}

/** OWASP-floor target (AP-6). AP-M1 tunes these to the real-Workers CPU/memory budget; algorithm fixed. */
export const DEFAULT_ARGON2_PARAMS: Argon2Params = { m: 19456, t: 2, p: 1 };

const ARGON2_VERSION = 0x13; // 19 — the value encoded in the PHC `v=` field.
const SALT_BYTES = 16;
const HASH_BYTES = 32;

/** The result of verifying a credential: did it match, and (on a match) are the stored params stale? */
export interface VerifyResult {
  ok: boolean;
  /** True only when `ok` AND the stored PHC params differ from the current target → rehash-on-login (AP-6). */
  needsRehash: boolean;
}

/**
 * Apply the pepper: `HMAC-SHA256(pepper, domain-separated-input)`. The `domain` binds the use
 * (password vs a per-account recovery verifier) so the same secret can never be cross-used, and lets
 * the recovery verifier be **keyed to the accountId** (AP-T10) by folding it into the pre-image.
 */
function peppered(pepper: string, parts: readonly string[]): Uint8Array {
  // NUL-join the parts so concatenation is unambiguous (no `a|bc` == `ab|c` collision).
  return hmac(sha256, utf8ToBytes(pepper), utf8ToBytes(parts.join('\x00')));
}

function runArgon2id(pre: Uint8Array, salt: Uint8Array, params: Argon2Params): Uint8Array {
  return argon2id(pre, salt, { m: params.m, t: params.t, p: params.p, dkLen: HASH_BYTES });
}

function encodePhc(params: Argon2Params, salt: Uint8Array, hash: Uint8Array): string {
  return `$argon2id$v=${ARGON2_VERSION}$m=${params.m},t=${params.t},p=${params.p}$${base64urlEncode(
    salt,
  )}$${base64urlEncode(hash)}`;
}

interface ParsedPhc {
  params: Argon2Params;
  salt: Uint8Array;
  hash: Uint8Array;
}

/** Parse a PHC string; null on any malformation (fail-closed — a bad row verifies as false, never throws). */
function parsePhc(phc: string): ParsedPhc | null {
  // `$argon2id$v=19$m=..,t=..,p=..$salt$hash` → ['', 'argon2id', 'v=19', 'm=..,t=..,p=..', salt, hash]
  const parts = phc.split('$');
  if (parts.length !== 6) return null;
  const [, algo, version, costs, saltB64, hashB64] = parts;
  if (algo !== 'argon2id' || version !== `v=${ARGON2_VERSION}`) return null;
  if (costs === undefined || saltB64 === undefined || hashB64 === undefined) return null;
  const costMatch = /^m=(\d+),t=(\d+),p=(\d+)$/.exec(costs);
  if (!costMatch) return null;
  const params: Argon2Params = {
    m: Number(costMatch[1]),
    t: Number(costMatch[2]),
    p: Number(costMatch[3]),
  };
  if (params.m <= 0 || params.t <= 0 || params.p <= 0) return null;
  try {
    return { params, salt: base64urlDecodeStrict(saltB64), hash: base64urlDecodeStrict(hashB64) };
  } catch {
    return null;
  }
}

/**
 * Does `s` parse as a REAL Argon2id PHC verifier? The server uses this (NOT a string-equality check) to
 * decide whether a recovery verifier is established (Option B): /finalize refuses unless this is true, so
 * `recoveryEstablished=true` always IMPLIES a real verifier; /reset routes a non-PHC stored value through
 * the dummy-hash branch so a pending account costs the same Argon2id time (no timing oracle). Robust to
 * ANY non-PHC placeholder, not just the canonical sentinel.
 */
export function isPhc(s: string): boolean {
  return parsePhc(s) !== null;
}

/**
 * The fails-CLOSED placeholder stored in `recoveryPhc` between /signup and /recovery/rotate (Option B).
 * NOT a parseable PHC (`isPhc` is false) — kept here so the writer (signup) + the crypto predicate agree.
 */
export const UNESTABLISHED_VERIFIER = 'unestablished';

/** Length-checked, branch-free XOR accumulate — no early exit on the first differing byte. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

// ── Password ─────────────────────────────────────────────────────────────────────────────────────

/** Hash a password into a PHC verifier (pepper HMAC'd in first; random salt). The raw password is never stored. */
export function hashPassword(
  password: string,
  pepper: string,
  params: Argon2Params = DEFAULT_ARGON2_PARAMS,
): string {
  const salt = randomBytes(SALT_BYTES);
  const hash = runArgon2id(peppered(pepper, ['password', password]), salt, params);
  return encodePhc(params, salt, hash);
}

/** Verify a password against a stored PHC verifier; constant-time, with a rehash-on-stale-params signal. */
export function verifyPassword(
  password: string,
  phc: string,
  pepper: string,
  target: Argon2Params = DEFAULT_ARGON2_PARAMS,
): VerifyResult {
  const parsed = parsePhc(phc);
  if (!parsed) return { ok: false, needsRehash: false };
  const candidate = runArgon2id(peppered(pepper, ['password', password]), parsed.salt, parsed.params);
  const ok = constantTimeEqual(candidate, parsed.hash);
  return { ok, needsRehash: ok && !sameParams(parsed.params, target) };
}

function sameParams(a: Argon2Params, b: Argon2Params): boolean {
  return a.m === b.m && a.t === b.t && a.p === b.p;
}

/**
 * Burn the SAME Argon2id work as a real verify, against a throwaway salt, for the unknown-user branch
 * (AP-T5). The route calls this instead of returning early so an unknown username and a wrong password
 * cost the same wall-clock — no account-existence timing oracle. The result is intentionally discarded.
 */
export function dummyHash(
  password: string,
  pepper: string,
  params: Argon2Params = DEFAULT_ARGON2_PARAMS,
): void {
  runArgon2id(peppered(pepper, ['password', password]), randomBytes(SALT_BYTES), params);
}

// ── Recovery phrase ──────────────────────────────────────────────────────────────────────────────

/**
 * Mint a high-entropy recovery phrase (160 bits — well above the ≥128-bit floor; NEVER user-chosen).
 * Grouped lowercase Crockford-ish base32 (`xxxx-xxxx-…`) so it is human-recordable. Shown EXACTLY ONCE
 * at register; the server keeps only the Argon2id verifier. This is the single master reset secret.
 */
export function generateRecoveryPhrase(): string {
  const bytes = randomBytes(20); // 160 bits
  const b32 = base32Lower(bytes); // 32 chars
  return (b32.match(/.{1,4}/g) ?? [b32]).join('-');
}

/** Normalize a re-typed phrase for verification: lowercase, strip the grouping hyphens + whitespace. */
export function normalizeRecoveryPhrase(phrase: string): string {
  return phrase.toLowerCase().replace(/[\s-]/g, '');
}

/** Hash a recovery phrase into a PHC verifier KEYED TO accountId (folded into the peppered pre-image). */
export function hashRecoveryPhrase(
  phrase: string,
  accountId: string,
  pepper: string,
  params: Argon2Params = DEFAULT_ARGON2_PARAMS,
): string {
  const salt = randomBytes(SALT_BYTES);
  const pre = peppered(pepper, ['recovery', accountId, normalizeRecoveryPhrase(phrase)]);
  return encodePhc(params, salt, runArgon2id(pre, salt, params));
}

/** Verify a recovery phrase against the account's stored verifier; constant-time. */
export function verifyRecoveryPhrase(
  phrase: string,
  accountId: string,
  phc: string,
  pepper: string,
): boolean {
  const parsed = parsePhc(phc);
  if (!parsed) return false;
  const pre = peppered(pepper, ['recovery', accountId, normalizeRecoveryPhrase(phrase)]);
  return constantTimeEqual(runArgon2id(pre, parsed.salt, parsed.params), parsed.hash);
}

/** Burn recovery-verify work for an unknown username at reset (AP-T5 sibling — no existence oracle). */
export function dummyRecoveryHash(
  phrase: string,
  pepper: string,
  params: Argon2Params = DEFAULT_ARGON2_PARAMS,
): void {
  runArgon2id(peppered(pepper, ['recovery', 'unknown', normalizeRecoveryPhrase(phrase)]), randomBytes(SALT_BYTES), params);
}

// ── base32 (RFC 4648 lowercase, no padding) ────────────────────────────────────────────────────────

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** Lowercase RFC-4648 base32, no padding. Used for the recovery phrase + (uppercased) the TOTP secret. */
export function base32Lower(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | (bytes[i] ?? 0);
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET.charAt((value << (5 - bits)) & 31);
  return out;
}
