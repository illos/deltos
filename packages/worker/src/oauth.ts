import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { base64urlEncode } from '@deltos/shared';

/**
 * Worker-side OAuth security primitives (docs/design/oauth-provider.md §4) — the two anti-phishing controls
 * that MUST hold for the provider to be safe: exact redirect-uri matching (with the RFC 8252 loopback
 * port-exception) and PKCE S256 verification. These live in the worker (not `@deltos/shared`) because they
 * depend on the `URL` global; keeping them pure + synchronous (noble sha256, same as `hashToken`) makes them
 * directly unit-testable. The schemas + discovery builders stay in `@deltos/shared/api/oauth`.
 */

/**
 * Is `url` an RFC 8252 loopback redirect? (`http://127.0.0.1[:port]/…` or `http://[::1][:port]/…`). Native
 * MCP clients register a loopback URI and bind an EPHEMERAL port at runtime, so loopback matches on
 * scheme+host+path but NOT port. Driving through `new URL()` canonicalizes the host (IPv4-mapped/hex/
 * trailing-dot tricks) BEFORE we compare — never string-sniff a raw URL. Returns the port-stripped identity,
 * or null if not a loopback http URL.
 */
export function loopbackIdentity(url: string): { scheme: string; host: string; path: string } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:') return null; // loopback exception is http-only; everything else must be https
  const host = u.hostname;
  const isLoopback = host === '127.0.0.1' || host === '[::1]' || host === '::1';
  if (!isLoopback) return null;
  return { scheme: u.protocol, host, path: u.pathname };
}

/**
 * THE anti-phishing control: is `requested` an allowed redirect for this client? A code/token is delivered
 * ONLY to a URI that either EXACT-string-matches a registered URI, or (loopback only) matches a registered
 * loopback URI on scheme+host+path with any port. No wildcards, no prefix/substring match. Checked at BOTH
 * /authorize (before consent) and /token (must equal the value bound into the code). Fail-closed: an
 * unparseable or non-matching requested URI returns false.
 */
export function matchRedirectUri(requested: string, registered: readonly string[]): boolean {
  if (registered.includes(requested)) return true; // exact match (the common, non-loopback case)
  const req = loopbackIdentity(requested);
  if (!req) return false;
  return registered.some((r) => {
    const reg = loopbackIdentity(r);
    return reg !== null && reg.scheme === req.scheme && reg.host === req.host && reg.path === req.path;
  });
}

/**
 * Is `uri` acceptable to REGISTER as a redirect? Must be either https (public) or an http loopback (native
 * client, RFC 8252). Bare http to a non-loopback host is refused — it would leak the code over plaintext to
 * an arbitrary host. Fail-closed on unparseable input.
 */
export function isRegisterableRedirectUri(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.protocol === 'https:') return true;
  return loopbackIdentity(uri) !== null;
}

/** PKCE S256 transform: `BASE64URL(SHA256(ASCII(verifier)))` (RFC 7636 §4.6), same codec as `hashToken`. */
export function pkceChallengeFromVerifier(verifier: string): string {
  return base64urlEncode(sha256(utf8ToBytes(verifier)));
}

/**
 * Verify a PKCE code_verifier against the stored S256 code_challenge (RFC 7636). Recomputes the challenge
 * from the presented verifier and compares. `plain` is never accepted (rejected at the /authorize boundary).
 * Constant-time-ish compare over the fixed-length base64url digests as hygiene, though the challenge is not
 * itself a long-term secret.
 */
export function verifyPkceS256(verifier: string, storedChallenge: string): boolean {
  const computed = pkceChallengeFromVerifier(verifier);
  if (computed.length !== storedChallenge.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) diff |= computed.charCodeAt(i) ^ storedChallenge.charCodeAt(i);
  return diff === 0;
}
