# Auth Pivot (username + password + optional TOTP) — executable acceptance matrix

**Owner:** scopeSys (analyst). **Status:** DRAFT — 2026-06-17. The spec-level **done-gate** for
`docs/specs/auth-pivot-password.md` (@e75ae96 — both user nods LOCKED: usernames = PUBLIC HANDLES,
phrase-clears-2FA permanent; + the ordered Argon2id ladder and TOTP confirm-before-activate),
built against devSys's scope map
(`docs/design/auth-pivot-scope-map.md` @2fb0cfc) and secSys's binding rulings (`[[auth-pivot-security-model]]`).
Same shape as the matrices I own (`v1-shell-conflict-acceptance-matrix.md`, `swipe-actions-acceptance-matrix.md`).
This pivot **supersedes the passkey model** ([[stream-a-identity-plan]]) — it is a **zero-data-migration
credential swap** on the kept D6 account/authz spine.

**The Tier split:**
- **Tier-A — automatable** = the **protocol-correctness** half: anti-enumeration responses, gate-before-hash
  ordering, Argon2id/pepper/PHC, refresh rotation + reuse-detection + revoke-all, TOTP replay-guard +
  confirm-before-activate, phrase-verifier + single-use token, the L2 latch logic, and no-bearer-at-rest.
  Worker `[SRV]` + client `[CLI-auto]` tests, written TDD. **A Tier-A row is a hard merge gate.**
- **Tier-B — dogfood-only** = what only a real installed PWA on a real device proves: **ungated reload
  surviving real iOS storage eviction**, the httpOnly-cookie round-trip end-to-end, TOTP against a real
  authenticator app, the full register/login/reset ceremony feel, and the honest at-rest disclosure on
  screen. User-verified via the exploratory-relay pattern.
- **The Argon2id real-Workers measurement (AP-M1)** is its own **measured gate** — the spec's *one* build
  dependency — same discipline as the real-D1 lessons (`[[d1-rowswritten-index-inflation]]`,
  `[[migration-d1-no-temp-table]]`): a local datapoint (~325ms/hash) is NOT authoritative; CPU + the
  ~6-concurrent-per-128MB-isolate memory bound must be measured on real CF Workers, and params tuned to budget.

**Proof tiers:**
- **[SRV]** — worker test harness (vitest): endpoints, `authStore`, schemas. The auth protocol legs live here.
- **[SRV: real-Workers]** — must be measured on real CF Workers, not the local harness (AP-M1 Argon2id
  cost/concurrency). Local better-than-nothing, but the gate is the real-Workers number.
- **[CLI-auto]** — client headless (Vitest + jsdom; `fake-indexeddb`): `shellGate` durable-session logic,
  the L2 ceremony latch, the no-bearer-at-rest assertion. `render` sub-tag = needs the jsdom render harness.
- **[DEV]** — on-device dogfood (real installed PWA over Tailscale HTTPS, the iPhone). The cookie-survives-
  eviction, real-authenticator-TOTP, and ceremony-feel legs are *only* fully provable here.

**Locked user decisions (both nods LOCKED 2026-06-17, spec @e75ae96 — no relaxable defaults remain):**
- **Usernames = PUBLIC HANDLES.** Register is an **open handle-picker**: it shows taken/available **freely,
  by design** — F-acct-4's no-oracle property is **intentionally retired** for the handle model (handle
  existence is public). So **register's enumeration-obscuring requirement DROPS** (AP-1d). **What does NOT
  drop — these are DoS / credential-hygiene gates, not enumeration:** (i) **rate-limit register**
  (anti-bulk-abuse), (ii) **uniform invalid-credentials on LOGIN** (AP-2 — don't become a password-validity
  oracle: never reveal *which* of username/password was wrong, public handles or not), (iii) **uniform
  reset failure** (AP-3), (iv) **gate-before-hash** (AP-4 — the ~295ms Argon2id DoS surface, regardless).
  Net: only register's enum-obscuring relaxes; nothing security-critical drops.
- **Phrase-clears-2FA = PERMANENT** (a phrase-only reset re-enrolls/clears 2FA so a lost 2FA device never
  permanently locks the user out). Eyes-open tradeoff: the phrase alone bypasses 2FA. No longer a default —
  it is the locked policy (AP-15).

A row is GREEN when its proof passes in its tier. **The gate closes when every Tier-A [SRV]+[CLI-auto] row
is green, AP-M1 reports a real-Workers Argon2id cost within the gated budget, AND the [DEV] dogfood confirms
ungated-reload-across-eviction + the ceremony feel + the on-screen at-rest disclosure.**

**Build progress (2026-06-17):** ✅ **AP-7/AP-M1 CLOSED** — Argon2id measured ~295ms/hash on real workerd,
pure-JS rung-1 held (no dep-exception). All lanes landed + secSys-reviewed → see gate-check record below.

---

## Gate-check record — 2026-06-17 (worker @9b77f4f, client @8161547, forced-phrase @f45b140; secSys PASS)

**GATE VERDICT: 🟢 GREEN — cleared for deploy.** Every Tier-A [SRV]+[CLI-auto] leg is verified **against
landed code** (not just green counts), AP-M1 is closed (pure-JS Argon2id ~295ms, no dep), and secSys's whole
auth-pivot security review = **PASS** (client 6 legs + P0-belt + worker, verified server-side). scopeSys
independently re-ran the suites: **worker 188/188, client 110/110, shared 67/67** (counts dropped from the
pre-retire numbers because the legacy-auth retire deleted the obsolete passkey suites). Verified per leg via
direct code inspection + the asserting test:

**Worker / shared (devSys @9b77f4f) — VERIFIED:**
- **AP-1d** open handle-picker (gate-rate-limited) `passwordAuth.ts:248-306` / `AP-T1`.
- **AP-2** uniform login 401 (unknown-user / wrong-pw / bad-TOTP byte-identical) `:312-383` / `AP-T2`.
- **AP-3** uniform reset failure `:461-505` / `AP-T3`.
- **AP-4** gate-before-hash — `gate()` precedes Argon2id on signup/login/reset (263→287, 330→344, 477→491) / `AP-T4`.
- **AP-5** dummy-hash on unknown user, no early return (`dummyHash` 344, `dummyRecoveryHash` 491) / `AP-T5`.
- **AP-6** Argon2id `@noble` + pepper-HMAC + PHC + rehash-on-login / `AP-T6`. **AP-7** `ARGON2_PARAMS` pinned, AP-M1 closed.
- **AP-9** refresh stored hashed, rotation-on-use, reuse-detection revokes the family (`:408`) / `AP-T7`.
- **AP-10** revoke-all on **all four** events — code at logout `:452`, reset/password-change `:501`, 2FA-enable `:619`, 2FA-disable `:650`. ⚠️ **see gap below.**
- **AP-11** CSRF origin-check on cookie mutations + SameSite=Strict + Path-scoped / `AP-T7`.
- **AP-14** TOTP AES-GCM-encrypted at rest + `lastAcceptedStep` replay-guard + confirm-before-activate / `AP-T9`.
- **AP-15** phrase verifier keyed to accountId + single-use short-TTL token + revoke-all + clears-2FA + reset-backoff ≥ login / `AP-T10`.
- **AP-19** migrations 0004/0005 (credentials + refreshSessions + authThrottle), no temp tables.

**Client (devSys2/gruntSys2 @8161547 / @f45b140) — VERIFIED:**
- **AP-12** `shellGate.selectBootView` ungated on durable session; `init()` rides `/refresh` → in-memory token / `shellGate.test.ts`.
- **AP-13** no bearer at rest — `bearerToken` is Zustand in-memory only; **no** localStorage/sessionStorage/Dexie token write (localStorage holds only the non-auth notebook cursor) / `authStore.test.ts`.
- **AP-16** L2 latch — `beginAuth`/`finalizeAuth` atomic; `isAuthing` pins the gate; `isAuthed` flips only at ceremony-complete on register/login/reset / `registerCeremony.render.test.tsx` + `forcedPhrase.render.test.tsx` (the @f45b140 P0-belt abandon-path test).
- **AP-17** disclosure copy carries the residual-risk + not-E2EE + local-read clauses; **SW `/api` denylist** holds (`sw.ts` NavigationRoute `denylist:[/^\/api\//]`) / `disclosure.render.test.tsx`. `identity/*` passkey stack **deleted**.

**⚠️ ONE non-blocking gap (labeled-coverage, not a code/security gap):** AP-10 is the **marquee** leg
(revoke-all on all 4 credential-change events). The **code is correct for all four** (call sites above) and
**secSys verified it server-side (PASS)**, but the **AP-T8 automated suite explicitly asserts revoke-all
only for logout + reset/password-change** — the **two 2FA-change paths (totp enable / totp disable) call
`revokeAll` but have no labeled regression test.** Recommend a cheap belt (same shape as the swipe SA-T4
belt): one test that mints a refresh session, toggles 2FA, and asserts the family is revoked — ×2.
**Non-blocking for deploy** (code correct + secSys-verified), but the marquee row deserves a labeled test.

**Tier-B [DEV] (AP-D1..D4) — post-deploy on-device:** ungated reload across a real iOS eviction, TOTP vs a
real authenticator, the register/login/reset ceremony feel, the on-screen disclosure. These verify on the
live PWA *after* fresh-pilot deploys — the deploy is the vehicle to the dogfood, so they are not pre-deploy
blockers; they are the final close.

---

## Acceptance matrix — one row per criterion (AP-1 … AP-19)

Spec AC refs in the last column map to `auth-pivot-password.md` §Acceptance criteria 1–11.

| ID | Criterion | Tier | What to test | How to verify | Lane / AC |
|----|-----------|------|--------------|---------------|-----------|
| **AP-1a** | **Register** creates an account on the existing **D6 spine** | **Tier-A** [SRV] | `POST /register {username,password}` → `createAccount` (server-random `accountId`) + credential record + atomic-unique `claimUsername` + mint session + Set-Cookie refresh + return recovery phrase **once** | AP-T1 round-trip; account lands on the kept spine, **zero data migration** | devSys / AC1, AC19 |
| **AP-1d** | **Register = OPEN handle-picker** (public handles): shows taken/available **freely, by design**; endpoint **rate-limited** | **Tier-A** [SRV] | a taken handle returns a **distinct "taken"/"available"** response — F-acct-4 no-oracle **intentionally retired** for the handle model (existence is public). **Enum-obscuring DROPPED.** STILL a HARD gate (DoS, not enum): the endpoint is **rate-limited** (per-IP/per-account) + Turnstile-available against bulk abuse | AP-T1: taken→taken / free→available (open oracle is correct); rapid repeats → throttled | devSys / AC1 |
| **AP-2** | **Login** → session; **UNIFORM invalid-credentials** on any failure | **Tier-A** [SRV] — HARD (credential-hygiene) | `POST /login {username,password,totp?}` → verify Argon2id (+TOTP) → mint session + Set-Cookie. **Unknown-user, wrong-password, and bad-TOTP all return the identical** "wrong username or password" (status+body). **NOT enumeration-obscuring** (handles are public) — it's **anti-credential-stuffing: never become a password-validity oracle** (never reveal *which* factor was wrong) | AP-T2: three failure modes → byte-identical 401; success → session + cookie | devSys / AC2 |
| **AP-3** | **Reset = UNIFORM failure** | **Tier-A** [SRV] — HARD (credential-hygiene) | username+phrase failure returns a **uniform** non-committal response — unknown-username and known-username-wrong-phrase are **indistinguishable**. Not about hiding handle existence (public) but about not leaking phrase-validity / which factor failed | AP-T3: both failure modes → identical response | devSys / AC5 |
| **AP-4** | **GATE-BEFORE-HASH** ordering on login AND reset (leg #10, DoS defense) | **Tier-A** [SRV] + **[SRV: real-Workers]** | the cheap gate (edge rate-limit / Turnstile / per-account exponential backoff) **runs BEFORE** any Argon2id work on **both** unauthenticated endpoints; an over-threshold request is **rejected without reaching the hash** | AP-T4: spy/order assertion — gate invoked before the hash fn; throttled request never calls Argon2id. Real-Workers (AP-M1) confirms a gated 325ms hash is within budget, ungated is not | devSys + secSys / AC10 |
| **AP-5** | **Uniform real-or-DUMMY hash inside the gate** (no timing oracle) (leg #10) | **Tier-A** [SRV] | even on an **unknown user**, an Argon2id (decoy) hash is computed — **no early return** — so response timing never leaks account existence; constant-time compare | AP-T5: the unknown-user branch still calls Argon2id (assert no short-circuit); timing parity | devSys + secSys / AC10 |
| **AP-6** | **Argon2id + pepper + PHC** | **Tier-A** [SRV] | `@noble/hashes` argon2id (no new dep), 16B per-user salt, full **PHC string** stored, **pepper as a Worker secret** (HMAC before hash → a D1-only leak can't crack offline), **rehash-on-login** upgrade when params change | AP-T6: PHC round-trip; pepper applied; rehash-on-param-change; a D1 row alone is not offline-crackable (pepper absent) | devSys / AC2 |
| **AP-7** | **Argon2id real-Workers CPU/memory measurement** (the ONE build dependency) | **[SRV: real-Workers]** — measured gate **✅ CLOSED** | measure CPU/latency on real CF Workers at min-sane params; the **memory-concurrency bound** (~19MB/hash → ~6 concurrent per 128MB isolate); tune params to budget; **fallback ladder in order:** (1) step-down pure-JS `@noble` Argon2id [free], (2) WASM Argon2id [server-side, bundle-safe, **logged dep exception**], (3) scrypt/PBKDF2 last | **✅ AP-M1 SATISFIED (devSys, real workerd): ~295ms/hash at target `m=19456,t=2,p=1`.** VERDICT = **keep pure-JS `@noble` at target params** — **rung-1 held, NO ladder descent, NO WASM, NO dep-exception**; `ARGON2_PARAMS` unchanged. Closes on "pure-JS held, zero logged exception." | devSys / AC2 (build dep) |
| **AP-8** | **Durable session = httpOnly+Secure+SameSite=Strict refresh cookie**, access token in-memory (leg #11) | **Tier-A** [SRV] + [CLI-auto] + [DEV] | refresh = an **httpOnly+Secure+SameSite=Strict** cookie **Path-scoped to /refresh**, Max-Age = durable window (30–90d sliding); access = short-TTL **in-memory** Bearer. Same-origin (worker serves PWA via `assets`, no CORS) | [SRV] cookie attributes asserted on Set-Cookie; [CLI-auto] access token held in memory only; [DEV] survives reload | devSys + client / AC3 |
| **AP-9** | **Refresh is STATEFUL + server-HASHED — NOT a JWT** (leg #11) | **Tier-A** [SRV] | only a **HASH** of the refresh token is stored server-side (reuse F6 `hashToken`, never raw); **rotation-on-use** (issue new, invalidate prior); **reuse-detection** (a presented already-rotated token = theft → **revoke the whole family**). Stateful so revocation is real | AP-T7: stored value ≠ raw token; rotate-then-replay-old → family revoked | devSys / AC11 |
| **AP-10** | **Revoke-all on ALL FOUR credential-change events** (leg #11) | **Tier-A** [SRV] — **marquee gate** | **reset / password-change / logout / 2FA-change** each **revoke all refresh families** for the account | AP-T8: four explicit assertions, one per event; each invalidates every family | devSys / AC4, AC11 |
| **AP-11** | **CSRF belt** (leg #11) | **Tier-A** [SRV] | SameSite=Strict **plus** an origin/Referer check on mutations (belt-and-suspenders); the access path stays CSRF-immune via the custom `Authorization` header | AP-T (folded into AP-T7/T8 setup): a cross-origin mutation without the origin/header is rejected | devSys + secSys / AC11 |
| **AP-12** | **Ungated reload** — cold boot rides `/refresh` → in-memory token → notes render, NO prompt; survives reload + **iOS eviction** | **Tier-B** [DEV] + [CLI-auto] (logic) | cold boot auto-rides `/refresh` (the cookie jar is not the evicted localStorage) → mint in-memory access → `shellGate` renders the shell **ungated** | [CLI-auto] the shellGate decision logic (durable-session-can-reestablish → shell, else login); **[DEV]** = the real cold-reboot-across-eviction proof (only fully provable on-device) | client / AC3 |
| **AP-13** | **No reusable bearer at rest** (F7 restated, [[session-token-in-memory-only]] SUPERSEDED) | **Tier-A** [CLI-auto] | **no JS-readable bearer** persists: neither access nor refresh token is in Dexie / localStorage / sessionStorage; the sole durable credential is the **httpOnly cookie JS cannot read**. Net **stronger vs XSS** than the old in-memory token | AP-T12: after register/login, scan all client stores → no token row; reload → token is gone-then-re-minted, never read from rest | client / AC3 |
| **AP-14** | **TOTP (optional)** — encrypted-at-rest, replay-guarded, new-device/reset-only, **confirm-before-activate** | **Tier-A** [SRV] (+ [DEV] real app) | RFC-6238, 20B secret, otpauth QR; **secret encrypted at rest** (Worker-secret AES-GCM); ±1 step skew, constant-time; **replay guard: persist `lastAcceptedStep`, reject ≤ last**; **confirm a valid code BEFORE activating** (anti-lockout); prompted at new-device/reset **only**, never day-to-day | AP-T9: setup-without-confirm does NOT enable; replay (≤ lastAcceptedStep) rejected; stored secret ciphertext ≠ plaintext. **[DEV]** = a real authenticator app | devSys + client / AC6 |
| **AP-15** | **Recovery-phrase reset** — Argon2id verifier keyed to accountId, short-TTL single-use token, revoke-all, **phrase-clears-2FA (LOCKED policy)** | **Tier-A** [SRV] | high-entropy phrase (≥128 bits, never user-chosen), shown once; verifier = **Argon2id(phrase)+salt keyed to accountId**; reset = username+phrase → slow-hash compare → **short-TTL single-use** reset token → set new password → **revoke all refresh families** + **clear/re-enroll 2FA** (default); **rate-limit reset ≥ login** (a phrase guess = full takeover) | AP-T10: correct phrase → single-use token (2nd use + expired both rejected); reset revokes-all + clears 2FA; reset is gated ≥ login | devSys / AC5 |
| **AP-16** | **L2 HARD gate — ungated day-to-day + LATCHED ceremony** (P0 discipline) | **Tier-A** [CLI-auto] + [DEV] | day-to-day stays **UNGATED**; `isAuthed` flips to shell-rendering **ONLY at ceremony-complete** on **register / login / reset — ALL paths**; an interrupt/unmount mid-ceremony must **not** leave a half-authed shell (the **P0 enroll-unmount class**). **Carry the `enrollCeremony` regression-test pattern** to the new routes | AP-T11: the ported `enrollCeremony` latch test on RegisterRoute/LoginRoute/ResetRoute; mid-ceremony unmount → no leak. **[DEV]** confirms feel | client / AC9, [[enroll-ceremony-latch-fix]] |
| **AP-17** | **Honest at-rest disclosure + residual-risk clause + SW-cache invariant** | **Tier-A** [CLI-auto: render] + [DEV] | the enrollment disclosure carries forward **including the explicit residual-risk clause** (local notes protected by device/OS + browser sandbox only — a local storage-read attacker could read them; **not E2EE**; E2EE→v2); the **SW never runtime-caches `/api`** into the shared Cache bucket | render: the disclosure copy + clause present at register/reset; AP-T (SW grep, `[[pin-storage-1-sw-cache-invariant]]`); **[DEV]** = on-screen | client + secSys / AC7, AC11 |
| **AP-18** | **No regression to notes/sync/editor/swipe+trash** (credential-agnostic) | **Tier-A** [SRV]+[CLI-auto] (REFERENCE) | the data layer keys on `accountId` from the session and **never sees the credential** — re-run the existing notes/sync/swipe+trash suites unchanged; **green = no coupling** | the existing suites (incl swipe-actions 241/241) stay green post-pivot; do not duplicate | all / AC8 |
| **AP-19** | **Zero data migration** — clean re-enroll, no data migration | **Tier-A** [SRV] | new `credentials` + `sessions/refresh` tables/columns; `devices`+`challenges` dropped/ignored; migration verified with **`db:migrate:local`** (no temp tables — `[[migration-d1-no-temp-table]]`) | migration applies clean on a fresh dogfood DB; existing accountId-keyed data untouched | devSys / AC1 |

---

## Tier-A regression scaffold (worker `[SRV]` + client `[CLI-auto]`)

The **automatable** rows the dogfood does not re-prove. Written TDD against the new endpoints + `authStore`
+ `shellGate`. Assert **shape/ordering**, not feel.

| Test ID | Backs | Assertion | Tier |
|---------|-------|-----------|------|
| **AP-T1** | AP-1 | register → account on the D6 spine + atomic-unique claim + session + refresh cookie + phrase once; **taken → distinct "taken"**; endpoint rate-limited | [SRV] |
| **AP-T2** | AP-2 | login **unknown-user / wrong-password / bad-TOTP → byte-identical 401** (anti-credential-stuffing: no password-validity oracle); success → session + Set-Cookie | [SRV] |
| **AP-T3** | AP-3 | reset **unknown-username** and **known-username-wrong-phrase → identical** uniform-failure response (no phrase-validity leak) | [SRV] |
| **AP-T4** | AP-4 | **gate runs BEFORE Argon2id** on login AND reset (order spy); an over-threshold request is rejected **without** calling the hash | [SRV] |
| **AP-T5** | AP-5 | the **unknown-user** branch still computes a (dummy) Argon2id — **no early return** (timing-oracle guard) | [SRV] |
| **AP-T6** | AP-6 | PHC round-trip; **pepper** HMAC applied before hash; **rehash-on-login** when params change; constant-time compare | [SRV] |
| **AP-T7** | AP-9, AP-11 | refresh stored as a **hash** (≠ raw); **rotation-on-use**; presenting an already-rotated token → **family revoked** (reuse-detection); cross-origin mutation w/o origin check rejected | [SRV] |
| **AP-T8** | AP-10 | **four** assertions — reset / password-change / logout / 2FA-change each **revoke ALL** refresh families | [SRV] |
| **AP-T9** | AP-14 | TOTP **confirm-before-activate** (no confirm → not enabled); **replay** (≤ `lastAcceptedStep`) rejected; secret **encrypted** at rest (ciphertext ≠ plaintext) | [SRV] |
| **AP-T10** | AP-15 | phrase verifier = **Argon2id keyed to accountId**; correct phrase → **single-use** short-TTL token (2nd use + expired rejected); reset **revokes-all** + **clears/re-enrolls 2FA**; reset gated **≥ login** | [SRV] |
| **AP-T11** | AP-16 | the **`enrollCeremony` latch pattern** ported to RegisterRoute/LoginRoute/ResetRoute: `isAuthed` flips to shell **only at ceremony-complete**, all paths; a mid-ceremony unmount leaves **no half-authed shell** | [CLI-auto] |
| **AP-T12** | AP-13 | after register/login, **no token at rest** (Dexie/localStorage/sessionStorage scanned clean); only the httpOnly cookie holds the durable credential | [CLI-auto] |

> **AP-M1 (the ONE build dependency) — Argon2id real-Workers measurement. ✅ SATISFIED 2026-06-17 (devSys,
> real workerd).** Result: **~295ms/hash at target `m=19456,t=2,p=1`** (better than the local ~325ms
> datapoint). **VERDICT: keep pure-JS `@noble` at target params — rung-1 of the ladder held; NO step-down,
> NO WASM, NO scrypt/PBKDF2, NO logged dep-exception; `ARGON2_PARAMS` unchanged.** The measure-on-real-infra
> discipline (same class as `[[d1-rowswritten-index-inflation]]` / `[[migration-d1-no-temp-table]]`) paid
> off — the authoritative number came from real workerd, not the local box. A gated ~295ms is acceptable
> for the low-volume (new-device+reset-only) path; ungated it is a DoS — which is why **AP-4 (gate-before-
> hash) remains a hard gate** even though the measurement passed.

---

## Tier-B — dogfood-only ([DEV], user-verified via exploratory-relay)

| ID | Item | Why dogfood-only |
|----|------|------------------|
| **AP-D1** | **Ungated reload across a real iOS storage eviction** | the cookie-jar-survives-eviction property (AP-12) is only honestly provable on a real installed iOS PWA after the OS evicts storage |
| **AP-D2** | **TOTP against a real authenticator app** | QR scan + a real RFC-6238 app + the confirm-before-activate flow end-to-end |
| **AP-D3** | **Full register / login / reset ceremony feel** | the latched ceremonies (AP-16) on-device — no half-authed flashes, smooth ungated entry |
| **AP-D4** | **At-rest disclosure on screen** | the honest residual-risk copy (AP-17) renders + reads honestly at register/reset |

---

## Coordination & owners

- **worker + shared lane (devSys):** register/login/refresh/logout/reset/TOTP endpoints, Argon2id+pepper,
  refresh-cookie rotation/reuse-detection/revoke-all, phrase verifier, schemas; **delete** obsolete auth
  crypto (signed-challenge `canonical.ts`/`requests.ts`, challenge store). Owns AP-T1..T10 + AP-M1.
- **client lane (devSys2 / gruntSys2):** **delete `identity/*`** (passkeys/WebAuthn/PRF/QR-join/Option-A
  wrapped-blob custody); `RegisterRoute`/`LoginRoute`/`ResetRoute` + optional-2FA UI; `shellGate` on
  durable-session; honest disclosure copy (planSys copy pass). Owns AP-T11/T12 + the AP-12/16/17 render legs.
- **secSys:** reviews the **spec AND the build** — esp. AP-4/AP-5 (gate-before-hash + uniform hash),
  AP-9/AP-10/AP-11 (stateful refresh / revoke-all / CSRF), AP-14 (TOTP at-rest + replay), AP-15 (phrase
  binding + rate-limit ≥ login), AP-17 (residual-risk honesty floor). Authoritative model:
  `[[auth-pivot-security-model]]`.
- **Kept spine (no rework):** `accountId`, grant/session token (F5/F6), `can()`/`guard()`, `username.ts`
  normalize+atomic-unique, accountId data-scoping — the D6 payoff that makes this a zero-migration swap.
- **User decisions LOCKED (both nods, @e75ae96)** — usernames = PUBLIC HANDLES (AP-1d enum-obscuring
  dropped; register rate-limit + AP-2/AP-3 uniformity + AP-4 gate-before-hash all STAY as DoS/credential-
  hygiene gates), phrase-clears-2FA permanent (AP-15). **No relaxable defaults remain** — nothing in the
  matrix is now pending a user call.
- **Reuse-discipline:** AP-M1 already resolved with **zero new dependency** (pure-JS `@noble` rung-1 held at
  ~295ms). The WASM-Argon2id rung was never reached, so no logged dep-exception was needed. Everything else
  is deletion + reuse of the kept spine.
