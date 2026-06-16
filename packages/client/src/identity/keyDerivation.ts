/**
 * KeyDerivation — the deterministic root of the deltos identity stream.
 *
 * A 24-word BIP39 mnemonic is the ONLY secret. From it we derive (deterministically, on every
 * device that types the phrase):
 *   - the account **signing keypair** (Ed25519) that proves account possession to the server
 *     (PIN-ID-2: requests carry an opaque grant minted from a signed challenge, never `id`),
 *   - the **at-rest key** that wraps the local encrypted Identity blob (KeyStore, PIN-ID-4),
 *   - the **encryption key** reserved for Phase-2 per-notebook E2EE.
 *
 * These three are SLIP-21 **siblings** — branched at the same level under the `deltos` namespace,
 * never one derived from another — so a compromise or rotation of one never exposes the others
 * (the domain-separation property S1 flagged as load-bearing). `Identity.id` is NOT a separate
 * sibling: it is `base64url(SHA-256(signing public key))` (PIN-ID-3), which is exactly what the
 * server independently recomputes as `accountFingerprint` (F2) — one definition, two sides.
 *
 * Crypto primitives are the audited, dependency-light @noble / @scure libraries (generic crypto,
 * reuse-clean — NOT the full-beans custody packet). Deterministic Ed25519 keygen uses @noble
 * because WebCrypto rejects raw 32-byte private-key import (F12); the server verifies the SAME
 * signatures via WebCrypto raw-PUBLIC import.
 */

import * as ed from '@noble/ed25519';
import { hmac } from '@noble/hashes/hmac.js';
import { sha512, sha256 } from '@noble/hashes/sha2.js';
import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { base64urlEncode } from '@deltos/shared';

// @noble/ed25519 v3 needs its SHA-512 implementation wired explicitly (it ships none by default,
// to stay zero-dependency). Set it once at module load from @noble/hashes.
if (!ed.hashes.sha512) ed.hashes.sha512 = sha512;

const utf8 = new TextEncoder();

/** SLIP-21 derivation paths. Siblings under the shared `deltos` namespace; `v1` allows rotation. */
export const SIGNING_KEY_PATH = ['deltos', 'account-signing-key', 'v1'] as const;
export const AT_REST_KEY_PATH = ['deltos', 'at-rest-key', 'v1'] as const;
/** Reserved for Phase-2 per-notebook encryption — derivable now so the hierarchy never changes. */
export const ENCRYPTION_KEY_PATH = ['deltos', 'encryption-key', 'v1'] as const;

/** Entropy for a 24-word mnemonic (256 bits). */
const MNEMONIC_ENTROPY_BITS = 256;

/** An Ed25519 keypair as raw 32-byte seeds — the device's account signing identity. */
export interface AccountKeypair {
  /** 32-byte Ed25519 private seed. Never leaves the device; never persisted unencrypted. */
  readonly privateKey: Uint8Array;
  /** 32-byte Ed25519 public key. Registered server-side; safe to share. */
  readonly publicKey: Uint8Array;
}

/** Everything Phase-1 derives from the mnemonic. `encryptionKey` is intentionally Phase-2-only. */
export interface KeyHierarchy {
  /** `Identity.id` — base64url(SHA-256(signing public key)). Stable across every device. */
  readonly id: string;
  /** Account signing keypair for server authentication. */
  readonly signing: AccountKeypair;
  /** Symmetric key wrapping the local at-rest Identity blob (KeyStore). */
  readonly atRestKey: Uint8Array;
}

/** Generate a fresh 24-word recovery phrase. */
export function generateMnemonic(): string {
  return bip39.generateMnemonic(wordlist, MNEMONIC_ENTROPY_BITS);
}

/** Validate a phrase against the wordlist + checksum. */
export function validateMnemonic(mnemonic: string): boolean {
  return bip39.validateMnemonic(mnemonic, wordlist);
}

/**
 * Mnemonic → 64-byte seed via BIP39 (PBKDF2-HMAC-SHA512 ×2048 — real KDF hardening). deltos uses
 * an empty passphrase by default: the phrase itself is the only secret, no separate 25th word.
 */
export function mnemonicToSeed(mnemonic: string, passphrase = ''): Promise<Uint8Array> {
  return bip39.mnemonicToSeed(mnemonic, passphrase);
}

/**
 * SLIP-0021 node derivation. The root is `HMAC-SHA512("Symmetric key seed", seed)`; each path
 * label descends via `HMAC-SHA512(node[0:32], 0x00 || label)`. The left half of a node is the
 * HMAC key for its children; the right half is the node's usable key material.
 */
function slip21Node(seed: Uint8Array, path: readonly string[]): Uint8Array {
  let node = hmac(sha512, utf8.encode('Symmetric key seed'), seed);
  for (const label of path) {
    const labelBytes = utf8.encode(label);
    const message = new Uint8Array(1 + labelBytes.length);
    message[0] = 0x00;
    message.set(labelBytes, 1);
    node = hmac(sha512, node.slice(0, 32), message);
  }
  return node;
}

/** The 32-byte symmetric key (right half of the SLIP-21 leaf node) at `path`. */
export function slip21Key(seed: Uint8Array, path: readonly string[]): Uint8Array {
  return slip21Node(seed, path).slice(32);
}

/** Derive the Ed25519 account signing keypair from the seed's signing sibling. */
export function deriveSigningKeypair(seed: Uint8Array): AccountKeypair {
  const privateKey = slip21Key(seed, SIGNING_KEY_PATH);
  const publicKey = ed.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

/** `Identity.id` from a signing public key — the same value the server recomputes (F2). */
export function accountId(publicKey: Uint8Array): string {
  return base64urlEncode(sha256(publicKey));
}

/** Derive the full Phase-1 key hierarchy from a recovery phrase. */
export async function deriveKeyHierarchy(
  mnemonic: string,
  passphrase = '',
): Promise<KeyHierarchy> {
  const seed = await mnemonicToSeed(mnemonic, passphrase);
  const signing = deriveSigningKeypair(seed);
  const atRestKey = slip21Key(seed, AT_REST_KEY_PATH);
  return { id: accountId(signing.publicKey), signing, atRestKey };
}
