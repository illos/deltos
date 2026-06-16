import { SCOPES, type Op, type Resource, type Scope } from '../api/grant.js';

/**
 * The ONE canonical signed-payload codec the client signer and the server verifier both compute.
 * Because it lives in `@deltos/shared`, both sides call THIS exact function — the signed bytes can
 * never drift between them. The server NEVER trusts a client-sent payload blob; it reconstructs the
 * payload here from SERVER-HELD values (stored `nonce`/`keyId`/`purpose`, configured `audience`, the
 * fixed `tag`) plus the genuinely request-supplied INTENT fields, and verifies the signature over it.
 *
 * Framing (secSys F4): every field is `uint32-BE(byteLength) || bytes`, concatenated in a FIXED order
 * per purpose. No raw delimiter — a variable-length field (a device label, a scope, a resource id)
 * can never shift bytes across a boundary, so the framing is unambiguous regardless of field contents.
 */

/** Protocol/version tag bound into every payload — a version marker, NOT an audience (secSys F8). */
export const AUTH_TAG = 'deltos-auth-v1';

/** The three signing purposes. The purpose literal is itself a bound field (AUTH-3 intent binding). */
export const AUTH_PURPOSES = ['register', 'session', 'step-up'] as const;
export type AuthPurpose = (typeof AUTH_PURPOSES)[number];

/**
 * UTF-8 encode a string by hand — like {@link base64urlEncode} in `encoding.ts`, this depends on NO
 * platform global (`TextEncoder`), so the canonical payload type-checks and runs byte-identically in a
 * Worker, the browser, and Node. Surrogate pairs are combined to their code point so a non-BMP
 * character in an audience or device label encodes correctly.
 */
function utf8(str: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
      }
    }
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return new Uint8Array(out);
}

function toBytes(value: string | Uint8Array): Uint8Array {
  return typeof value === 'string' ? utf8(value) : value;
}

/** `uint32-BE(len) || bytes` — the single framing primitive (F4). */
function field(value: string | Uint8Array): Uint8Array {
  const body = toBytes(value);
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, body.length, false); // big-endian length prefix
  out.set(body, 4);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * R3-3 composite canon — the requested scope SET as a SORTED-by-enum-order, DE-DUPLICATED sub-TLV.
 * Iterating the closed {@link SCOPES} enum makes the order canonical and independent of the input
 * order, so `{read,write}` and `{write,read}` produce byte-identical output: the signature pins the
 * SET, and scope reordering is not a malleability seam. Each member is its own length-prefixed field.
 */
export function requestedScopeCanonical(scopes: readonly Scope[]): Uint8Array {
  const present = new Set(scopes);
  return concat(SCOPES.filter((s) => present.has(s)).map((s) => field(s)));
}

/**
 * R3-3 composite canon — a resource as `TLV(kind, idOrEmpty)`, `kind` its OWN field so `{note,id}`
 * and `{notebook,id}` with the same `id` string can never collide; `workspace` emits an empty id
 * field. This injectivity is what makes `can()`'s `resourceEquals` on the echoed verified resource a
 * faithful decode of exactly what was signed.
 */
export function resourceCanonical(resource: Resource): Uint8Array {
  const id = resource.kind === 'workspace' ? '' : resource.id;
  return concat([field(resource.kind), field(id)]);
}

/**
 * Structured input per purpose. Binary fields (`nonce`, `signingPublicKey`) are raw bytes — the
 * caller decodes the base64url wire/storage form once, so the signed bytes bind the actual entropy
 * rather than an encoding of it.
 */
export type AuthPayloadInput =
  | {
      purpose: 'register';
      audience: string;
      challengeId: string;
      nonce: Uint8Array;
      signingPublicKey: Uint8Array;
      deviceLabel: string;
    }
  | {
      purpose: 'session';
      audience: string;
      challengeId: string;
      nonce: Uint8Array;
      keyId: string;
      requestedScope: readonly Scope[];
    }
  | {
      purpose: 'step-up';
      audience: string;
      challengeId: string;
      nonce: Uint8Array;
      keyId: string;
      op: Op;
      resource: Resource;
    };

/**
 * Compute the canonical signed payload. Fixed field order per purpose:
 *   register : TAG, audience, 'register', challengeId, nonce, signingPublicKey, deviceLabel
 *   session  : TAG, audience, 'session',  challengeId, nonce, keyId, requestedScopeCanonical
 *   step-up  : TAG, audience, 'step-up',  challengeId, nonce, keyId, op, resourceCanonical
 * The shared head (tag, audience, purpose, challengeId, nonce) binds version, deployment audience
 * (F8), intent (AUTH-3), the single-use challenge, and freshness nonce into every signature.
 */
export function canonicalAuthPayload(input: AuthPayloadInput): Uint8Array {
  const head = [
    field(AUTH_TAG),
    field(input.audience),
    field(input.purpose),
    field(input.challengeId),
    field(input.nonce),
  ];
  switch (input.purpose) {
    case 'register':
      return concat([...head, field(input.signingPublicKey), field(input.deviceLabel)]);
    case 'session':
      return concat([...head, field(input.keyId), field(requestedScopeCanonical(input.requestedScope))]);
    case 'step-up':
      return concat([...head, field(input.keyId), field(input.op), field(resourceCanonical(input.resource))]);
    default: {
      const _exhaustive: never = input;
      throw new Error('canonicalAuthPayload: unreachable purpose');
    }
  }
}
