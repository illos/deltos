/**
 * Concrete WebAuthn KeyStore provider.
 *
 * Implements the pinned KeyStore interface using a discoverable-credential passkey
 * (residentKey: required, UV: required) to gate access to an AES-GCM-256 sealed
 * identity blob stored in IndexedDB.
 *
 * Wrapping-key strategy (PIN-ID-6):
 *   PRF available  → wrappingKey = HKDF(prf_output, credId_bytes, 'deltos-at-rest-v1')
 *   PRF absent     → wrappingKey = random 32-byte key stored device-locally in IndexedDB
 *                    (security = same-origin + UV ceremony; secSys RULED acceptable as PIN-ID-6
 *                    baseline on two conditions: (i) surface the plaintext-key-in-IDB limitation in
 *                    the UI (D5-style disclosure when PRF is unavailable), (ii) code is PRF-first so
 *                    the no-PRF path is a degraded fallback, not the default.)
 *
 * WebAuthn-first-await (PIN-ID-9):
 *   enrollNew / enrollExisting: generateMnemonic() is sync; WebAuthn create() is the FIRST await.
 *   unlock: WebAuthn get() is the FIRST await (discoverable-credential flow, no pre-read of credId).
 *
 * The WebAuthnBackend seam (injectable) keeps the browser API out of unit tests.
 */

import * as ed from '@noble/ed25519';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import Dexie, { type EntityTable } from 'dexie';

import { base64urlEncode, base64urlDecode } from '@deltos/shared';
import { generateMnemonic, deriveKeyHierarchy } from './keyDerivation.js';
import { sealBlob, openBlob, deriveWrappingKey } from './blob.js';
import { OPTION_A_DEVICE_LOCAL } from './custodyPolicy.js';
import type { Identity, KeyStore } from './keyStore.js';
import type { SealedBlob } from './blob.js';

// Wire SHA-512 for @noble/ed25519 v3 (belt-and-suspenders alongside keyDerivation.ts).
if (!ed.hashes.sha512) ed.hashes.sha512 = sha512;

// PRF eval.first input — deterministic 32-byte domain label.
// Must be identical at enrollment and every subsequent unlock so the PRF output matches.
const PRF_EVAL_INPUT: ArrayBuffer = (() => {
  const bytes = sha256(new TextEncoder().encode('deltos-prf-eval-v1'));
  const buf = new ArrayBuffer(32);
  new Uint8Array(buf).set(bytes);
  return buf;
})();

// ── Storage schema ──────────────────────────────────────────────────────────────────────────────

interface IdentityBlobRow {
  key: 'v1';                // singleton — one enrolled identity per device
  sealed: SealedBlob;
  credentialId: string;     // base64url of rawId returned by WebAuthn
  prf: boolean;             // true → wrapping key is HKDF(prf_output); false → device key in table below
}

interface DeviceKeyRow {
  key: 'v1';
  wrappingKey: string;      // base64url of 32 random bytes (no-PRF fallback only)
}

// The server-issued device handle (keyId from POST /api/auth/register). A NON-SECRET opaque
// handle — NOT a bearer token, NOT key material — persisted here so cold-start session re-mint
// survives a reload as durably as the sealed blob (localStorage is far more eviction-prone on iOS).
// Co-located with the credential in this same IndexedDB; cleared whenever a new credential is sealed.
interface ServerHandleRow {
  key: 'v1';
  keyId: string;
}

class IdentityDB extends Dexie {
  blob!: EntityTable<IdentityBlobRow, 'key'>;
  deviceKey!: EntityTable<DeviceKeyRow, 'key'>;
  serverHandle!: EntityTable<ServerHandleRow, 'key'>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({ blob: 'key', deviceKey: 'key' });
    // v2 adds serverHandle (durable keyId). Additive store; Dexie upgrades existing DBs in place,
    // leaving the blob + deviceKey rows untouched.
    this.version(2).stores({ blob: 'key', deviceKey: 'key', serverHandle: 'key' });
  }
}

// ── Blob payload (serialised inside the sealed blob) ────────────────────────────────────────────

interface BlobPayload {
  id: string;   // Identity.id
  sk: string;   // base64url of Ed25519 private seed (32 bytes)
  pk: string;   // base64url of Ed25519 public key (32 bytes)
}

// ── WebAuthn backend seam ───────────────────────────────────────────────────────────────────────

export interface WebAuthnBackend {
  create(options: CredentialCreationOptions): Promise<Credential | null>;
  get(options: CredentialRequestOptions): Promise<Credential | null>;
}

// Narrow view of PublicKeyCredential extension results for PRF
type PrfExtension = { prf?: { results?: { first?: ArrayBuffer } } };

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────────

function extractPrf(cred: PublicKeyCredential): ArrayBuffer | null {
  const ext = cred.getClientExtensionResults() as PrfExtension;
  return ext?.prf?.results?.first ?? null;
}

function makeCreateOptions(rpId: string): CredentialCreationOptions {
  return {
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { id: rpId, name: 'deltos' },
      user: {
        id: crypto.getRandomValues(new Uint8Array(16)),
        name: 'deltos-account',
        displayName: 'deltos account',
      },
      pubKeyCredParams: [
        { alg: -7, type: 'public-key' },  // ES256 (P-256) — broadest authenticator support
        { alg: -8, type: 'public-key' },  // EdDSA — newer authenticators
      ],
      authenticatorSelection: {
        residentKey: 'required',
        requireResidentKey: true,
        userVerification: 'required',
      },
      extensions: { prf: { eval: { first: PRF_EVAL_INPUT } } } as AuthenticationExtensionsClientInputs,
    },
  };
}

function makeGetOptions(rpId: string): CredentialRequestOptions {
  return {
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rpId,
      userVerification: 'required',
      extensions: { prf: { eval: { first: PRF_EVAL_INPUT } } } as AuthenticationExtensionsClientInputs,
      // No allowCredentials — discoverable-credential (passkey) flow keeps WebAuthn as first await
      // without a pre-read of the stored credential ID from IndexedDB.
    },
  };
}

async function computeWrappingKey(
  prfOutput: ArrayBuffer | null,
  credIdBytes: Uint8Array,
  deviceLocalForAll: boolean,
): Promise<{ wrappingKey: Uint8Array; usedPrf: boolean }> {
  // Option-A (v1, user-affirmed): device-local-for-ALL. New enrollments ALWAYS seal under a random
  // device-local key so the blob can be unwrapped silently (no gesture) on cold start — the north
  // star (no day-to-day friction). The PRF branch below is kept DORMANT behind the flag
  // (secSys #6): `deviceLocalForAll = false` re-enables PRF-first wrapping (v2 E2EE / tests).
  if (!deviceLocalForAll && prfOutput && prfOutput.byteLength > 0) {
    const wk = await deriveWrappingKey(
      new Uint8Array(prfOutput),
      credIdBytes,                   // per-credential salt
      'deltos-at-rest-v1',
    );
    return { wrappingKey: wk, usedPrf: true };
  }
  // Device-local key (caller persists it). Under Option-A this is the only enrollment path.
  return { wrappingKey: crypto.getRandomValues(new Uint8Array(32)), usedPrf: false };
}

async function recoverWrappingKey(
  prfOutput: ArrayBuffer | null,
  credIdBytes: Uint8Array,
  blobRow: IdentityBlobRow,
  db: IdentityDB,
): Promise<Uint8Array | null> {
  if (blobRow.prf) {
    if (!prfOutput || prfOutput.byteLength === 0) return null;
    return deriveWrappingKey(new Uint8Array(prfOutput), credIdBytes, 'deltos-at-rest-v1');
  }
  const row = await db.deviceKey.get('v1');
  return row ? base64urlDecode(row.wrappingKey) : null;
}

async function sealAndPersist(
  payload: BlobPayload,
  wrappingKey: Uint8Array,
  credentialId: string,
  usedPrf: boolean,
  db: IdentityDB,
): Promise<void> {
  const sealed = await sealBlob(
    new TextEncoder().encode(JSON.stringify(payload)),
    wrappingKey,
  );
  await db.blob.put({ key: 'v1', sealed, credentialId, prf: usedPrf });
  if (usedPrf) {
    await db.deviceKey.delete('v1');
  } else {
    await db.deviceKey.put({ key: 'v1', wrappingKey: base64urlEncode(wrappingKey) });
  }
  // A newly-sealed credential invalidates any prior server registration — clear the stale device
  // handle so a recovery/re-bind never reuses a keyId that belonged to a different identity. The
  // subsequent register() sets the fresh keyId via setServerKeyId.
  await db.serverHandle.delete('v1');
}

/**
 * Option-A migration (rewrap-on-next-unlock): convert a PRF-wrapped blob to device-local custody,
 * IN MEMORY, riding the unlock gesture the user is already performing. Re-seals the SAME already-
 * decrypted plaintext under a fresh random device-local key and writes the new sealed blob + the
 * device key in a SINGLE Dexie transaction over [blob, deviceKey] — so a crash leaves the original
 * PRF blob fully intact (fail-safe, never fail-open) and a concurrent (multi-tab) rewrap resolves to
 * a consistent {blob, deviceKey} pair (last-writer-wins). Replaces the 'v1' row (no lingering PRF
 * ciphertext) and flips `prf → false` so the disclosure honestly shows the device-local variant.
 * serverHandle/keyId untouched; the bare signing key is NEVER serialized — only the AES-GCM-sealed
 * blob + the random wrapping key reach IndexedDB.
 */
async function rewrapDeviceLocal(
  plaintext: Uint8Array,
  credentialId: string,
  db: IdentityDB,
): Promise<void> {
  const newKey = crypto.getRandomValues(new Uint8Array(32));
  const sealed = await sealBlob(plaintext, newKey); // reseal the SAME payload bytes (byte-identical)
  await db.transaction('rw', db.blob, db.deviceKey, async () => {
    await db.blob.put({ key: 'v1', sealed, credentialId, prf: false }); // replace 'v1', prf→false
    await db.deviceKey.put({ key: 'v1', wrappingKey: base64urlEncode(newKey) });
  });
}

// ── Enrollment info (for D5 UI disclosure) ──────────────────────────────────────────────────────

/**
 * Read the PRF binding status of the current enrollment (if any).
 * Returns null if the device is not enrolled.
 *
 * D5 DISCLOSURE OBLIGATION (planSys done-gate, secSys ruling on PIN-ID-6):
 *   The UI MUST call this after enrollNew/enrollExisting and, when `usesPrf === false`,
 *   render an honest disclosure explaining that the wrapping key is stored plaintext in
 *   IndexedDB — a local storage-read attacker can recover it. This disclosure is a hard
 *   ACCEPTANCE CONDITION for Phase-1; omitting it voids secSys's clearance of the no-PRF path.
 *
 * @param dbName — must match the dbName passed to createWebAuthnKeyStore (default: 'deltos-identity')
 */
export async function getEnrollmentPrfStatus(dbName?: string): Promise<{ usesPrf: boolean } | null> {
  const db = new IdentityDB(dbName ?? 'deltos-identity');
  const row = await db.blob.get('v1');
  return row ? { usesPrf: row.prf } : null;
}

// ── Factory ─────────────────────────────────────────────────────────────────────────────────────

export function createWebAuthnKeyStore(opts?: {
  backend?: WebAuthnBackend;
  dbName?: string;
  /** Option-A device-local-for-all wrapping. Defaults to the v1 build constant; tests flip it to
   *  false to exercise the DORMANT PRF custody path (secSys #6, v2 E2EE). */
  optionADeviceLocal?: boolean;
}): KeyStore {
  const backend: WebAuthnBackend = opts?.backend ?? navigator.credentials;
  const db = new IdentityDB(opts?.dbName ?? 'deltos-identity');
  const rpId = typeof location !== 'undefined' ? location.hostname : 'localhost';
  const deviceLocalForAll = opts?.optionADeviceLocal ?? OPTION_A_DEVICE_LOCAL;

  // In-memory key state. Null = locked. Zeroed and nulled by lock().
  let _state: {
    identity: Identity;
    privateKey: Uint8Array;
    publicKey: Uint8Array;
  } | null = null;

  return {
    async isEnrolled(): Promise<boolean> {
      return (await db.blob.get('v1')) != null;
    },

    async enrollNew(): Promise<{ identity: Identity; mnemonic: string }> {
      // Sync prep before FIRST await — mnemonic is generated before the WebAuthn ceremony
      // so no randomness is needed after the browser's transient activation is spent.
      const mnemonic = generateMnemonic();

      // FIRST AWAIT: WebAuthn passkey creation (PIN-ID-9)
      const cred = (await backend.create(makeCreateOptions(rpId))) as PublicKeyCredential | null;
      if (!cred) throw new Error('WebAuthn ceremony cancelled or returned no credential');

      // Guard: reject if already enrolled (PIN-ID-8). Checked post-WebAuthn (DB read after gesture)
      // because the isEnrolled() check must not be the first await (PIN-ID-9).
      if (await db.blob.get('v1')) {
        throw new Error('Already enrolled — use enrollExisting() to re-bind on this device');
      }

      // Key derivation (PBKDF2 / SLIP-21) runs AFTER WebAuthn — transient activation already spent.
      const hierarchy = await deriveKeyHierarchy(mnemonic);
      const credIdBytes = new Uint8Array(cred.rawId);
      const credentialId = base64urlEncode(credIdBytes);
      const { wrappingKey, usedPrf } = await computeWrappingKey(extractPrf(cred), credIdBytes, deviceLocalForAll);

      await sealAndPersist(
        { id: hierarchy.id, sk: base64urlEncode(hierarchy.signing.privateKey), pk: base64urlEncode(hierarchy.signing.publicKey) },
        wrappingKey, credentialId, usedPrf, db,
      );

      const identity: Identity = { id: hierarchy.id };
      _state = { identity, privateKey: hierarchy.signing.privateKey, publicKey: hierarchy.signing.publicKey };
      return { identity, mnemonic };
    },

    async enrollExisting(mnemonic: string): Promise<Identity> {
      // FIRST AWAIT: WebAuthn passkey creation (PIN-ID-9). Overwrites any existing blob.
      const cred = (await backend.create(makeCreateOptions(rpId))) as PublicKeyCredential | null;
      if (!cred) throw new Error('WebAuthn ceremony cancelled or returned no credential');

      const hierarchy = await deriveKeyHierarchy(mnemonic);
      const credIdBytes = new Uint8Array(cred.rawId);
      const credentialId = base64urlEncode(credIdBytes);
      const { wrappingKey, usedPrf } = await computeWrappingKey(extractPrf(cred), credIdBytes, deviceLocalForAll);

      await sealAndPersist(
        { id: hierarchy.id, sk: base64urlEncode(hierarchy.signing.privateKey), pk: base64urlEncode(hierarchy.signing.publicKey) },
        wrappingKey, credentialId, usedPrf, db,
      );

      const identity: Identity = { id: hierarchy.id };
      _state = { identity, privateKey: hierarchy.signing.privateKey, publicKey: hierarchy.signing.publicKey };
      return identity;
    },

    async unlock(): Promise<Identity | null> {
      // FIRST AWAIT: WebAuthn get() — discoverable credential flow, no pre-read of credId (PIN-ID-9).
      const cred = (await backend.get(makeGetOptions(rpId))) as PublicKeyCredential | null;
      if (!cred) return null;

      const credentialId = base64urlEncode(new Uint8Array(cred.rawId));
      const blobRow = await db.blob.get('v1');
      if (!blobRow || blobRow.credentialId !== credentialId) return null;

      const credIdBytes = base64urlDecode(blobRow.credentialId);
      const wrappingKey = await recoverWrappingKey(extractPrf(cred), credIdBytes, blobRow, db);
      if (!wrappingKey) return null;

      let plaintext: Uint8Array;
      try {
        plaintext = await openBlob(blobRow.sealed, wrappingKey);
      } catch {
        return null; // wrong key or tampered blob — return null, do not propagate
      }

      const payload: BlobPayload = JSON.parse(new TextDecoder().decode(plaintext)) as BlobPayload;
      const privateKey = base64urlDecode(payload.sk);
      const publicKey = base64urlDecode(payload.pk);
      const identity: Identity = { id: payload.id };
      _state = { identity, privateKey, publicKey };

      // Option-A migration: an already-PRF-enrolled device silently converts to device-local custody
      // on this unlock (one-time, idempotent), so subsequent cold starts auto-unlock with no gesture.
      // Best-effort + atomic — a failure leaves the PRF blob intact and the device migrates on the
      // next unlock (fail-safe). Runs AFTER _state is set, so the unlock itself never fails on it.
      if (deviceLocalForAll && blobRow.prf) {
        try {
          await rewrapDeviceLocal(plaintext, blobRow.credentialId, db);
        } catch {
          /* leave the original PRF blob intact; retry on the next unlock */
        }
      }

      return identity;
    },

    async autoUnlock(): Promise<Identity | null> {
      // SILENT unwrap — NO WebAuthn, background only (establishSession calls it AFTER first paint,
      // never on the render path). Works only for device-local blobs; a PRF blob returns null so the
      // caller falls back to the gesture nudge (which then migrates it via unlock()). Fail-CLOSED.
      const blobRow = await db.blob.get('v1');
      if (!blobRow) return null;
      if (blobRow.prf) return null; // no at-rest key for a PRF blob — cannot silently unwrap
      const credIdBytes = base64urlDecode(blobRow.credentialId);
      const wrappingKey = await recoverWrappingKey(null, credIdBytes, blobRow, db);
      if (!wrappingKey) return null;

      let plaintext: Uint8Array;
      try {
        plaintext = await openBlob(blobRow.sealed, wrappingKey);
      } catch {
        return null; // wrong key or tampered blob
      }

      const payload: BlobPayload = JSON.parse(new TextDecoder().decode(plaintext)) as BlobPayload;
      const identity: Identity = { id: payload.id };
      _state = { identity, privateKey: base64urlDecode(payload.sk), publicKey: base64urlDecode(payload.pk) };
      return identity;
    },

    lock(): void {
      if (_state) {
        _state.privateKey.fill(0); // zero out private key material before releasing
        _state = null;
      }
    },

    isUnlocked(): boolean {
      return _state !== null;
    },

    currentIdentity(): Identity | null {
      return _state?.identity ?? null;
    },

    sign(challenge: Uint8Array): Promise<Uint8Array> {
      if (!_state) return Promise.reject(new Error('KeyStore is locked — call unlock() first'));
      return Promise.resolve(ed.sign(challenge, _state.privateKey));
    },

    getSigningPublicKey(): Uint8Array {
      if (!_state) throw new Error('KeyStore is locked — call unlock() first');
      return _state.publicKey;
    },

    async setServerKeyId(keyId: string): Promise<void> {
      // Durable, non-secret server device handle. NEVER store the bearer token here (F7 stays
      // in-memory only) — only the opaque keyId, which carries no authority on its own.
      await db.serverHandle.put({ key: 'v1', keyId });
    },

    async getServerKeyId(): Promise<string | null> {
      const row = await db.serverHandle.get('v1');
      return row?.keyId ?? null;
    },
  };
}
