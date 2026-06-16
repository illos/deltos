/**
 * The at-rest blob crypto core for KeyStore: AES-GCM seal/open + HKDF wrapping-key derivation.
 *
 * This is the decision-INDEPENDENT half of the custody layer. It takes a 32-byte wrapping key as
 * an argument and never decides where that key comes from — that policy (WebAuthn PRF output when
 * available, a device-local fallback on the UV-only baseline) lives in the KeyStore and is the
 * subject of a separate secSys ruling (PIN-ID-6). Keeping the crypto here, key-source there, means
 * the sealing primitive is correct and testable on its own.
 *
 * All primitives are WebCrypto (AES-GCM-256, HKDF-SHA256) — present in the browser and in Workers,
 * no library pulled. The encoded blob is JSON-friendly (base64url fields) so it drops straight into
 * IndexedDB.
 */

import { base64urlEncode, base64urlDecode } from '@deltos/shared';

const IV_BYTES = 12; // AES-GCM standard nonce length

/**
 * WebCrypto wants a `BufferSource` backed by a plain `ArrayBuffer`; a `Uint8Array` may be backed by
 * `ArrayBufferLike` (TS 5.7), which the DOM types reject. Copy out the exact view as an ArrayBuffer
 * at the boundary. Inputs here are small (keys, IVs, the mnemonic blob), so the copy is negligible.
 */
function ab(u: Uint8Array): ArrayBuffer {
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}

/** A sealed at-rest blob, safe to persist in IndexedDB. */
export interface SealedBlob {
  /** Format version, so the wrapping scheme can evolve without ambiguity. */
  readonly v: 1;
  /** base64url of the random 12-byte AES-GCM IV. */
  readonly iv: string;
  /** base64url of the AES-GCM ciphertext (includes the auth tag). */
  readonly ct: string;
}

/** HKDF-SHA256 expand to `length` bytes (RFC 5869). `info` is raw bytes for full generality. */
export async function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey('raw', ab(ikm), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: ab(salt), info: ab(info) },
    base,
    length * 8,
  );
  return new Uint8Array(bits);
}

/**
 * Derive a 32-byte AES-GCM wrapping key from input key material, domain-separated by `info`.
 * Distinct `info` labels (e.g. at-rest vs a future purpose) yield independent keys from the same
 * IKM, so one purpose's key never doubles as another's.
 */
export function deriveWrappingKey(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: string,
): Promise<Uint8Array> {
  return hkdfSha256(ikm, salt, new TextEncoder().encode(info), 32);
}

/** Seal plaintext under a 32-byte key with a fresh random IV. */
export async function sealBlob(plaintext: Uint8Array, key: Uint8Array): Promise<SealedBlob> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const aesKey = await crypto.subtle.importKey('raw', ab(key), 'AES-GCM', false, ['encrypt']);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ab(iv) }, aesKey, ab(plaintext));
  return { v: 1, iv: base64urlEncode(iv), ct: base64urlEncode(new Uint8Array(ct)) };
}

/**
 * Open a sealed blob with a 32-byte key. REJECTS (does not return garbage) if the key is wrong or
 * the ciphertext/IV was tampered with — AES-GCM's authentication tag is what guarantees this.
 */
export async function openBlob(sealed: SealedBlob, key: Uint8Array): Promise<Uint8Array> {
  const iv = base64urlDecode(sealed.iv);
  const ct = base64urlDecode(sealed.ct);
  const aesKey = await crypto.subtle.importKey('raw', ab(key), 'AES-GCM', false, ['decrypt']);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ab(iv) }, aesKey, ab(ct));
  return new Uint8Array(pt);
}
