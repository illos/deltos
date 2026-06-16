/**
 * The identity custody boundary — the interface contract the UI (gruntSys2) builds against and
 * the real implementation (devSys) fills in. Pinned EARLY so the enroll / recovery / unlock /
 * device-management screens have a stable seam while the crypto lands behind it.
 *
 * ── Custody rule ────────────────────────────────────────────────────────────────────────────
 * ALL key material lives inside the KeyStore. The app layer only ever holds an {@link Identity}
 * (the public pseudonym). Mnemonic, seed, signing private key, at-rest key, and any WebAuthn
 * PRF output never cross this boundary — which is why the KeyStore, not the UI, owns the WebAuthn
 * ceremony (see below). `enrollNew` is the one method that returns the mnemonic, because the user
 * must write it down once; after that it is never handed out again.
 *
 * ── WebAuthn ownership (answer to gruntSys2 Q1) ─────────────────────────────────────────────
 * The KeyStore owns `navigator.credentials.create()` / `.get()`. `enrollNew()` and `unlock()`
 * each call WebAuthn as their FIRST await (PIN-ID-9: WebAuthn must be the first await after the
 * user gesture, for iOS transient activation). Any synchronous prep (e.g. generating the
 * mnemonic) happens before that await; the expensive PBKDF2/derivation runs AFTER the WebAuthn
 * call, where transient activation no longer matters.
 *
 * THE UI'S OBLIGATION: call `enrollNew()` / `unlock()` directly and synchronously from the user
 * gesture handler — do NOT `await` anything (fetch, IndexedDB, etc.) before that call, or the
 * gesture's transient activation is spent and iOS rejects the WebAuthn ceremony. `isEnrolled()`
 * is a plain IndexedDB read and may be called outside a gesture (e.g. at boot, to choose the
 * enroll-vs-unlock screen). RP ID = hostname (served over Tailscale HTTPS by hostname, never IP),
 * and must match across Safari ↔ installed PWA.
 *
 * ── PRF (PIN-ID-6) ──────────────────────────────────────────────────────────────────────────
 * PRF (deriving the blob-wrapping key from the credential) is used WHERE AVAILABLE; the baseline
 * is UV-only + an encrypted-IndexedDB blob. The KeyStore decides internally; the UI never sees it.
 */

/**
 * The app-layer view of an account: a server-safe pseudonym and nothing else. `id` =
 * base64url(SHA-256(signing public key)) — identical to the server's `accountFingerprint` (F2).
 * It is an IDENTIFIER, never an authenticator (PIN-ID-1): possessing an `id` authorizes nothing.
 */
export interface Identity {
  readonly id: string;
}

/**
 * The custody boundary. Implemented over WebAuthn (local unlock) + an encrypted IndexedDB blob
 * holding the derived key hierarchy; the signing key authenticates to the server (PIN-ID-4 keeps
 * those two roles distinct — passkey unlocks the blob, the signing key proves identity).
 */
export interface KeyStore {
  /** Has an encrypted Identity blob ever been stored on this device? Safe to call outside a gesture. */
  isEnrolled(): Promise<boolean>;

  /**
   * Provision a BRAND-NEW account: generate a 24-word mnemonic, derive the hierarchy, bind it to
   * a fresh passkey, and persist the encrypted blob. Returns the mnemonic ONCE for the user to
   * record. REJECTS if the device is already enrolled (PIN-ID-8 footgun guard) — recovery goes
   * through {@link enrollExisting}. WebAuthn create() is the first await; call from a gesture.
   */
  enrollNew(): Promise<{ identity: Identity; mnemonic: string }>;

  /**
   * Recover / QR-join: re-derive the hierarchy from an EXISTING mnemonic and (re)store the
   * encrypted blob under a passkey on this device. Overwrites any local blob, so the UI must
   * gate this behind explicit intent (PIN-ID-8). Same WebAuthn-first-await rule.
   */
  enrollExisting(mnemonic: string): Promise<Identity>;

  /**
   * Unlock the at-rest blob via WebAuthn (the `get()` IS the first await). Returns the unlocked
   * {@link Identity}, or `null` if no enrolled credential matched (caller shows enroll/retry).
   * Call from a gesture.
   */
  unlock(): Promise<Identity | null>;

  /** Drop in-memory key material. The encrypted IndexedDB blob is untouched (re-unlock with WebAuthn). */
  lock(): void;

  /** Is the store currently unlocked (key material in memory)? Sync — for render decisions. */
  isUnlocked(): boolean;

  /** The unlocked identity, or null if locked. Sync accessor for render after unlock. */
  currentIdentity(): Identity | null;

  /**
   * Ed25519-sign the given bytes with the account signing key. The CALLER (the auth client)
   * constructs the canonical signed payload — the length-prefixed TLV, F4 — and passes those
   * bytes; the KeyStore is a pure signer over them. REJECTS if locked.
   */
  sign(challenge: Uint8Array): Promise<Uint8Array>;

  /** The signing public key, for initial server device registration. THROWS if locked. */
  getSigningPublicKey(): Uint8Array;
}

/** Thrown by every method of the stub until the real KeyStore lands. */
export class NotImplementedError extends Error {
  constructor(method: string) {
    super(`KeyStore.${method} is not implemented yet (stub) — devSys is building it.`);
    this.name = 'NotImplementedError';
  }
}

/**
 * A KeyStore that rejects/throws on every call, so the UI can be wired to the real interface and
 * developed against it before the crypto implementation exists. Swap for the real KeyStore when
 * it lands — no UI change, same interface.
 */
export function createStubKeyStore(): KeyStore {
  const reject = (m: string) => Promise.reject(new NotImplementedError(m));
  return {
    isEnrolled: () => reject('isEnrolled'),
    enrollNew: () => reject('enrollNew'),
    enrollExisting: () => reject('enrollExisting'),
    unlock: () => reject('unlock'),
    lock: () => {
      throw new NotImplementedError('lock');
    },
    isUnlocked: () => false,
    currentIdentity: () => null,
    sign: () => reject('sign'),
    getSigningPublicKey: () => {
      throw new NotImplementedError('getSigningPublicKey');
    },
  };
}
