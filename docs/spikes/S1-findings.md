# S1 — Custody Extractability Findings

**Spike:** Is the passkey + 24-word recovery phrase + QR cross-device join from full-beans cleanly
liftable independent of Evolu's `AppOwner`?

**Verdict: LIFT-WITH-SURGERY.** Not entangled, not a free lift. The seam is narrow and
well-understood — roughly 150–200 lines of Evolu-typed glue sits between custody and the storage
engine. Everything beneath it (BIP39, SLIP-21, WebAuthn ceremony, HKDF, QR transport) is pure
open-spec crypto with no Evolu dep.

---

## 1. What's actually Evolu-coupled vs. pure

### Pure — no Evolu dep, no storage engine assumption

| Piece | What it is | Dep |
|---|---|---|
| 24-word mnemonic | BIP39 spec: 256-bit entropy → wordlist | `@scure/bip39` or any BIP39 lib; `@evolu/common` also exposes this but isn't mandatory |
| SLIP-21 key derivation | HMAC-SHA512 hierarchical derivation from root seed — at-rest key, write key, encryption key as siblings | Spec is open; ~30 lines with WebCrypto |
| HKDF stash key | `HKDF-SHA256(atRestKey, info="…/migration-stash/v1")` — domain-separated from SQLCipher use | Pure WebCrypto |
| AES-GCM encrypted stash | Standard AES-GCM, 12-byte IV prepended | Pure WebCrypto |
| WebAuthn ceremony | `navigator.credentials.create/get` — browser API | Zero deps |
| QR generation | `qrSvg(text)` → SVG via `qrcode-generator` | `qrcode-generator` only |
| QR scanning | `scanQRForMnemonic()` → `getUserMedia` + `jsqr` frame decode | `jsqr` only |

### Evolu-coupled — the surgery sites

| Piece | Why coupled | Surgery required |
|---|---|---|
| `localAuth` (~138 lines, `@evolu/web`) | `localAuth.getOwner()` returns `AppOwner`; `localAuth.createOwner(owner)` stores `AppOwner`. The type is baked in — not a "store anything" wrapper. | Rewrite as `KeyStore` (~same size) that stores your own `Identity` struct |
| `AppOwner` struct `{ id, encryptionKey, writeKey, mnemonic }` | Evolu's identity bundle — all four fields are Evolu-derived and relay-protocol-specific | Define a leaner `Identity` (see §3); encryptionKey + writeKey are Phase 1 dead weight |
| `mnemonicToOwnerSecret(m)` + `createSlip21(secret, path)` | These are in `@evolu/common`, but `@evolu/common` has no DB dep — it's pure crypto utils | Either take `@evolu/common` as a crypto-only dep (clean, no Evolu DB pulled in) or reimplement in ~50 lines using WebCrypto HMAC-SHA512 |
| `restoreAppOwner(mnemonic)` | Re-derives AppOwner from mnemonic; called by `joinWithRecoveryPhrase()` | Replace with your own `identityFromMnemonic(m)` |
| `joinWithRecoveryPhrase()` | Destructive: calls `restoreAppOwner`, wipes the Evolu OPFS DB, reloads | Rewrite: adopt mnemonic → re-derive `Identity` → persist behind passkey → clear prior device state (no Evolu OPFS to wipe on the deltos stack) |
| `location.reload()` as lock primitive | Evolu 7.4.1 has no instance disposal; evicting the key requires a hard reload | Not a constraint for deltos — without Evolu's DB worker, in-memory clear is sufficient |

**Relay / sync protocol** (`createOwnerWebSocketTransport`, `applyProtocolMessageAsRelay`,
the RBSR append-log reconciliation) — entirely separate, not part of custody. Deltos doesn't use
it at all.

---

## 2. The custody ↔ engine seam, described concretely

What actually crosses the seam at `openStore({owner, encryptionKey})` in full-beans:

```
[custody side]                         [storage engine side]
  mnemonic (in memory)
    └─ SLIP-21 → atRestKey   ─────────► used as SQLCipher key for OPFS DB
    └─ AppOwner.encryptionKey ─────────► per-row XChaCha20-Poly1305 (Evolu sync)
    └─ AppOwner.writeKey ──────────────► relay HMAC delete proof
    └─ AppOwner.id ────────────────────► relay routing (pseudonymous)
```

For deltos Phase 1 (server-readable, trkr-derived, no Evolu), **none of this crosses the seam**
because there is no Evolu DB and no Evolu relay. The storage engine only needs to know *who is
making the request* — not the key material itself.

What does cross deltos's seam:

```
[custody side]                         [trkr / D1 / server side]
  Identity.id (stable, pseudonymous) ──► row ownership / grant registry
  (everything else stays client-side)
```

That's it for Phase 1. The key hierarchy is internal to custody — the server sees an opaque
identifier, same as Evolu's relay sees `owner.id`.

**D1 as the DeviceRegistry works.** You don't need OPFS, wa-sqlite, or any Evolu storage
primitive to hold custody state. A D1 table of `(device_id, owner_fingerprint, enrolled_at)` plus
IndexedDB for the encrypted identity blob on the client is sufficient. The `KeyStore` interface
(§3) is the full boundary.

---

## 3. Sizing — Phase 1 identity slice

### Interfaces deltos would define

```typescript
// Everything the rest of the app touches
interface Identity {
  id: string         // stable pseudonym, safe to store server-side (hash of signing key)
  mnemonic: Mnemonic // root, held in memory only while unlocked
  // Phase 2 (E2EE): add encryptionKey derived via SLIP-21
}

// The custody boundary — storage engine calls nothing below this
interface KeyStore {
  enrollNew(): Promise<{ identity: Identity; mnemonic: Mnemonic }>
  enrollExisting(mnemonic: Mnemonic): Promise<Identity>
  unlock(): Promise<Identity | null>
  lock(): void   // clear in-memory state; no reload needed
  isEnrolled(): boolean
}

// Optional — for device-list UI / grant revocation later
interface DeviceRegistry {
  register(identity: Identity, deviceLabel: string): Promise<DeviceId>
  list(ownerFingerprint: string): Promise<Device[]>
  revoke(deviceId: DeviceId): Promise<void>
}
```

### Modules to build

| Module | Scope | Effort | Notes |
|---|---|---|---|
| `KeyDerivation` | `identityFromMnemonic()`, `generateMnemonic()`, SLIP-21 sibling derivation | ~1 day | Either thin wrapper on `@evolu/common` crypto (no DB pulled) or 50-line reimpl with WebCrypto |
| `KeyStore` (WebAuthn custody) | `enrollNew/enrollExisting/unlock/lock` — WebAuthn ceremony + AES-GCM wrap of Identity → IndexedDB | ~3–4 days | The fiddly part: PRF extension availability, fallback to UV-only + encrypted IndexedDB blob, iOS gesture rules |
| QR module | `encodeJoinQR(mnemonic)`, `scanJoinQR()` | ~0.5 day | Logic from full-beans is fine, rewrite the wrapper to deltos types |
| Join flow | `joinWithMnemonic(mnemonic)` — validates, adopts, persists, clears prior device state | ~0.5 day | No Evolu store to wipe; clear is just IndexedDB reset |
| Boot wiring | `KeyStore.unlock()` at boot → hand `Identity` to the app layer | ~0.5 day | |

**Total Phase 1 identity slice: 5–7 days.** This is a rewrite of the same logical shape, not a
port. The ceremony code in particular has to be written fresh since `localAuth` is AppOwner-typed
and can't be unwrapped generically.

---

## 4. E2EE option (b) feasibility

**Conclusion: feasible and attractive given what we found.**

If the key hierarchy is intact (SLIP-21 siblings from root seed), adding encryption-on-trkr-stack
later requires:

1. Add `encryptionKey: CryptoKey` to `Identity` — derived via `SLIP-21(root, [app, "EncKey"])`
2. Encrypt entry content before writing to trkr; decrypt after reading
3. Server still routes by `identity.id` and stores ciphertext — zero-knowledge invariant preserved

The domain separation design from full-beans carries over directly: at-rest key, signing key, and
encryption key are siblings of the root, never children of each other. This is the correct shape.
Collapsing any two re-introduces the domain-separation finding in auth.ts:56-66.

The Evolu relay (DO + RBSR protocol) does **not** need to be lifted for option (b). Deltos's
existing sync mechanism handles transport; custody only adds the encryption layer on top. That
makes option (b) a Phase 2 add-on to the Phase 1 identity build, not a rewrite of it.

---

## 5. Landmines

### Passkey UX on installed iOS PWA
- `relyingPartyID: location.hostname` is correct; IPs are invalid RP IDs — the app must be
  served by hostname (e.g. via Tailscale HTTPS or a custom domain), not by IP.
- iOS 16+ required for passkeys. iOS 17+ for PRF extension (used to derive a wrapping key from
  the credential, avoiding the "store a blob in the credential's PRF output" model).
- **WebAuthn as first `await`** in any flow touching Downloads or modal gestures — iOS Safari
  drops transient activation across earlier awaits and silently fails. The two-click split in
  full-beans's migration is a direct response to this; preserve the shape in any enroll flow.
- Installed PWA vs. browser: passkeys created in Safari are accessible from the installed PWA if
  they share a domain (iCloud Keychain syncs them), but only if the RP ID matches across both
  surfaces. Test this explicitly — it's a common trap.

### QR channel security
- The QR encodes the raw 24-word mnemonic — full account takeover for anyone who photographs
  the screen. This is by design (in-person camera handoff model) but has no expiry, no one-time
  use, and no out-of-band confirmation.
- Acceptable for "join my own second device in private" but a footgun if used over a screen
  share or in a group setting. deltos should make the threat model explicit in the UI and consider
  a confirmation code on the receiving device.

### Recovery phrase entropy
- 24-word BIP39 = 256 bits — solid.
- The SLIP-21 derivation path does **not** add PBKDF2 stretching (unlike BIP32 seed derivation).
  This means the mnemonic is the root directly, with no iteration hardening. Fine for
  a 256-bit input; would be a concern if you ever shortened the phrase.

### `enrollWithMnemonic` vs. `enroll` footgun
- Bare `enroll()` on a device with existing data mints a new owner and silently orphans the
  existing data and any relay backup. This is the single most dangerous footgun in the design.
- deltos needs the same guard: on any device where an `Identity` already exists, `enrollNew()`
  must be gated behind explicit "this is a fresh account" intent — the recovery join path must
  go through `enrollExisting(mnemonic)`.

---

## 6. Summary

| Dimension | Finding |
|---|---|
| Verdict | **Lift-with-surgery** — not entangled, not free |
| Surgery surface | ~150-200 lines: `localAuth` wrapper rewrite + `AppOwner` → `Identity` type |
| Crypto primitives | All pure, well-specified, Evolu-independent |
| Storage engine dependency | Zero — custody ↔ engine seam is only `Identity.id` for Phase 1 |
| D1 + grant registry as backend | Yes, sufficient |
| E2EE option (b) | Feasible; SLIP-21 siblings + Phase 2 encryption layer, no relay lift needed |
| Phase 1 effort | 5–7 days |
| Top landmine | WebAuthn-as-first-await on iOS + `enrollExisting` vs. `enrollNew` guard |
