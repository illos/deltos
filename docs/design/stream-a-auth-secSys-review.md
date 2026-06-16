# Stream A auth — secSys early-read review

**Reviewer:** secSys · **Target:** `docs/design/stream-a-auth-strawman.md` @ 678eac4 (STRAWMAN, nothing locked)
**Verdict:** Strong construction — the replay / freshness / pubkey-binding / intent / downgrade
spine is mostly right and devSys clearly internalized the audit checklist. **One CRITICAL must-fix
(F2) that, if missed, is a full account takeover**, plus a set of must-enforce-before-lock items.
None of these block the *approach*; they harden it. Take F2, F4, F5, F6 as lock-blockers.

---

## Part A — Rulings on the 5 asks

### Ask 1 — the §0 correction (passkey is local-unlock-only; server union = grant-token / capability / unverified)
**AGREE.** PIN-ID-4 is explicit: the passkey gates the on-device unlock of the at-rest Identity
blob; the SLIP-21 **signing key** is what proves account possession to the server. So the server
never sees a passkey assertion for request auth, and the signed-challenge is correctly the INPUT to
the mint endpoint (validated there), not a per-request can() method. The server-side union
grant-token / capability / unverified is the right shape.

**But yes, add a step-up path (this is also my Ask-2 answer).** Do NOT make every request carry a
fresh signature — that is the bearer-token model and it is fine for normal CRUD. DO require a
per-request signed intent (op + resource + fresh challenge, signed with the signing key) for a small
enumerated set of **sensitive ops**: device add/revoke, change recovery phrase, delete account,
export-all / bulk-read, create or widen a share/capability grant. For those, bearer-token-theft is
catastrophic and a re-auth is cheap. Concretely either a 4th union member
`method:'signed-request'` reserved for step-up, or a dedicated re-auth challenge gating those routes.
Everything else = grant-token.

### Ask 2 — canonical payload + is scope-at-mint sufficient?
The payload binds replay (nonce + single-use), freshness (TTL + server store), keyId, scope, purpose
— a solid construction. Scope-at-mint is sufficient **for normal CRUD** provided F5 (clamp) holds,
**plus** the sensitive-op step-up from Ask 1. Two hardening items on the payload itself: F4
(canonicalization — the raw `||` concat is exploitable) and F8 (audience binding). See Part B.

### Ask 3 — Ed25519 vs P-256
**Ed25519.** Reasons: (a) deterministic derivation is trivial — any 32 bytes is a valid private key,
so the SLIP-21 sibling output IS the key with no scalar-in-range rejection sampling or modular-bias
handling that P-256 forces; (b) misuse-resistant — deterministic nonces, no catastrophic ECDSA
nonce-reuse key-leak failure mode; (c) one signature scheme, fewer footguns. **VERIFY before lock
(F12):** WebCrypto Ed25519 on the iOS-18 floor (Safari added it ~iOS 17, so fine) AND in the Workers
runtime for verify (supported, but confirm in the actual deploy target). If a target ever lacks it,
fall back to P-256 ECDSA with RFC-6979-style deterministic derivation — but prefer Ed25519.

### Ask 4 — challenge store: D1 atomic-consume vs Durable Object
**D1 is sufficient for v1.** Single-use is guaranteed because BOTH the mint (INSERT) and the consume
(conditional DELETE/UPDATE … WHERE consumed=0) are WRITES that go to the D1 primary and are
linearized there; check rows-affected=1, same CAS discipline as PIN-SYNC-1. **Hard rule: single-use
is enforced by the rows-affected of the atomic conditional write — NEVER by a prior SELECT of the
consumed flag** (a stale read on a replica would reopen a replay window). Add a TTL/expiry index and
a sweep to GC expired challenges, and check expiry against the STORED expiresAt vs server-now (never
a client value). A Durable Object buys you a single-threaded serialization point and is the natural
home if you later want per-account challenge rate-limiting or global ordering — not needed for v1.

### Ask 5 — domain-separation weakness in the SLIP-21 hierarchy
**The derivation itself is sound** — siblings-not-children, distinct first labels, v1 versioning,
real BIP39 PBKDF2 hardening on the seed, standard SLIP-21 master ("Symmetric key seed"). No
weakness in §1's tree. The real weaknesses are NOT in the derivation but in enforcement and model:
F1 (shared-key revocation semantics) and F2 (the fingerprint↔key binding must be server-enforced,
not just derived). Micro-note: derive each label via the standard SLIP-21 per-label HMAC chaining,
not a joined string, so ["deltos","at-rest-key","v1"] can never canonicalize-collide with a
differently-split path.

---

## Part B — Findings beyond the asks (severity-tagged)

### F2 — CRITICAL / LOCK-BLOCKER — fingerprint↔key binding must be ENFORCED server-side at registration
§1 derives `Identity.id = accountFingerprint = base64url(SHA-256(signingPublicKey))`, and §3 leans on
that binding ("an attacker signing with their own key for someone else's keyId fails verification").
That guarantee holds for the mint flow ONLY IF the server verifies, at registration, that the
submitted accountFingerprint actually equals base64url(SHA-256(submitted signingPublicKey)). If it
does not, here is a full account takeover:
1. attacker learns victim's accountFingerprint Fv (it is pseudonymous / possibly discoverable);
2. attacker registers {keyId: Ke, signingPublicKey: PKe (their OWN), accountFingerprint: Fv};
3. attacker runs challenge→session for Ke, signs with their OWN private key;
4. server resolves PKe for Ke, verification PASSES, mints a token for principal {owner, id: Fv} →
   the attacker is now acting as the victim.
**Fix:** the registration endpoint MUST reject any request where accountFingerprint !=
base64url(SHA-256(signingPublicKey)). With that check the attacker can only ever register under their
OWN fingerprint. This single check is what makes the whole pubkey↔account binding real — state it
explicitly in the contract and test it.

### F1 — HIGH / DESIGN DECISION — shared deterministic signing key ⇒ "device revocation" ≠ key revocation
Because the signing key is a deterministic SLIP-21 derivation of the mnemonic, EVERY device that has
the mnemonic holds the SAME signing keypair (this is what makes Identity.id stable — intended). The
consequence for PIN-ID-5: revoking a device row / its grant token does NOT lock out an attacker who
extracted the mnemonic — they just run enrollExisting and mint a fresh device row + token. So
"device revocation" here means "revoke a cached grant token / registry handle," NOT cryptographic
device lockout. For a private notes app whose primary threat is a lost/stolen/compromised device,
that distinction matters. Options: (a) accept it for v1 and DOCUMENT precisely what revocation does
and does not do (recovery from mnemonic compromise = rotate the mnemonic, i.e. re-key the account);
(b) the stronger model — each device generates its OWN non-extractable per-device signing keypair
(WebCrypto, non-extractable), authorized under the account by a signature from the mnemonic-derived
account key at enrollment; per-request/session auth uses the per-device key; revoking a device =
de-authorizing its pubkey = real cryptographic revocation, and the per-device private key cannot be
copied to another device even with the mnemonic. (b) is more moving parts and complicates recovery
(account key must authorize new device keys) but gives revocation real teeth and bounds the blast
radius of one compromised device. Not a v1 blocker, but it is expensive to change after the contract
locks — make the call deliberately now, with the limitation written down either way.

### F4 — MED / LOCK-BLOCKER — canonical payload needs unambiguous canonicalization, not raw `||`
`deltos-auth-v1 || purpose || challengeId || nonce || keyId || requestedScope` as a raw
concatenation is a classic signing pitfall: if any variable-length field (requestedScope especially,
and deviceLabel if ever added) can contain the delimiter or be shifted, an attacker can move bytes
across field boundaries and produce a different logical message with the same byte string. Fix: use
an unambiguous encoding — length-prefix each field, or hash each field and sign the concatenation of
fixed-length digests, or sign a canonical structured encoding. Make the framing impossible to
ambiguate regardless of field contents.

### F5 — MED / LOCK-BLOCKER — mint must CLAMP requestedScope to the account/device entitlement
requestedScope is a client request, not an authorization. The /auth/session mint must grant
scope = intersection(requestedScope, what this principal is actually entitled to), never
requestedScope verbatim — otherwise a device signs for requestedScope=['*'] and gets it. State the
upper bound (a device principal under its own account presumably gets full account scope; a
capability/share gets exactly the granted scope) and clamp to it.

### F6 — MED / LOCK-BLOCKER — store the token HASH at rest, never the raw token
§3 mints "an opaque grant token (random 32B, stored in the grants registry)." Store SHA-256(token)
(the token is high-entropy so a plain hash is fine, no per-row salt needed) and look up / compare by
hashing the presented token. A registry/D1 read or backup must not yield usable bearer tokens —
same discipline as not storing raw passwords. Same applies to capability tokens.

### F7 — MED — isolate the device grant-token from the plugin execution context
deltos has a first-class plugin surface. A bearer grant-token in localStorage / IndexedDB is
reachable by any in-page script, including a malicious or compromised plugin → token theft → full
scope. Keep the device grant-token in memory only (not localStorage), and ensure plugins
authenticate with their OWN narrow capability grants (method:'capability'), never the device token.
The union having both grant-token and capability is exactly right for this — just make the isolation
explicit so a plugin can never read the device token.

### F8 — MED — bind an audience / RP-origin into the signed payload
Add the expected deployment origin / RP-ID to the canonical payload so a signature minted for one
deltos deployment cannot be replayed against another (cross-deployment replay), mirroring the
WebAuthn RP-ID discipline already in §6. Cheap insurance; "deltos-auth-v1" is a version tag, not an
audience.

### F9 — MED — step-up signed intent for sensitive ops (this is the Ask-1 "signed-request" answer)
Enumerate the sensitive set (device add/revoke, change recovery, delete account, export-all/bulk-read,
create/widen share or capability grant) and require a fresh per-request signed intent (op + resource
+ fresh challenge, signing key) for those, regardless of the bearer token's scope. Normal CRUD stays
on the bearer token. This bounds the damage of a stolen token to non-account-level actions.

### F10 — LOW — can() switch: exhaustive + default-deny
Build can()'s per-method switch with an assertNever(method) in the default branch (compile-time
exhaustiveness so a future union member cannot be added without handling it) AND a runtime
default-DENY in that same branch (belt-and-suspenders if an unexpected value ever reaches it).

### F11 — LOW — consume-before-verify ordering is correct; note the minor griefing
Consuming the challenge (step 2) before verifying the signature (step 4) is the right call for replay
safety (a valid signature still can't be replayed because the challenge is already gone, and there is
no verify-then-consume TOCTOU). The only side effect: a request with a valid challengeId but bad
signature burns that challenge, forcing a re-fetch. That requires knowing the challengeId, which is
TLS-protected, random, and 60s-lived — acceptable. Keep the ordering; just be aware.

### F12 — LOW / VERIFY — confirm Ed25519 WebCrypto availability in BOTH targets before locking (see Ask 3).

### F13 — LOW — tripwire env allowlist (§5)
Inversion to fail-closed is exactly the P0 carry-forward — good. Make the non-prod allowlist a
closed, exact-match set {development, test, local} (no substring / prefix matching). One operational
note: a 'development' instance on this box is exposed on the tailnet, so dev = unverified = no auth
reachable by anyone on the tailnet — fine for throwaway data, but keep dev instances off real/prod
data.

---

## Part C — Endorsed as correct (don't change)
- Opaque, registry-RESOLVED grant token over a self-validating JWT — this is the RIGHT choice
  precisely because it gives INSTANT revocation (every request resolves the row; revoke = immediate
  deny, no token-validity window to wait out). A long-lived token (PIN-ID-2) is acceptable under this
  model *because* revocation is immediate — pair it with F9 step-up and F6 at-rest hashing.
- Atomic single-use challenge consume via rows-affected (same CAS discipline as PIN-SYNC-1).
- discriminatedUnion with NO .passthrough(), method set server-side from what was actually verified,
  client cannot select unverified — closes the P0 banked obligation structurally.
- The SLIP-21 sibling hierarchy and Ed25519-as-32-byte-sibling derivation.
- S1 / iOS-WebAuthn rules (§6) and the QR out-of-band confirmation requirement (§7).

## Lock checklist (what I want to see before the union + can() switch lock)
1. F2 fingerprint==hash(pubkey) server-enforced at registration (+ test).
2. F4 unambiguous payload canonicalization.
3. F5 requestedScope clamped to entitlement.
4. F6 token stored hashed at rest.
5. A decision recorded on F1 (shared-key revocation: accept+document, or go per-device-key).
6. F9 sensitive-op step-up set enumerated (+ whether it adds a signed-request union member).
7. F7 plugin/token isolation stated; F8 audience binding added; F10 exhaustive+deny; F12 verified.
