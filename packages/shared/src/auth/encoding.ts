/**
 * The single binary↔text encoding the auth layer shares between the client and the worker.
 *
 * `Identity.id` (client) and `accountFingerprint` (server, F2) are BOTH
 * `base64urlEncode(SHA-256(signingPublicKey))`. The server's whole fingerprint↔key binding rests
 * on those two strings being byte-identical, so there is exactly one codec — RFC 4648 §5
 * (URL-safe alphabet `-`/`_`, NO `=` padding) — and both sides import it from here rather than
 * hand-rolling base64 at each call site.
 *
 * Implemented by hand from the alphabet rather than via `btoa`/`atob` or `Buffer` so it depends on
 * NO platform global — it type-checks and runs identically in a Worker, the browser, and Node.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const LOOKUP: Record<string, number> = {};
for (let i = 0; i < ALPHABET.length; i++) LOOKUP[ALPHABET.charAt(i)] = i;
// Tolerate standard-base64 input (`+`/`/`) on decode; encode only ever emits the URL-safe set.
LOOKUP['+'] = 62;
LOOKUP['/'] = 63;

/** Encode bytes as unpadded base64url. */
export function base64urlEncode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const has1 = i + 1 < bytes.length;
    const has2 = i + 2 < bytes.length;
    const triple = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += ALPHABET[(triple >> 18) & 63];
    out += ALPHABET[(triple >> 12) & 63];
    if (has1) out += ALPHABET[(triple >> 6) & 63];
    if (has2) out += ALPHABET[triple & 63];
  }
  return out;
}

/** Decode unpadded (or padded) base64url back to bytes. */
export function base64urlDecode(text: string): Uint8Array {
  const clean = text.replace(/=+$/, '');
  const out: number[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    const has2 = i + 2 < clean.length;
    const has3 = i + 3 < clean.length;
    const c0 = LOOKUP[clean.charAt(i)] ?? 0;
    const c1 = LOOKUP[clean.charAt(i + 1)] ?? 0;
    const c2 = LOOKUP[clean.charAt(i + 2)] ?? 0;
    const c3 = LOOKUP[clean.charAt(i + 3)] ?? 0;
    const triple = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    out.push((triple >> 16) & 0xff);
    if (has2) out.push((triple >> 8) & 0xff);
    if (has3) out.push(triple & 0xff);
  }
  return new Uint8Array(out);
}

/** Thrown by {@link base64urlDecodeStrict} when input is not canonical unpadded base64url. */
export class Base64urlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Base64urlError';
  }
}

/**
 * STRICT decode for the wire boundary (R3-4): accept ONLY canonical, unpadded base64url and throw on
 * anything else — a non-URL-safe character, any `=` padding, a `mod 4 === 1` length, or non-canonical
 * trailing bits (e.g. `Zh` for the byte `Zg` decodes to). The canonicality check is a round-trip:
 * a value is canonical iff re-encoding its decoded bytes reproduces the exact input string. This
 * forecloses a field having two distinct textual encodings that a signature would treat as different
 * messages, and it lets the request schemas reject malformed/oversized blobs before they reach crypto.
 */
export function base64urlDecodeStrict(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) {
    throw new Base64urlError('base64url: illegal character or padding (URL-safe alphabet, no `=`)');
  }
  if (text.length % 4 === 1) {
    throw new Base64urlError('base64url: invalid length (mod 4 === 1 is impossible)');
  }
  const bytes = base64urlDecode(text);
  if (base64urlEncode(bytes) !== text) {
    throw new Base64urlError('base64url: non-canonical encoding (trailing bits must be zero)');
  }
  return bytes;
}
