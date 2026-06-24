# Auth Pivot — Username + Password (+ optional 2FA), Recovery Phrase as Reset

**Status:** SHIPPED — v1 live 2026-06-24. **Supersedes the passkey
auth model** ([[stream-a-identity-plan]], Option-A custody, PRF, QR-join). Authoritative design detail lives
in **`docs/design/auth-pivot-scope-map.md`** (devSys, reused-vs-rewritten map) + the **`auth-pivot-security-model`**
memory (secSys); this spec is the shaping layer — the decision, the rulings planSys owns, acceptance, and
the build decomposition. **Reuse-discipline applies** but the bulk here is *deletion* of client identity code.

## Decision (user, firm, 2026-06-17 — "yes to all")
Drop passkeys entirely. **Username + password** = primary credential; **optional TOTP 2FA**; **recovery
phrase demoted to a forgot-password reset token** (no longer the crypto root). Three confirmed calls:
1. **Day-to-day UNGATED** — password is for sync / new-device / reset only, never an app-open prompt.
2. **At-rest local notes rely on device/OS + browser sandbox for v1** (E2EE → v2; wrapped-blob custody dropped).
3. **Recovery phrase = high-entropy reset token.**

Verdict from both passes: **securely shippable for v1, lower-risk than it looked** — the D6 account/authz
spine is auth-method-independent and **kept wholesale**, so this is a **zero-data-migration credential swap**.

## Kept / Retired / New (devSys map)
- **KEPT (wholesale):** accountId (data key), grant/session token, `can()`/`guard()`, username
  normalize+atomic-unique, accountId data-scoping. Notes/sync/editor/swipe+trash never see the credential.
- **RETIRED (mostly deletion):** client `identity/*` — passkeys/WebAuthn, signed-challenge, PRF, QR-join,
  Option-A wrapped-blob custody.
- **NEW:** worker register/login/session-refresh/logout + TOTP setup/verify + phrase-reset; shared schema;
  client `RegisterRoute`/`LoginRoute`/`ResetRoute` + shellGate on durable-session.
- **EFFORT:** focused multi-day rewrite of ONE contained layer (worker medium, client medium-large, shared
  small-medium), de-risked by the reused spine.

## Security model (secSys — authoritative in the `auth-pivot-security-model` memory; binding rulings here)
- **Durable session (the load-bearing answer):** `httpOnly + Secure + SameSite=Strict` **refresh cookie**
  scoped to `/refresh` (30–90d sliding). Cold boot auto-rides `/refresh` → short-TTL **in-memory access
  token** → app opens to notes **ungated** (reproduces the passkey silent re-mint; survives reload + iOS
  eviction). Refresh is **stateful + stored hashed server-side — NOT a stateless JWT** (revocation must be real),
  with **rotation + reuse-detection**, a **CSRF belt**, and **revoke-all** firing on ALL FOUR
  credential-change events: **reset / password-change / logout / 2FA-change**. **This SUPERSEDES
  [[session-token-in-memory-only]]** — access token stays in memory; the refresh bearer is an httpOnly
  cookie JS can't read → net **stronger vs XSS** than the old wrapped-key-in-IDB exposure.
- **Password:** **Argon2id** via the already-vendored pure-JS `@noble/hashes` (**no new dep**) + **pepper as
  a Worker secret**. Param-tune by measuring CPU on real CF Workers. **Fallback ladder (in order, each rung
  only if the prior busts the Worker CPU budget at min-sane params):** (1) **param-tune/step-down on pure-JS
  `@noble` Argon2id** — the FREE first move, no new dep, stays on Argon2id (reach here BEFORE any dep);
  (2) **WASM Argon2id** — only if pure-JS can't hit acceptable cost; server-side so it doesn't touch the
  client bundle (perf-value safe), but it **IS a new dependency = a deliberate, logged reuse-discipline
  exception, NOT free**; (3) scrypt/PBKDF2 last. Rate-limit = CF WAF + **per-account exponential backoff** + **Turnstile**
  ([[turnstile-spin]]); **NO hard lockout** (avoids victim-DoS). Uniform invalid-credentials error.
- **⚠️ ENDPOINT ORDERING (security-critical, secSys):** on **BOTH login AND reset**, the cheap gate
  (edge rate-limit / Turnstile / per-account exponential backoff) **MUST run BEFORE the Argon2id hash.**
  A ~325ms server-side hash (devSys early measurement) on an unauthenticated endpoint is a **CPU-amplification
  DoS** if hashed-first. Compose with enumeration defense **IN THIS ORDER: gate first** (stops the DoS),
  THEN **uniform real-or-dummy hashing INSIDE the gate** (always hash — real or decoy — so there's no
  account-existence timing oracle). Build note: Argon2id `m=19456` ≈ 19MB/hash → a 128MB isolate caps
  **~6 concurrent hashes** (memory-bound); 325ms is acceptable for the low-volume new-device+reset-only
  path **once gated**, and unacceptable ungated.
- **TOTP (optional):** encrypted-at-rest (Worker-secret key), replay-guarded (`lastAcceptedStep`), prompted
  on new-device/reset only. **BUILD-NOTE (secSys — easiest to drop):** confirm a valid code BEFORE activating
  2FA (anti-lockout). Full detail in the `auth-pivot-security-model` memory.
- **Recovery phrase:** high-entropy **Argon2id verifier keyed to accountId**. Reset = username+phrase →
  short-TTL single-use token → set new password + revoke-all sessions.
- **At-rest:** rely-on-device **ACCEPTABLE** (no weaker than Option-A). Carry the **honest enrollment
  disclosure forward, INCLUDING the explicit residual-risk clause** (local notes are protected by device/OS
  + browser sandbox only — a local storage-read attacker could read them; not E2EE) + the **SW-cache
  invariant** ([[pin-storage-1-sw-cache-invariant]]); E2EE → v2.

## Rulings planSys owns
- **Usernames = PUBLIC HANDLES (user decision, 2026-06-17):** the username is a **shareable, discoverable
  identity** (sets up future notebook-sharing/collaboration; harmless while single-user). So existence is
  **public by design** and the **enumeration concern dissolves** — devSys landmine 1 resolves the easy way.
  Register is an **open handle-picker** (show taken/available freely; a "check availability" affordance is
  good UX, not a leak). F-acct-4's no-oracle property is intentionally retired for the handle model.
  **STILL KEEP** (these are DoS / timing / credential hygiene, NOT enumeration): **rate-limit register**
  (anti-bulk-creation/abuse, Turnstile optional), **uniform invalid-credentials on login** (don't distinguish
  username-vs-password), **uniform reset failure** (don't distinguish username-vs-phrase), and the
  **gate-before-hash ordering** (the ~295ms Argon2 verifier is a DoS surface regardless of handle publicity).
- **Recovery-phrase is the SINGLE MASTER recovery (secSys v1 ruling, planSys CONFIRMED):** a phrase-only
  reset **clears/re-enrolls 2FA** so a lost 2FA device never permanently locks the user out. Tradeoff,
  eyes-open: the phrase alone can bypass 2FA → 2FA is a second factor against *password* compromise, not
  against *phrase* compromise. Correct default for a notes-app "never get locked out" stance. *(Pending an
  explicit user nod — flagged below; build to it as the default.)*

## Hard acceptance discipline (carry the P0 lesson — devSys landmine 2)
- The rebuilt boot gate MUST keep **day-to-day ungated** AND **latch the live ceremony**: the authed flag
  flips ONLY at ceremony-complete (register/login/reset), all paths — or the enroll-unmount **P0 bug class
  returns**. Carry the `enrollCeremony` regression-test pattern forward to the new routes.
- **CROSS-BOOT latch (secSys P0-class finding, planSys ruling):** the latch is not only within-session — the
  **durable refresh cookie MUST be set at FINALIZE (after phrase-ack), NOT at `/signup`/account-creation.**
  Otherwise a user who abandons registration before saving the recovery phrase is silently re-authed on next
  boot, never saves the phrase, and is **permanently locked out if they later forget the password** — a
  sibling of the old unrecoverable-account P0.
- **BELT — no account left silently unrecoverable:** mark a server-side **`recoveryEstablished` flag at
  FINALIZE** (same ceremony-complete moment as the cookie). On ANY successful login where it's false (account
  created but phrase never saved — e.g. an abandoned signup that set a password), **FORCE the recovery-phrase
  screen** (generate a fresh phrase + the required save-ack, update the server verifier) BEFORE entry. This
  guarantees every account ends up recoverable; it only ever triggers on the incomplete-signup edge, never
  day-to-day. Cookie-at-finalize is the suspenders; the login force-phrase is the belt.
- **Acceptance:** registration abandoned before phrase-ack → no durable cookie set → next boot is NOT silently
  authed; that account's next successful login forces the phrase screen before entry; a fully-finalized
  account is ungated as normal. Regression-test the abandon-before-phrase path.

## Acceptance criteria
1. Register (username+password) → account created on the existing D6 spine (zero data migration); "taken"
   shown; endpoint rate-limited + Turnstile-gated.
2. Login (username+password, +TOTP if enabled) → session; **uniform** error on any failure.
3. **Ungated reload:** cold boot rides `/refresh` → in-memory access token → notes render without a prompt,
   surviving reload + iOS storage eviction. No reusable token at rest (refresh is httpOnly cookie).
4. Logout / password-change / reset / 2FA-change → **revoke-all** refresh sessions.
5. Reset: username + recovery phrase → set new password (+ clear/re-enroll 2FA); non-disclosing on failure.
6. Optional TOTP enrol/verify; encrypted at rest; replay-guarded.
7. Honest at-rest disclosure present; SW never caches `/api` into the shared bucket.
8. No regression to the notes/sync/editor/swipe+trash layer (it's credential-agnostic).
9. P0 discipline: ungated + latched ceremony, with the regression test.
10. **Gate-before-hash:** login + reset run the cheap gate (rate-limit/Turnstile/backoff) BEFORE any
    Argon2id work; hashing is uniform real-or-dummy inside the gate (no DoS amplification, no timing oracle).
11. Refresh is **stateful + server-hashed (not a JWT)**; **revoke-all** verified on all four credential-change
    events; at-rest disclosure carries the residual-risk clause.

## Build decomposition (pilot routes)
- **worker + shared lane (devSys):** register/login/refresh/logout/reset/TOTP endpoints, Argon2id+pepper,
  refresh-cookie rotation/reuse-detection/revoke-all, phrase verifier, schema; delete obsolete auth crypto.
- **client lane (devSys2 / gruntSys2):** delete `identity/*` passkey stack; RegisterRoute/LoginRoute/
  ResetRoute + optional-2FA UI; shellGate on durable-session; honest disclosure copy (planSys copy pass).
- **secSys:** reviews the spec AND the build.
- **ONE build dependency:** measure Argon2id CPU on real CF Workers to tune params (pure-JS measure-on-real-
  Workers class — same discipline as the real-D1 lessons).
- **Migration:** clean re-enroll (dogfood-only, no data migration).

## Open items — BOTH RESOLVED (user, 2026-06-17)
- **Username = PUBLIC HANDLE** ✅ — shareable/discoverable identity; enumeration-obscuring dropped, register
  is an open handle-picker; rate-limit/uniform-errors/gate-before-hash kept for DoS/timing only. (See ruling above.)
- **Phrase-clears-2FA = CONFIRMED** ✅ — recovery phrase resets password AND 2FA (never-locked-out); the
  disclosure copy B+C "turns off two-factor" clauses are permanent.
