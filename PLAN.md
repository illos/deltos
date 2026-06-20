# deltos — living roadmap & status

The **durable** plan-of-record. `KICKOFF.md` is the locked build plan (the *what* + roadmap);
`brainstorm.md` is the design rationale (the *why*). **This file** tracks live status: which
specs are written, handed off, in flight, or done — so a planner clear-and-relaunch resumes
from disk with nothing lost.

Maintained by the **planner** (planSys). Specs live in `docs/specs/`. Handoff target =
orchestrator **pilot**; team = devSys (impl/opus), gruntSys + gruntSys2 (support/sonnet),
secSys (audit/opus). **User-facing decisions are logged in `DECISIONS.md`** (the async board —
the user answers there on their own schedule; I fold answers back into this plan).

**Hard rule on every spec:** the reuse-discipline gate (rewrite-to-native; would a stranger
guess it was lifted?). See `KICKOFF.md` §Reuse discipline.

---

## ⏯ CURRENT STATE (2026-06-19 — resume here)
> **LIVE on https://deltos.blackgate.studio; in active on-device dogfood.** Since the 2026-06-16 snapshot below:
> - ✅ **Cloudflare deploy DONE** — app live on the custom domain (Worker + prod D1 + PWA, prod-mode).
> - ✅ **AUTH PIVOT DONE + user-verified on-device** — passkeys → **username+password + optional TOTP + recovery-phrase-as-reset** ([[auth-pivot-password]]). The free-plan Argon2 CPU blocker is resolved (Workers **Paid** → `limits.cpu_ms:30000`, full params kept); 15/15 prod smoke, sign-in confirmed on real devices. North-star auth-friction philosophy survives the mechanism change ([[auth-friction-philosophy]]).
> - ✅ **P0 cross-device SYNC regression FIXED + user-verified** — root cause was per-device random notebookId gating delta sync; fix = **Option B (sync boundary = bearer accountId; notebookId demoted to an organizing tag)** + within-account migration 0006/0007 + secSys PASS ([[sync-notebookid-regression]]). User confirmed edits/deletes/new-notes sync both directions; title-only notes are first-class.
> - ✅ **DONE — client reactivity / felt-slowness fix (#15):** remote changes now appear live (pull-on-return-to-app + 2s pull cadence while visible, suspended when hidden; in-place reactive, no page reload) per the **sync-ASAP** directive ([[sync-asap-conflict-window]]). Shipped.
> - ✅ **NOTEBOOKS DONE + on-device validated (2026-06-19)** — the full view-driven UI shell v1 ([[ui-view-driven-architecture]], [[notebooks-and-search-plan]]): the view-resolution SEAM as the backbone shipping ONE collection view (note list) + ONE item view (doc editor), future views additive; account-scoped synced notebooks (CRUD, undeletable default, move-note, delete→Trash); current-notebook = per-device IndexedDB pointer; a **responsive BOTTOM-NAV** (redesigned mid-stream from a left-drawer to fix the iOS edge-gesture conflict — bottom bar with an extensible action-slot row + drag-up to the full menu; desktop keeps a left pane — `docs/specs/bottom-nav-mobile.md`). Survived two glass-test rounds (3 P0s fixed under the new render-test + on-device-smoke gate, [[ui-features-need-rendered-ui-gate]]) + all polish (scroll-lock, edge-to-edge list, PWA home-indicator clearance). Spec: `docs/specs/ui-backbone-notebooks.md`.
>   - 🔧 **Search (#20) — BUILDING NOW** against `docs/specs/search.md` (entry = the bottom-bar Search slot): full-screen, local/offline, **fuzzy** + **relevance-ranked** (title>body), current-notebook headline + other-notebooks collapsible expand-in-place, snippet+highlight rows, cross-notebook peek doesn't move the current notebook.
>   - **NEXT after Search — visual UI-refresh:** colors + fonts (user dislikes emoji placeholders → real iconography) + the desktop multi-pane (nav pane | list | note + resize handle). ⚠️ Look/feel direction NOT yet designed with the user — the open design thread. Must hold the load-feel bar.
> - <strike>NEXT: view-driven UI shell (superseded by the DONE block above)</strike>
>   - **SPEC-READY → `docs/specs/ui-backbone-notebooks.md`** (handed to pilot): notebooks CRUD + undeletable default + notebook entities SYNC; current-notebook = device-local IDB pointer (per-device, never synced, fallback→all-notebooks/settings screen); home = current-notebook list + notebook-name sheet + global search entry + new-note FAB; switcher renders as sheet AND full-screen landing; tap-sheet not swipe-drawer; no bottom tab bar. Starts after #15 lands (client-lane contention).
>   - **Search** — **SPEC-READY → `docs/specs/search.md`** (handed to pilot, queued behind backbone+notebooks): full-screen, search-as-you-type, fully LOCAL/offline; title+body, **fuzzy** + **relevance-ranked** (title>body); current-notebook headline flat list + other notebooks collapsible "Name (N)" expand-in-place; row = title + highlighted snippet; tapping a cross-notebook result peeks (doesn't change current notebook). Results = a collection-view (reuse the seam).
>   - **Visual UI-refresh** (restyle of list/editor) = separate later item; must hold the load-feel bar.
> - 📱 **Framed feature (user wants, post-notebooks):** iOS **per-notebook home-screen icons** + a **straight-to-new-note shortcut** ([[per-notebook-homescreen-icons]]). Foundation-backed (S3 spike: iOS isolates per-webclip storage). Gated on a real-device PROBE of whether session/cookie carries across webclips (decides friction). New-note shortcut = simplest slice, ≈notebook-independent.
> - 📌 **Framed future:** realtime push-sync channel (WS/SSE) replacing polling (the real "ASAP"); location notes + map; Phase-2/3 (2nd surface, plugins, embeds, sharing, history/trash UI); v2 E2EE + live collab.
> - Backlog (non-blocking): test hardening (#12), dead-code cleanup (#13).

<details><summary>Historical snapshot — 2026-06-16 (superseded by the above)</summary>

> ✅ **COURSE-CORRECTION COMPLETE (2026-06-16, HEAD 75b58db, fully green + security-cleared).** The
> user-led re-anchor shipped: (1) SHELL — render-before-data, auth/sync in background, recovery-phrase ≠
> boot gate (E4 closed properly); (2) SYNC — option A conflict-as-version (divergent offline edit kept as a
> VERSION of the same note + toast + persistent badge, never a sibling note; revised PIN-SYNC-3/4; full
> history UI → Phase 3). client 225/225 (conflictVersion 18/18, syncEngine trip-wire 8/8, cadence 0-RED,
> disclosure 13/13) + worker Tier-A 12/12; both secSys audits PASS. NORTH STAR locked:
> `[[auth-friction-philosophy]]`. **NEXT: Cloudflare LIVE deploy** (devSys2, single-owner, gated on
> migrate-vs-real-D1 + env-base + clean SHA) → live URL → the LOAD-SENSITIVE real-device re-dogfood. The
> dogfood/finish-line detail below is PRE-correction context, now reframed under the shipped shell/sync model.

</details>

Design complete; **Phase 1 building.** Delivery vehicle = the **local-first PWA** (desktop + mobile,
surfaces pinnable as home-screen webclips). Long-term native target is framed in *Later* (native
Android, for full surface control + sideload freedom — the own-your-software values).
- **Built + stable (foundation):** `@deltos/shared` spine + the **FROZEN auth contract**
  (discriminated-union PrincipalVerification + `can()`); **crypto core** (keyDerivation
  BIP39/SLIP-21/Ed25519 + at-rest blob AES-GCM/HKDF, WebCrypto-only); **sync engine** with the
  data-loss/CAS correctness fix verified (Stream-B trip-wire fired + closed); **editor** Stream C
  (ProseMirror, title unified into the document, iOS-Safari functional gate passed); server (Worker +
  Hono + D1). P0 done + on remote.
- **v1: IN ON-DEVICE DOGFOOD — the LAST gate (2026-06-16).** The AUTOMATABLE gate is FULLY PROVEN
  (server done-gate **14/14** + Tier-A client **13/13** + ALL security closed (secSys) + live prod worker
  validated end-to-end: real enroll/session/recover/replay/audience). v1 now hinges SOLELY on the
  **iPhone dogfood** (8-step runbook; smoke `https://devbox.tail41404c.ts.net:8449/`, recorded capstone
  `:8451` = prod-representative prod client + prod-mode worker, F13 active).
  **⚠️ LIVE THREAD (resume here):** the user is dogfooding NOW; it's flushing real UI gaps the automated
  gate structurally CANNOT see (it drives the store, not the editor UI). **Bugs in flight:** (1) **autosave
  NOT real-time** — the editor never persisted to the store, so typed notes vanish from the list; THE
  real blocker (also blocks offline/sync/recover steps 5/6/8); gruntSys2 fixing **with a MANDATORY
  editor→store verification test before the user resumes** (it assumed persistence worked twice, wrong
  both times — no 3rd disruption). (2) **top bar occluded by the iPhone Dynamic Island** — safe-area fix
  (`viewport-fit=cover` + `env(safe-area-inset-top)` on the top chrome) routed to gruntSys2.
  **Product decision (user):** exit = native Safari swipe-back + the reactive Notes list (NO custom back
  button). **Resume pattern:** user reports bug → planner relays to gruntSys2 (client-shell lane, HMR) →
  fix + verify → rebuild `:8451` → resume. Formal recorded Run-2 once obvious bugs settle + verified.
  Foundation (identity/cross-account/sync-auth) all landed + audited. **Post-v1:** Cloudflare deploy
  (`[[cloudflare-deploy-plan]]`).
- **Constraints in force:** PIN-SYNC-1 atomic-CAS, PIN-ID-1/2 auth-gap closure, PIN-MODEL-1 relations
  (global-by-id), PIN-STORAGE-1 (SW never runtime-caches `/api` into shared Cache), S3 one-clip-per-
  notebook + PIN-ID PRF floor — see `docs/specs/phase-1-constraints.md`.
- **No open user decisions.** D6 RESOLVED (user 2026-06-16): **build the account dimension + add
  usernames** (account-vs-credential separation; data keys on a stable `accountId`, not
  `accountFingerprint`). See `DECISIONS.md` D6 + `[[account-identity-model]]`. D5 copy approved
  (risk accepted) — ship with the PRF-claim accuracy tweak; iOS dogfood still pending.

## Status legend
`PLANNED` → spec not yet written · `SPEC-READY` → written to docs/specs, not handed off ·
`HANDED-OFF` → given to pilot · `IN-FLIGHT` → team building · `LANDED` → built, awaiting audit ·
`DONE` → audited & accepted.

## Current batch — Phase 0 + spike batch (parallel)

| ID | Title | Spec | Owner | Status |
|----|-------|------|-------|--------|
| P0 | Foundation skeleton | `docs/specs/phase-0-foundation.md` | devSys | ✅ DONE (P0-CLEARED, secSys-passed, pushed to remote) |
| S1 | full-beans custody extractability | `docs/specs/spike-S1-custody-extractability.md` | gruntSys | DONE (reported+audited; flags pinned → `docs/specs/phase-1-constraints.md`) |
| S2 | trkr sync-engine sizing | `docs/specs/spike-S2-trkr-sync-sizing.md` | gruntSys2 | DONE (reported+audited; flags pinned → `docs/specs/phase-1-constraints.md`) |
| S3 | iOS multi-webclip storage | `docs/specs/spike-S3-ios-webclip-storage.md` | (queued) | HANDED-OFF |

**Sequencing:** P0 and S1–S3 run **in parallel**. S1+S2 **both cleared (STAGE A reached)**. S3
remains queued/non-blocking (Phase 2/3 storage only). P0 still IN-FLIGHT (devSys) — its DONE+audit
is the **STAGE B** gate to hand off Phase 1. secSys audits each as it lands, P0-hardest.

## Phase 1 — the thesis-prover · 🟢 BUILDING (Stage B live 2026-06-15)

Substrate + spine + sync (server-readable, D1) + **one capture surface** + passkey/recovery/QR
identity, end-to-end. **Spec: `docs/specs/phase-1-vertical-slice.md`**; constraints in
`docs/specs/phase-1-constraints.md` (all S1+S2 audit flags folded — PIN-SYNC-1 atomic-CAS TOCTOU
fix, PIN-ID-1/2 auth-gap closure, PIN-MODEL-1 relations, PIN-STORAGE/SUBSTRATE pins). Editor =
**ProseMirror (LOCKED)**; relations = **global-by-id**.

| Stream | Scope | Owner | Status |
|--------|-------|-------|--------|
| A | Identity (passkey/recovery/QR, signed-challenge auth) | devSys (opus) | auth contract + `can()` **FROZEN** (closed union survives in-tree); server endpoints + client unlock = **DONE-GATE GREEN 2026-06-16** (chokepoint + 4 CF-gated routes + UI front door `b42737d`; secSys CF-1..5 verified; BOLA revoke fixed 21/21). Pending user passes: D5 copy + iOS dogfood |
| B | Substrate + sync (atomic-CAS conflict engine) | devSys2 (opus) | server CAS + client queue-drain **verified correct** (trip-wire fired + closed); sync foundation solid |
| C | Capture surface + editor (ProseMirror) | gruntSys2 (sonnet) | iOS-Safari functional gate **PASSED** (IME/paste/nested-selection); title unified into the document; left-aligned |
| D | Integration / e2e | pilot | pending A + storage |

**Done-gate:** install PWA → unlock w/ passkey → create/edit offline → sync; recover/QR-join 2nd
device; forced conflict → fork not lost-write. secSys audits each stream; **Stream-B trip-wire** =
promote to devSys/opus if first audit finds a CAS/single-flight/race defect.

**Acceptance condition (security-clearance, OPEN):** the **no-PRF KeyStore disclosure** — when the
active WebAuthn binding is `device-local` (wrapping key stored plaintext in IndexedDB, PIN-ID-6), the
enroll/unlock UI MUST render an honest D5-style limitation disclosure. secSys's clearance of the
baseline is *conditional* on this shipping; dropping it voids the clearance. **Owner: gruntSys2**
(hard acceptance condition on its client-identity lane). Trigger-bound to the enroll/unlock UI
surface (not dated). Tracked in `[[keystore-noprf-ui-disclosure]]`. **Seam COMPLETE**
(`getEnrollmentPrfStatus()`, `47f018b`); the **render is now IN PROGRESS** as a hard acceptance
criterion of gruntSys2's enroll/unlock/recovery UI surface. **Render BUILT** (`b42737d`,
`Disclosure.tsx`); remaining to close (i): user-approved copy + iOS dogfood verify.

**Acceptance condition (security-clearance, OPEN):** the **session token stays in-memory-only (F7).**
secSys's v1 30-day session-TTL clearance holds ONLY if the client never persists the session/grant
token at rest (no Dexie table, no localStorage, no cold-start cache). Hard acceptance criterion of
devSys2's client-storage chunk; persisting it voids the TTL clearance (then shorten TTL / wrap at
rest). Tracked in `[[session-token-in-memory-only]]`.

## Later (framed, not yet specced)
- **Phase 2** — second surface (proves decoupling) + notebooks + universal search + plugin
  manifest/contribution-registry MVP (one real plugin). Also carries (all from the 2026-06-15
  design threads, see brainstorm §Plugins):
  - **full-view seam contract** (note→view resolution; full-view reads/writes via the substrate
    API; collab/offline participation) — how non-document notes (recipe cook-view, kanban,
    code-as-body) get custom UI without note-type polymorphism;
  - **notebook plugin/surface loadout** (active contributions + default view) — notebook becomes the
    unit of UI coherence + plugin scope, not just data scope;
  - **portable fallback rendering** — the highest-leverage primitive: ONE mandatory per-type render
    serving FOUR features (cross-notebook/aggregate views, D4 soft-link placeholder, Markdown export,
    collab read-only shard = `collaborative:false`). Build once in Phase 2; v2 collab inherits its
    view-only shard free. Anti-siloing guardrail that keeps D4 global relations working across
    notebook plugin-scoping.
- **Phase 3** — embeds + blob store (R2/OPFS) + capability-URL sharing + Markdown export +
  backup-via-replica + more surfaces/plugins + history/trash.
- **v2** — E2EE zone (option (a) Evolu vs (b) encrypt-on-trkr-stack — decide at build time),
  live collaboration (promote-to-DO), import, **behavior/automation dimension** (reactions /
  recurrence / scheduled triggers / notifications — the named-now third extension dimension, NOT
  `commands`), schema migration.
- **Location-based notes (user 2026-06-17 — ALWAYS-ON by user decision):** auto-capture device location on
  each note via the PWA **Geolocation API** (HTTPS ✓; one-shot **foreground** read; iOS-PWA permission
  flakiness = test on-device). Store **structured coords** (indexed field, NOT the freeform property bag —
  it's queried). **Proximity-based filter/group** ("notes near here / same area / this trip") computed
  **LOCALLY** — no external geocoding, private + cheap. **PRIVACY POSTURE (eyes-open):** user chose
  always-on over planSys's opt-in rec, having acknowledged the concern; consequence = location history
  lands on the server under **non-E2EE sync → STRENGTHENS the v2 E2EE case**. Responsible always-on still
  carries: (a) an **honest disclosure** that every note records location, (b) a **global off-switch** in
  settings (default-on ≠ no escape hatch), (c) per-note location stays **strippable**. **Background/arrival
  geofencing = NATIVE-FUTURE only** (a PWA reads location only while open).
- **Location mapping (user 2026-06-17 — explicit future feature):** a **map view** of notes by location +
  **reverse-geocoded town/place labels** (the named-place layer the local proximity filter doesn't need).
  Sits AFTER basic capture/filter; geocoding = an external-call/privacy cost to weigh at build. Pairs with
  the public-handle sharing direction ("notes from our trip").

## Open decisions (decide at the relevant slice — not current blockers)
- **Editor engine** — Phase 1, informed by S2. The next user-facing call.
- Organization within a notebook (lean: flat + tags + relations) — Phase 2.
- Offline cache text-only vs full media — Phase 3.
- E2EE option (a) vs (b) — v2.

## Decision log
- 2026-06-15 — Design phase closed; all major architecture locked (see KICKOFF §Locked
  architecture). Build team stood up (pilot + 4). First batch = P0 + S1/S2/S3, handed off.
- 2026-06-15 — STAGE A reached (S1+S2 cleared). Phase-1 spec drafted; all audit flags folded.
  Editor engine DECIDED: **ProseMirror (direct)** (DECISIONS.md D1, vetoable pre-STAGE-B).
- 2026-06-15 — Stream-B (conflict engine) stays gruntSys w/ tdd-cycle race-tests-first +
  evidence-based escalation trip-wire (promote to devSys/opus if secSys's first audit finds a
  CAS/single-flight/race defect). A stays opus. Capacity plan stands.
- 2026-06-15 — secSys P0 catch: REST mutation ops lacked optimistic-concurrency precondition →
  pilot adds optional `expectedVersion` to honor PIN-SYNC-1 atomic-CAS on the REST write path too
  (contract-shape fix, orchestrator's lane; PIN-SYNC-1 now covers all version-bumping paths).
- 2026-06-15 — **PIN-MODEL-1: `relation` is GLOBAL-by-id** (not notebook-scoped), with two guard
  rails: `can()`-gated resolution (no cross-boundary access leak) + soft/degrading pointers (no FK,
  dangling-but-safe). → DECISIONS.md D4 (decided, overridable pre-STAGE-B). No relation-repair in v1.
- 2026-06-15 — S3 audited (one-clip-per-notebook endorsed). **PIN-STORAGE-1 (HARD): SW must NEVER
  runtime-cache `/api/*` into shared Cache Storage** — the iOS per-notebook IndexedDB silo is a
  confidentiality boundary only under this invariant (bodies cleartext in Phase 1). +PIN-STORAGE-2
  (shared-OPFS ⇒ per-notebook blob encryption, Phase 3) +PIN-STORAGE-3 (one origin quota/eviction —
  no per-icon durability promise). Pinned in constraints + brainstorm long-lived record.
- 2026-06-15 — D4 read (scopeSys analyst): proceed on **global-by-id**, low flip risk, **do NOT
  hold Stage B**; scopeSys gets the user confirm ASAP + instant-pings on any surprise flip. Stage-B
  trip = P0-clear; D4 only ever buys a SHORT hold, never a block. **PIN-MODEL-1 rail #3 added**
  (scopeSys catch): relation display title is **access-conditional, resolved through `can()` from
  the principal's own accessible replica — NOT a flat denormalized field** (else a cross-notebook
  title leak; also keeps relation titles out of the shared Cache per PIN-STORAGE-1).
- 2026-06-15 — **P0 foundation forced-choices** (devSys, branch `phase-0-foundation`, 5 commits,
  build green, offline-boot + `can()` chokepoint live-verified; secSys re-check in progress). Frozen
  shapes Phase 1 builds on: (1) property `select` unifies tag+select as ordered `string[]`
  (single-select = 1-elem; cardinality lives on a notebook schema later, not the value type);
  (2) block `content` is **opaque (`unknown`) for ALL blocks** core+plugin, and optional (divider
  has none) — per-core-block content typing is a Phase-1 editor concern, spine stays frozen;
  (3) block `type` is an **open string** (`CORE_BLOCK_TYPES` for tooling, never a closed enum —
  plugins register freely); (4) **branded IDs** (`NoteId`/`NotebookId`/`BlockId`) + **ISO-8601
  string timestamps** → **PIN-SUBSTRATE-1**; (5) **one-casing camelCase D1 1:1, no mapping layer**
  → **PIN-SUBSTRATE-1** (removes trkr's mapper bug source); (6) search MUST narrow by ≥1 of
  text|notebookId|property-filter (no unbounded full-scan) — `notebookId` alone already = "list all
  in notebook", **no separate list-all op needed** (planner confirm); (7) REST path params
  authoritative over body (URL `id` can't be overridden); (8) **prod tripwire** —
  `ENVIRONMENT=production` refuses any unverified principal at the chokepoint (the allow-all auth
  stub mechanically can't ship to prod). All endorsed; none block Phase 1.
- 2026-06-15 — **D1 RESOLVED: ProseMirror (direct), user-confirmed, no veto.** Stream C gains 3
  scopeSys scope additions: (a) explicit **unique-block-ID plugin** (PM doesn't preserve IDs across
  copy/paste/split/merge — re-mint to avoid collisions; the spine is ID-first); (b) **budget the
  cross-cutting editor infra** (selection across nested blocks, clipboard ser/parse, undo/redo,
  mobile IME) as the real first-slice cost, not block-type boilerplate; (c) **dogfood on real iOS
  from the first build** (primary surface is mobile). Folded into spec Stream C + relayed to pilot.
- 2026-06-15 — **D2 CLOSED** (real-iPhone probe): OPFS + IndexedDB both **isolated** — same-origin
  webclips do NOT share storage. **PIN-STORAGE-2 trigger does NOT fire** (no forced per-notebook
  blob encryption on storage-sharing grounds; only E2EE/v2 would). One-clip-per-notebook real-device
  confirmed. **PIN-STORAGE-1 unaffected** (Cache Storage still shared; never-cache-`/api` stands).
- 2026-06-15 — *Open thread:* user says D1 surfaced a **deeper question**; scopeSys digging in. No
  Phase-1 contract impact yet; fold if it lands.
- 2026-06-15 — **🟢 STAGE B LIVE.** P0 secSys-CLEARED (frozen contract + hardened chokepoint + PWA
  shell with PIN-STORAGE-1 mechanically held), pushed to remote. Fan-out: A→devSys (cleared fresh
  at the boundary for the 5–7d identity stream), B→gruntSys, C→gruntSys2, D→pilot. secSys
  carry-forward into Stream A: **invert the prod tripwire to fail-CLOSED on missing-env** (before
  real handlers) — strengthens the #8 prod guard. Phase-1 build underway.
- 2026-06-15 — **Polymorphism design thread (user via scopeSys).** "One block editor for
  everything, or note-body polymorphism?" → **NO note-type polymorphism; spine stays monomorphic;
  compose the 3 seams** (block/island, property bag, full-views). D1/PM NOT reopened. Two hardening
  items folded into the design record + Phase-2: (A) **full-view = load-bearing seam** needing a
  Phase-2 contract (note→view resolution, substrate-API read/write, collab/offline opt-in) +
  cheap-now Phase-1 view-resolution-indirection hedge; (B) **behavior/automation NAMED as the 3rd
  extension dimension** (reactions/triggers, NOT commands; notifications v2-deferred). See brainstorm
  §Spine + §Plugins.
- 2026-06-15 — **Notebook-model design thread (user via scopeSys), approved.** (1) Notebook carries
  a **plugin/surface loadout** (active contributions + default view) → notebook = unit of UI
  coherence + plugin scope. (2) Mandatory **portable fallback rendering** per note/block type for
  viewing outside the home notebook's plugins — the anti-siloing guardrail that keeps D4 global
  relations working (notebooks = coherent surfaces, not sealed boxes). **Convergence (user-spotted):
  the portable fallback is ONE primitive serving FOUR features** — cross-notebook/aggregate views,
  D4 soft-link placeholder (PIN-MODEL-1), Markdown export, and the collab read-only shard
  (`collaborative:false`, already in the manifest). Spec as a single first-class artifact; build in
  Phase 2, v2 collab inherits the view-only shard free. Folded into brainstorm §Layered-model +
  §Plugins + Phase-2 framing. Highest-leverage small primitive in the thread.
- 2026-06-15 — **Stream-A audit (secSys early read):** caught a CRITICAL account-takeover bug
  (server wasn't enforcing `accountFingerprint == hash(signingPublicKey)` at registration) + 3
  lock-blockers — all fixed before the auth contract locks (the early-read approach earning its
  keep). **F1 (accepted v1 posture → DECISIONS D5):** SLIP-21-sibling signing key is **shared
  across the account's devices**, so grant revocation revokes the TOKEN but a mnemonic-holder can
  re-enroll — consistent with PIN-ID-5 (inherent to recovery-phrase identity: phrase-holder = the
  account). Per-device keypairs (true key-level revocation) = a **non-breaking Phase-2 upgrade** —
  devSys pre-shapes the DeviceRegistry seam (`deviceSigningPublicKey` + `deviceAuthorization`) now
  so it drops in without reworking identity. Pilot authoritatively confirmed (a) account-level v1 to
  devSys citing D5 — clean escalation discipline, no separate re-decision needed. **D5 ACKNOWLEDGED
  by user** — accepts v1 account-level; notes this limitation is **known/accepted ground from
  full-beans** (the custody-extraction source), a deliberate recovery-phrase-identity tradeoff. No
  upgrade roadmapped; keep the pre-shaped seam.
- 2026-06-15 — **Git baseline on remote.** Planner artifacts committed by path (`1d14c7a`); pilot
  committed root docs (`d2e3423`, incl. brainstorm.md S3 edits). `origin/phase-0-foundation` =
  `d2e3423` (planner docs + P0 foundation + devSys Stream-A strawman). Durable thread now survives a
  planner clear. **Ops caveat (deltos not coord-opted-in):** clear-teammate's clean-tree gate sees
  the WHOLE shared tree → before any subordinate clear, all active streams commit WIP by path first,
  never `--force`. Clean baseline means only live stream WIP needs flushing at a clear boundary.
- 2026-06-16 — **🔔 Stream-B TRIP-WIRE FIRED — the safeguard worked.** secSys's FIRST conflict-engine
  audit found a REAL silent-data-loss race: client `syncEngine.ts` queue-drain deletes by `recordId`,
  wiping an edit that arrives DURING the in-flight push (→ note marked synced → next pull overwrites
  the local edit); and test 4 'edit-while-syncing' was **false-green** (asserted only `version>=1`).
  **Server CAS endorsed-correct by secSys** (PIN-SYNC-1/2 closed) — defect is entirely **client-side**.
  Per the standing trip-wire → **promoted Stream-B sync-correctness to opus.** devSys (only opus impl)
  was on the locked Stream-A bulk build, so the user approved a **NEW opus hand: `devSys2`** (online
  2026-06-16) — planner-endorsed. gruntSys committed a handoff checkpoint + moved to a non-correctness
  peripheral; secSys held warm for re-audit. **Fix scope:** client queue-drain + rewrite test 4 to
  assert *no-lost-edit* (not `version>=1`). **Validates the TDD-first + escalation-wire design
  (2026-06-15)** — the bug was caught at audit, before shipping, on the worst failure surface.
- 2026-06-16 — **devSys2 online** (opus) — Stream-B sync-correctness owner. Roster now pilot + 5:
  devSys (Stream A), devSys2 (Stream B), gruntSys (peripheral/handoff), gruntSys2 (Stream C),
  secSys (audit). See [[team-and-process]].
- 2026-06-16 — **iOS dogfood (user, real iPhone) — Stream-C functional gate PASSED.** IME/autocorrect,
  external-clipboard paste, nested-block selection all work on-device (the only-surfaces-on-device
  risk set). One cosmetic bug → gruntSys2: note **body is center-aligned, should be left**. Not
  blocking; quick CSS fix → then Stream-C iOS gate fully green.
- 2026-06-16 — **Editor UX → design-alignment fix (user).** Title was built as a SEPARATE input
  (can't Enter title→body, can't select across title+body, "feels like a web form"). Root cause =
  divergence from locked "title defaults to first heading." Fix routed to gruntSys2: **unify title
  as the first heading node in the one PM document** (Enter→body + cross-selection fall out; title
  metadata derives from the first heading; NO frozen-contract change). Load-bearing for the
  "effortless capture" thesis → do it in Stream C now. Banked in brainstorm §Spine + Phase-1 spec
  Stream C.
- 2026-06-16 — **Stream-B trip-wire CLOSED** (secSys): the queue-drain data-loss race is genuinely
  fixed AND the test genuinely reproduces it — **opus promotion (devSys2) vindicated; sync
  foundation VERIFIED correct.**
- 2026-06-16 — **Stream A HANDED OFF to pilot — Phase-1 critical path building.** Pre-handoff
  tree reconciliation (planner due-diligence): the surviving foundation = frozen contract incl. the
  already-closed discriminated-union `PrincipalVerificationSchema`, base64url codec, crypto core
  (keyDerivation/blob/keyStore), worker chokepoint stub. The full server-side **auth assembly is
  rebuilt FRESH from the approved design** (canonical TLV payloads + SignedRequest, worker
  authCrypto/authStore/D1 auth schema/routes/auth.ts, real `resolvePrincipal`, can() registry
  resolution, F13 hardening; client stepUp + KeyStore WebAuthn provider + recovery + QR). Corrected
  the stale "already built" framing in the stream-a-identity-plan memory; flagged stale `dist/auth/*`
  artifacts for purge. Sequencing: devSys's first move = secSys strawman of the per-method proof
  shapes (replay / freshness / pubkey-account binding) before locking outward.
- 2026-06-16 — **`AUTH-*` label canon ruling (planner).** `AUTH-PROP-1..4` adopted as the team
  shorthand for the four security *properties* (replay / freshness / pubkey-account / intent-scope-
  audience binding) — non-canon synthesis, each traceable to `F`/`PIN`. The bare `AUTH-1..4` handle
  is RETIRED; the four build-MUSTs it denoted (fingerprint=F2, timestamp-freshness, constant-purpose,
  ≥32-byte entropy) re-nest as named checks under the properties. Real canon stays F1..F13 + PIN-ID-1..9.
- 2026-06-16 — **Stream A design gate CLOSED; fan-out underway (all 6 subordinates active).** Rev-3
  wire shapes conditionally cleared by secSys (strawman `8d8dfb9`); devSys authStore + per-route
  contracts stable (`e3ebd75`, `docs/design/stream-a-auth-contracts.md`) — AUTH-1 freshness resolved
  at the SQL layer via epoch-millis instant-compare. Routing: devSys2 (D1 migration → authStore),
  scopeSys (route skeletons), gruntSys2 (WebAuthn provider vs secSys 6-point custody bar), gruntSys
  (acceptance harness landed `7e5c91b`, live F13 RED tests as devSys's TDD target), devSys (F13
  fail-open→fail-closed `guard()` flip, then canonical/requests as the foundational first build).
  **Next milestone:** canonical/requests land + secSys clears → flip handler bodies + stepUp live.
  No user-facing decisions outstanding.
- 2026-06-16 — **OPEN product obligation (security-clearance condition).** secSys cleared the no-PRF
  KeyStore baseline (PIN-ID-6, device-local fallback stores the wrapping key plaintext in IndexedDB)
  as ACCEPTABLE because PRF-first, ON two conditions: (i) honest D5-style UI disclosure when binding
  is device-local [OPEN — planner-tracked], (ii) stale code comment resolved [gruntSys2]. WebAuthn
  custody audit PASSED 6/6. (i) is a Phase-1 done-gate acceptance condition, ships with the
  enroll/unlock UI lane (trigger-bound, not dated). Durable: `[[keystore-noprf-ui-disclosure]]` +
  done-gate above. **Owner confirmed: gruntSys2** (hard acceptance condition on its client-identity
  lane); if the enroll/unlock screen is a distinct shell-UI surface, gruntSys2 carries the binding
  obligation to land with it.
- 2026-06-16 — **RULING: `deviceSigningPublicKey` stays in migration 0002 (path a), per D5/F1.**
  secSys MED found 0002 omitted the column three locked specs require (F1 strawman:174, D1
  proposal:40, secSys checklist E:152) — the **D5 pre-shaped per-device-key seam** the user accepted
  (keep the seam so per-device lockout is a NON-BREAKING Phase-2 add). Ruled **re-add the column now**
  (cheap: one nullable col, Phase-1, no data) rather than (b) reuse the single account
  `signingPublicKey` + revise the specs — (b) would force a differentiating migration in Phase-2 and
  thus **break the non-breaking guarantee D5 promised**. (a) preserves locked canon, so **no DECISIONS
  escalation / no spec revision**; record==reality restored by fixing the migration. **Escape hatch
  CLOSED with proof** (devSys2 + devSys concurring): one column CANNOT be non-breaking — per-device
  keys need the shared account key (→ `accountFingerprint`; PIN-ID-3 same-id-across-devices) AND a
  distinct per-device key coexisting; a single column makes `SHA-256(it)` differ per device and breaks
  same-id-across-devices. The two-column design IS the genuine D5 seam → (a) stands definitively.
  devSys2 re-adds the `deviceSigningPublicKey` + finding-4 CHECK constraints; v1 populates it
  = `signingPublicKey`. Locked specs intact. **FOLLOW-UP: column is NOT NULL** — flipped my earlier
  nullable default once it was explicit that v1 *always* populates it and Phase-2 always populates the
  per-device key (always-populate, not null-as-sentinel) ⇒ no legitimate null state; NOT NULL encodes
  the true auth-table integrity invariant and avoids null-coalesce logic; free to set now (Phase-1, no
  data). Reopener only on a concrete Phase-2 null-sentinel need.
- 2026-06-16 — **Stream A CF-1..CF-5 sign-off VERIFIED; one BOLA blocker → done-gate RED→green.**
  secSys verified all CF gates (PROP-3 server-resolved pubkey, R3-2 server-keyId single-sourced, F8
  audience-not-Host, F2 no-client-fingerprint, CF-5 chokepoint) BUT caught a **BOLA cross-account
  device-revocation hole** (revoke never checked target device belongs to the authenticating account →
  cross-tenant DoS; the 169-green suite missed it because every test was single-account). Fix = 404
  ownership guard + test (scopeSys) → secSys re-verify → done-gate-green. **Planner propagation:**
  root cause (single-account-blind tests) isn't unique to revoke — ordered a sweep of ALL object-id
  routes for account-ownership, and made **cross-tenant negative tests a STANDING bar** (gruntSys
  harness + scopeSys's Stream-D acceptance-gate checklist must include account-B-can't-touch-account-A
  → 404). **New acceptance condition tracked:** session token in-memory-only (see done-gate above).
- 2026-06-16 — **AUTH UI FRONT DOOR COMPLETE + dogfood-ready** (`b42737d`, gruntSys2): enroll / unlock
  / recover / qr-receive, the D5 disclosure render, F7 in-memory token (Zustand), PIN-ID-9 (RP-ID =
  hostname), 131/131. Dev server live for iOS dogfood at the Tailscale `:8449` URL. can()-routing
  restructure secSys-DEFERRED (secure direct-gate v1 + dead-code note — NOT a done-gate blocker).
  Two user-facing passes now OPEN with the user: (1) D5 disclosure COPY approval (draft delivered,
  my 2 tweaks recommended), (2) real-iPhone dogfood of the front door. **Stream A = one BOLA fix from
  done-gate-green.**
- 2026-06-16 — **Stream A auth DONE-GATE GREEN** (BOLA revoke fixed `9fee9f8`, 21/21; secSys
  re-verified). **BUT a new systemic finding → `DECISIONS.md` D6:** the data layer has **no account
  dimension** — `notes` has no `accountFingerprint`, data + sync routes don't isolate by account, and
  whole-workspace `note.search` returns all accounts' notes. Confirmed first-hand. Severity hinges on
  tenancy (single-account-per-deploy ⇒ non-issue; shared multi-account ⇒ CRITICAL). Taken to the user
  as **D6** with my recommendation (build the account dimension regardless). secSys + devSys held for
  the follow-through; **the fix MUST precede any multi-account deploy.** Same BOLA class as revoke but
  data-layer-wide, and no owner column exists for the per-route 404 pattern. Tracked:
  `[[cross-account-data-layer-finding]]`.
- 2026-06-16 — **D6 RESOLVED (user): BUILD the account dimension + ADD usernames.** Coupled decision:
  usernames are for future auth-method flexibility, which requires a **stable, credential-INDEPENDENT
  account identity** → the data dimension keys on a random **accountId**, NOT `accountFingerprint`
  (credential-derived). **Rescopes** the `tenancy-grant-account-relative` fix. Model = separate
  ACCOUNT (immutable accountId + unique username alias → accountId) from CREDENTIAL (v1 = signing
  key/fingerprint; future add/replace). Notes/notebooks/grants key on accountId; every data+sync query
  filters by it. Tradeoff: username namespace = server-arbitrated uniqueness (slight move from pure
  self-sovereign). Expected additive to the frozen `PrincipalVerification` union — devSys/secSys
  confirm. **Design-first → build on accountId.** Gates devSys2's Stream-D too. Tracked:
  `[[account-identity-model]]`. D5 copy approved (ship with the PRF-claim accuracy tweak).
- 2026-06-16 — **Account-identity strawman SIGNED OFF (planSys); build wave authorized.** Strawman
  (`docs/design/account-identity-strawman.md` + secSys sweep) honors the user goal + all 4 assumptions;
  frozen contract ratified **ZERO-DELTA RE-POINT** (`Principal.id` + `grants.principalId` re-point
  `accountFingerprint`→`accountId`; union AND `PrincipalSchema` byte-for-byte untouched; NO new field, NO
  new `grants.accountId` column — supersedes my first add-a-field wording; stronger no-reopen + inherently
  fail-closed since `id` is always-present). 3 binding conditions: audit every `principal.id`/
  `grants.principalId` reader (rewire credential-needing sites to `mintedByKeyId`/`devices`); a SEMANTIC
  test (`principal.id==accountId` end-to-end) guarding the false-green not just the schema freeze; two-account
  negative tests prove isolation through the re-pointed id. Rulings: keep `accountFingerprint` as credential
  id; additive tables only (`accounts`/`accountCredentials`/`usernames`/`notes.accountId`); username rename v1 OFF; enumeration-oracle
  mitigation a build requirement (prefer authenticated-claim-only); HARD invariants — ownership keys on
  accountId/signing-key never username, and any credential/username (re)bind to an existing account needs
  possession proof; S5 migration atomic 1:1 + code-together, back-fill dev notes to the single account,
  must precede any multi-account deploy; document username-loss ≠ data-loss. Build = data dimension on
  accountId + cross-account fix + accounts/accountCredentials/usernames + notes.accountId + the
  grants.principalId re-point (NO new grants column) + sync scoping (unblocks devSys2 Stream-D) +
  two-account negative test class; fresh secSys build-audits.
- 2026-06-16 — **DEFERRED to Phase-2 (capability-gated, tracked): the add/replace-credential endpoint.**
  v1 ships the account/username/credential FOUNDATION + bind-once/append-only invariants. The actual
  endpoint that binds a NEW signing key to an EXISTING account — the mechanism that *performs* the user's
  "change auth methods later" goal — is deferred: it needs a **new AUTH_PURPOSE in the FROZEN
  `canonical.ts` step-up codec** (current TLV can't bind a new credential pubkey), a frozen-contract
  change requiring a secSys design pass + planSys sign-off. **No date; needed before real
  multi-device-add / auth-method-change ships.** Lands as a non-breaking drop-in (accountId is stable —
  no data migration). Tracked: `[[account-identity-model]]` §Phase-2-follow-up.
- 2026-06-16 — **Cross-account fix landed GREEN (pending secSys done-gate); devSys2 → Stream-D sync-auth.**
  accountId scoping in `mutate.ts`/`index.ts` (`303db9a`) + `sync.ts` (`dd86704`); gruntSys two-account
  isolation **10/10 GREEN** (pull B→0, push B→conflict) — condition #3 demonstrated; full worker suite
  **200 pass.** secSys runs the done-gate audit (6-point + condition #1 reader-audit + #2 semantic test +
  hard gates); **'done' HELD until secSys signs.** devSys2 confirmed onto **Stream-D sync-auth** (the
  authenticated-synced-notes critical path): (a) client Authorization header on push/pull now; (b) retire
  the Phase-0 unverified `resolvePrincipal` stub after the username chunk (avoid auth.ts contention) —
  **keep the F13 prod tripwire as defense-in-depth post-retirement.**
- 2026-06-16 — **CONVERGENCE phase begun — spare hands on proving/assembling the simple-v1.** As the
  server build wraps, 3 spare hands directed at distance-to-v1: **gruntSys → the e2e done-gate test
  harness** (full loop enroll→note→authed sync→recover→present, + offline path; written now as the target
  spec, RED ok); **gruntSys2 → client note↔account binding** (ungated) then the **username-claim UI** at
  enroll (F-acct-4 authed-claim, no availability oracle; gated on devSys's endpoint contract); **scopeSys
  → the v1 done-gate acceptance checklist.** Username surface = pilot's rec, scoped/sequenced. All
  contention-free. The e2e harness is now the executable definition of "simple v1 done."
- 2026-06-16 — **✅ DONE-GATE PASS: cross-account / account-identity re-point (task 12 core).** secSys
  independent audit cleared all 3 conditions + 6-point scope (#1 reader-audit 9/9, #2 semantic test 7/7,
  #3 isolation 10/10 — every object route cross-account-denied). **The original CRITICAL cross-account
  finding is CLOSED** at the data-layer scope. **Step 1 of the simple-v1 path is done** (pending a
  route-mint false-green one-assertion guard now landing + secSys re-verify). Deferred (tracked): re-key
  **`notebookSyncSeq` PK → (accountId, notebookId)** tied to NOTEBOOKS-FIRST-CLASS, before serious
  multi-account scale (weak write side-channel/contention, not a disclosure — conscious-accept for v1).
- 2026-06-16 — **✅ SYNC-AUTH WORKS END-TO-END (simple-v1 step 2 done).** devSys2 `a52f638`:
  authenticated push/pull, F7 in-memory bearer, F13-gated, 133 green. Stream-D (b) `resolvePrincipal`
  stub-retirement DEFERRED as optional hardening (already-real + F13-contained = no live prod gap; keep
  F13 belt; small post-username devSys item, tracked). devSys2 + gruntSys now driving the e2e done-gate
  harness's sync round-trip + offline scenarios green = **step 3 (assembly) in progress.** Net: steps 1
  (cross-account, pending the one assertion + re-verify) + 2 (sync-auth) essentially done; step 3 active;
  remaining v1 unknown = the iPhone dogfood.
- 2026-06-16 — **Client note-binding ruling: key on `accountId`, not `accountFingerprint`.** gruntSys2's
  first cut bound local notes to the credential-derived fingerprint (deviation from strawman §4). Ruled
  REBIND to accountId now (1 commit old) — fingerprint-binding would reintroduce the credential-coupling
  on the client and force local-note migration when add/replace-credential ships (the exact pain accountId
  removes; the user's whole reason). Server returns accountId in the session/identity response (non-secret,
  §4); client uses it for LOCAL tagging only — server stays authoritative (stamps from
  `principal.accountId`, never client-trusted, §5.3/F2). Consistency of secSys invariant-(i) across layers.
- 2026-06-16 — **✅ v1 SERVER DONE-GATE GREEN (step-3 signal MET, server slice).** `v1.donegate.test.ts`
  **14/14** — full journey proven: enroll → create → authenticated sync → 2nd-device recover (same seed →
  SAME accountId) → note present + content-match (DGT-1 round-trip / DGT-2 same-key re-enroll reuses
  accountId / DGT-3 offline reconcile / DGT-4 F13 prod-gating / DGT-5 capstone). Worker suite **231/0**;
  cross-account isolation **11/11** incl §J false-green closed. **Integrity note:** DGT-2 green = the
  FOUNDATION's accountId re-point holding (shipped `d9d6803`), not a late patch — devSys ground-truthed it;
  gruntSys confirms the DGT-2 assertion is STRICT, secSys spot-confirms the harness exercises the real path
  (anti-false-green). **Remaining v1 = the client/device half + the iPhone dogfood + the re-verifies.**
- 2026-06-16 — **Cross-account done-gate CLOSED (secSys §J) — task 12 fully done; DGT-1..5 all green.**
  Integrity: DGT-2 was **never observed-RED** — gruntSys mis-PREDICTED the gap (misread same-key re-enroll
  as unimplemented); the foundation (`d9d6803`) worked from the first real run. Now airtight: strict
  assertions + an explicit `COUNT(accounts)=1` + secSys real-path audit. **v1 finish line:** [SRV] CLOSED;
  client Tier-A auto-suite (devSys2) building; **Tier-B iPhone dogfood (mine) is the LAST v1 gate** —
  scopeSys 8-step runbook ready (`282cca7`). **Spare-hands ruling — REINFORCE v1, don't open new scope:**
  devSys → pre-dogfood readiness-harden (iOS WebAuthn legs per PIN-ID-9 + no-PRF render + graceful
  WebAuthn error-handling + confirm :8449 = current build); scopeSys → DG-CAP gate-record scaffold +
  records reconciliation. **HELD to post-v1:** stub-retirement, add/replace-credential (needs my
  AUTH_PURPOSE sign-off), all post-v1 features. Next substantive slice = post-close, with a user steer on
  Phase-2 priority.
- 2026-06-16 — **Capstone FIDELITY ruling: the RECORDED DG-CAP runs against a PROD-REPRESENTATIVE build,
  not the dev server.** Readiness check found `:8449` was a stale dev server (predated the accountId
  rebind / session-exposure / Dexie-v3 / SW changes) AND dev-mode allows the unverified `LOCAL_OWNER`
  fallback — so the auth / F13-gating / QR-block legs would **false-pass on dev** (same false-green class,
  deployment level). Split: refreshed dev build (HEAD `b98bf3d`) = early iOS-WebAuthn-UX smoke test
  (de-risk, NOT recorded); the **recorded capstone = a prod-MODE worker (`ENVIRONMENT=production`, F13
  active, no unverified fallback) + prod client, all 8 steps on one build.** Pre-capstone gate: confirm a
  RETURNING/installed device survives the Dexie-v3 migration + SW (not just fresh install). scopeSys to
  add the prod-representative requirement to the runbook preamble. User held until pilot's GO with the
  prod URL/SHA + which-steps-ready.
- 2026-06-16 — **POST-v1 slice planned (user req): Cloudflare deploy for live testing.** Worker API +
  prod D1 (create + migrations 0000-0003) + PWA hosting, **same-origin recommended**, **prod-mode**
  (`ENVIRONMENT=production`, F13 active, no unverified fallback), `AUTH_AUDIENCE` = live origin. WebAuthn
  **RP ID = the live domain** (Tailscale-domain passkeys don't carry over → fresh enroll, expected;
  PIN-ID-9). PIN-STORAGE-1 holds; `workers.dev` for first testing (custom domain later). D6 makes it
  multi-account-safe. **Sequence: AFTER v1 closes.** Box has a wrangler key; standing-auth covers the
  deploy. **Cheap-now prep** (folds into the capstone's prod-client build): confirm the client API base
  URL is env-configurable, so the deploy is near-turnkey. Tracked: `[[cloudflare-deploy-plan]]`.
- 2026-06-16 — **v1-BLOCKER caught by the prod-representative push (early smoke HELD + retracted):**
  migration `0003` used `CREATE TEMP TABLE`, which D1's migration authorizer REJECTS (`SQLITE_AUTH`) →
  `wrangler d1 migrations apply` FAILS on real D1. The test path (better-sqlite3, no authorizer) MASKED
  it — a false-green AT THE DEPLOYMENT LAYER, exactly what the prod-representative capstone ruling exists
  to catch (and a vindication of it). devSys committed the one-line fix (scratch table, identical
  `CHECK(n<=1)`); secSys eyeballing. **Early-smoke + capstone HELD until an ACTUAL end-to-end enroll
  works against the worker's D1.** Banked invariant: validate migrations against REAL D1 (wrangler), not
  just better-sqlite3 ([[cloudflare-deploy-plan]]).
- 2026-06-16 — **v1-blocker FIXED (`f8f96ce`, scratch table — all 4 migrations apply clean on real D1);
  early UX smoke RE-GREENLIT + sent to the user.** Verified functional: /challenge 200 on live D1, F13
  no-bearer→503, bad-sig→401, donegate 14/14 on the same app+migrations the worker runs. **Recorded-
  capstone TARGET DECIDED (accepted): local `wrangler dev` `ENVIRONMENT=production` over Tailscale, NOT a
  CF deploy** — F13 keys on ENVIRONMENT so prod auth is identical; lightest valid prod-representative
  target; keeps v1-close decoupled from CF (CF = the post-v1 live-test env). Recorded-capstone GO pending
  the prod client build + clean SHA + secSys migration-guard eyeball.
- 2026-06-16 — **SERVER SLICE FULLY VALIDATED; early-smoke FINAL GO sent.** Live HTTP enroll confirmed
  all-green on the prod-mode `:8787` worker (register/session/recover → SAME accountId, replay→401,
  wrong-audience→401). secSys §K verified 14/14; **ALL D6/v1 security threads CLOSED; cross-account
  done-gate CLOSED.** Early UX smoke (dev client `e92dc7b` + prod-mode worker = real auth) sent to the
  user as the verified, caveat-free GO (after two prior GO/hold whiplashes — relay policy now: forward a
  GO only on an UNCONDITIONAL signal). **BOTH URLs now ready — full clean final GO sent:** smoke `:8449`
  (dev client) → recorded **DG-CAP capstone `:8451`** (prod client dist `55e438d` + prod-mode worker, F13
  active; live round-trip persist confirmed — accounts=1/credentials=1/notes-scoped=1). devSys's
  concurrent safety net flags instantly on any live-worker break. **This is THE v1 capstone run.**
- 2026-06-16 — **Automatable v1 done-gate FULLY PROVEN — v1 now hinges SOLELY on the on-device capstone.**
  Tier-A `[CLI]`-auto **13/13** (devSys2, zero prod gaps) joins server done-gate 14/14 + all-security-closed
  + live-prod-worker-validated end-to-end. Only the **Tier-B iPhone dogfood** (mine, with the user) is open.
  Team validated + standing by per-area (devSys2 client/sync/offline/recover fixes, gruntSys regression
  pins, devSys live-worker/safety-net, secSys security, scopeSys gate-record → `v1-dg-cap-gate-record.md`,
  prod-MODE=YES). Capstone GO sent (smoke `:8449` + recorded capstone `:8451`).
- 2026-06-16 — **DOGFOOD found a v1-BLOCKING UI gap (the capstone earning its keep):** no way to **exit
  or save a note** from the editor — user stuck in the editor, can't navigate steps 4→8. Need an editor
  EXIT (done/back) → a note LIST/home (save = autosave via the reactive store; the gap is navigation + a
  list, not persistence). Routed to gruntSys2 (HMR); fix must reach the `:8451` prod client build for the
  recorded run. **Lesson:** the automated gate (14/14 + 13/13) drives the store programmatically, so it
  CANNOT catch a missing UI-navigation affordance — "automatable gate proven" ≠ "usable"; the on-device
  capstone is the only thing that catches shell-completeness gaps. v1 NOT done until this lands + the
  capstone re-runs.
- 2026-06-16 — **Capacity ruling: devSys2 → client storage next, then Stream D (gated).** devSys2
  delivered its Stream-A lane (migration 0002 + authStore, secSys STRONG PASS). Ruled: after its short
  tail, release to **client storage** (reactive query + persistence layer over IndexedDB, the
  pluggable store seam, retire the `notebooks` localStorage stub) — UNBLOCKED, done-gate-critical, zero
  file-contention with devSys's active chokepoint work. **Stream D (sync-auth integration: wire
  /api/sync to the real grant token + authorized/rejected/revoked gate) is devSys2's NEXT chunk AFTER
  client storage, GATED on devSys's chokepoint being green** (resolvePrincipal still the stub in-tree
  today). Net: devSys + devSys2 run in parallel without collision, converge on Stream D at the lock.
- 2026-06-16 — **gruntSys2 → enroll/unlock/recovery UI surface (Phase-1 done-gate front door).**
  gruntSys2 completed the client identity logic lane (`12401b1`, ceremonies + QR-join + D5 seam,
  131/131 green). Next chunk confirmed: the user-facing enroll/unlock/recovery screens — wires the
  ceremonies to real UI, hits the auth endpoints (built against the LOCKED contract; e2e-green still
  gated on the chokepoint), and **discharges the D5 disclosure RENDER as a hard acceptance criterion**
  (device-local binding ⇒ honest-limitation disclosure). iOS dogfood is load-bearing here (PIN-ID-9:
  hostname RP ID, WebAuthn = first await, Safari↔PWA RP-ID match). **Two user-facing items I'm
  tracking:** (a) the D5 disclosure COPY → I bring the drafted wording to the user for a quick approve
  (security-honesty / own-your-software voice); (b) a real-iPhone dogfood pass of this surface, like the
  earlier probes — I coordinate both. Neither blocks the build start.
- 2026-06-16 — **Stream A AUTH CORE COMPLETE** (chokepoint `df26f6d`): real async `resolvePrincipal`
  (Bearer → hashToken → grant) + `can()` enforcement, CF-5 satisfied (numeric `expiresAtMs` +
  `revokedAt`), 150/150 worker green. devSys's entire keep lane (canonical/requests + authCrypto +
  chokepoint) done + green. secSys running end-to-end CF-1..CF-5 verification; scopeSys finishing the
  CF-gated route handlers; **green end-to-end AUTH PATH imminent.** Consequence: **devSys2's Stream-D
  gate (chokepoint green) is now effectively open** — it finishes its tail → client storage → Stream D.
  Next milestone: first green e2e auth path + secSys CF sign-off.
- 2026-06-16 — **🧭 COURSE-CORRECTION (user-led; team PAUSED).** Mid-dogfood, the user called a halt:
  the recent E4 thread had drifted into piling auth machinery (PRF / disclosure-copy / Option-A/B /
  session-re-auth) **into the launch path**, which violates the LOCKED architecture (`KICKOFF` §Locked:
  *"Render-before-data"*, *"Offline auth must not block launch"*, *"stale-while-revalidate reads"*).
  Confirmed against the roadmap: the user's recalled model (online-first, local-first quick load, sync
  in background, fork/duplicate on conflict) tracks the locked arch **verbatim** — so the build drifted,
  the doc didn't. Corrected direction has TWO coupled parts:
  **(1) SHELL/LOAD (drift-correction):** render notes from the local store IMMEDIATELY on launch; auth +
  sync run in the BACKGROUND after the UI is up; recovery-phrase screen = a non-blocking nudge / sync
  status, NOT a boot gate. ONLY genuine first-run (no local data) or post-clear-browsing-data (no local
  key) is a blocking auth screen. This is the PROPER E4 fix; the durable-keyId fix (`2d629a6`) stays as a
  correctness fix underneath but is no longer "the answer."
  **(2) SYNC/CONFLICT = option A (user-decided), conflict-as-version:** online → changes sync near-real-time
  (debounced push per edit); offline → edits buffer + sync on reconnect; on reconnect, if the server copy
  (source) advanced beyond the base version this device last synced → the divergent offline edit is
  **RETAINED as a conflict VERSION of the SAME note** (same note ID), never lost. **Revises PIN-SYNC-4**
  (no more new-ID sibling fork → kills the contrived duplicate-note AND fixes the relation-orphan problem,
  since the note keeps its ID so inbound relations stay valid) **and PIN-SYNC-3** (offline edit vs
  server-delete → retained conflict version, same non-loss principle). v1 surface = MINIMAL non-blocking:
  a conflict indicator on the note + view-the-other-version + resolve (keep-mine / keep-theirs / keep-both);
  **full version-history timeline/browse UI DEFERRED to Phase 3** (whole-note-snapshot grain per S2;
  per-block history stays Phase 3, block-IDs already preserved for it). **Reuses the audited Stream-B
  no-lost-edit core** (both sides already retained correctly — the hard half is done) + the
  version-counter/`expectedVersion` CAS for conflict detection. **Reconcile UX RESOLVED (user):**
  non-blocking **toast on conflict** + **persistent badge** on the note + open→view→resolve
  (keep-mine/keep-theirs/keep-both; keep-both = both retained as versions of the one note, explicit
  "duplicate to new note" for a true split). **SPEC WRITTEN + HANDED OFF:**
  `docs/specs/v1-shell-and-conflict-versions.md` (SPEC-READY → pilot). Team re-plans off this spec; the
  PRF/disclosure/Option-A-B/autoUnlock work is re-scoped under it (disclosure stays at enroll, out of the
  launch path; secSys re-confirms; planSys still owes the disclosure copy-approval).
- 2026-06-16 — **✅ OPTION-A CONFIRMED (user) + the auth-friction NORTH STAR.** User affirmed Option-A for
  v1: device-local signing key on ALL devices (incl. PRF-capable), no-gesture unlock (lock-screen-grade at
  rest), uniform honest disclosure at EVERY credential-establishment path (enroll/recovery/QR-join),
  **PRF-at-launch RETIRED** (seam kept dormant for v2 E2EE/export). Unlocks **1b** (silent background
  re-auth). secSys: PRF retirement is a HARD PROTOCOL FACT (WebAuthn UV gesture required to derive a
  PRF-bound key → incompatible with silent re-auth), not a preference; full v1 retirement safe (no at-rest
  secret needs it — mnemonic shown-once-never-stored). **🌟 GUIDING PRINCIPLE (user, quotable, governs all
  future auth/onboarding decisions):** *"Auth is for syncing between devices and signing in on a new
  device. Day-to-day can't be locked behind a password. This is a Notes app, not a password manager."* →
  auth/friction belongs ONLY at sync-trust + new-device onboarding; day-to-day open-and-use is ZERO
  friction. Validates 1a (`cd61fae`, local-first shell — E4 closed properly) + the conflict-as-version
  direction. Tracked: `[[auth-friction-philosophy]]`. **Part 1a DONE; 1b greenlit; disclosure copy redraft
  (uniform lock-screen-grade) routes to planSys for approval.**
- 2026-06-16 — **✅ COURSE-CORRECTION COMPLETE + VERIFIED (HEAD 75b58db, tree clean).** Both parts shipped
  + security-cleared (both secSys audits PASS; devSys2+gruntSys verified in-code, not hearsay): client
  **225/225** (conflictVersion 18/18, syncEngine trip-wire **8/8 no-lost-edit intact**, cadence CAV-1/2
  0-RED, disclosure render 13/13) + worker Tier-A **12/12**. Shipped: 1a local-first shell (E4 closed
  properly), 1b silent background re-auth (Option-A device-local, rewrap-on-next-unlock, honest disclosure
  at enroll/recovery/QR-join + one-time migration notice), Part-2 conflict-as-version (toast + persistent
  badge + keep-mine/theirs/both, no sibling-note fork, relations stay valid). Disclosure copy = my
  synthesis (warm + honest; secSys ship-confirmed). **Post-green chain EXECUTING:** batch-clear the 3
  parked sessions (devSys/scopeSys/secSys) → hand the **Cloudflare LIVE deploy** to devSys2 (single-owner,
  gated: migrate-vs-real-D1 + env API base + clean SHA) → live URL → the user's **load-sensitive
  real-device re-dogfood**. CF deploy pulled FORWARD from post-v1 (user 2026-06-16: live-hardware load
  testing is first-class for this load-sensitive app; Tailscale can't represent real edge/cellular; DB-safe
  — code deploys don't touch D1, migrations additive/forward-only, local-first replica survives a reset).
- 2026-06-17 — **🎉 LIVE LOAD-FEEL = WIN + 🎯 NEXT MILESTONE defined (user).** On-device the user calls the
  experience *"incredibly good"* — load/upload times **BEAT APPLE NOTES on their iPhone.** Validates the
  whole local-first / render-before-data / course-correction bet; load-time-sensitivity goal MET on real
  hardware. P1 phantom-conflict ALSO user-confirmed gone (online/offline/offline-mid-edit). **🌟 NEW
  STANDING VALUE — PERFORMANCE/ANTI-BLOAT (user, governs all future work):** *"make sure things don't get
  bloated and slow down as we layer features on"* — the beat-Apple-Notes load bar must HOLD; no feature
  ships if it regresses the load-feel; lean bundle + instant-load intact. Tie-breaker like the auth-friction
  north-star. Tracked: `[[performance-is-a-standing-value]]`. **🎯 NEXT MILESTONE (user-defined) — "BASIC
  NOTES, day-to-day usable":** full usable login · password recovery · edit settings · create / delete /
  edit / view notes · view note **HISTORY** · MAYBE basic in-note editor tools. *"Nail that → usable day to
  day, then layer features as we go."* REFOCUSES the near-term roadmap: harden the Phase-1 slice into a
  genuinely daily-usable basic-notes app BEFORE the old Phase-2 (notebooks/decoupling/plugins). **Status
  read (confirm w/ team inventory):** ✅ login / create / edit / view = DONE; 🔶 password-recovery (phrase
  works; needs 2nd-device validation + recovery-screen fixes: dead "recover-with-passkey" button, clean
  phrase copy, download/print) + DELETE-notes affordance (+trash?); 🆕 EDIT-SETTINGS surface, note-HISTORY
  browse/restore UI (**pulls the deferred Phase-3 version-history FORWARD** onto the conflict-as-version
  data model already built), basic EDITOR-TOOLS (formatting; "maybe"). **Interpretations to confirm:**
  history = per-note version timeline view/restore; settings = account/username + sign-out + appearance +
  app-info (minimal); editor-tools = bold/italic/headings/lists/checkboxes; **MARKDOWN-LIGHT = IN-SCOPE for v1 (user-confirmed
  2026-06-17), built WITH the editor tools (not deferred):** inline ProseMirror input-rules (type `# `→
  heading, consumes the marker), NOT stored-as-markdown, NO preview pane, toggle-able "Markdown mode";
  same formatting substrate as the toolbar, shortcuts are the primary mobile input. Distinct from
  export-to-markdown (Phase-3 output). Validate input-rules on-device + integration w/ block-ID plugin +
  unified-title at spec time. **NEXT:** team build-status
  inventory → planner writes ORDERED specs → hand to pilot AFTER the in-flight dogfood fixes (clean-copy,
  dead button, conflict-screen-on-exit, onboarding-refinement, autofocus) settle.
- 2026-06-17 — **🆕 SWIPE ACTIONS on the note list (mobile) — SPEC-READY → pilot.** User handed a
  feature-export packet (`_inbox/SWIPE_ACTIONS_EXPORT.md`, from TRKR) and asked for iOS-Mail-style swipe
  rows on the note list, mobile-first. Spec: `docs/specs/swipe-actions-note-list.md`. **Decisions (user):**
  (1) **swipe RIGHT verbatim** — soft swipe reveals **Copy + Delete**, hard fling commits Delete with the
  stretchy-delete feel; (2) **swipe LEFT reserved** (future Pin / other — seam only, no action v1); (3)
  **mobile only** for now (desktop keeps tap-to-open). **Delivers the milestone's missing DELETE
  affordance** + a duplicate. **Architecture call (planSys, perf standing-value):** NO framer-motion / no
  new dep — hand-roll with Pointer Events + imperative CSS-transform (no re-renders during drag) + CSS/rAF
  snap (~150–200 LOC, ~0 bundle delta); the packet is a **behavioral reference only** (React 18 +
  framer-motion → our React 19 + hand-rolled CSS forces a rewrite; reuse-discipline). **Key build nuance:**
  the existing `deleteNote()` is a hard local delete with NO enqueue (it applies *server* tombstones) — a
  user swipe-delete needs a NEW **sync-correct soft-delete+undo** path (mark `deletedAt` + enqueue,
  mirroring `putNoteAndEnqueue`; undo = resurrect) → Lane 1 = devSys2/devSys (data, regression-tested
  against REAL D1 per `[[d1-rowswritten-index-inflation]]`), Lane 2 = gruntSys2 (gesture/UI), secSys light
  account-scope confirm. Perf-budget gate on hand-back (report bundle delta; load-feel must hold).
  **→ 🚀 SHIPPED LIVE (2026-06-17, @fc11051, version c6c5d394) on https://deltos.blackgate.studio.**
  Final storage model = **Fork P** (a reserved system-key `sys:trashedAt` in the note PROPERTIES bag — the
  ONLY sync-correct simple vehicle, since `noteVersions` is client-only/unsynced; rides the P1-hardened
  `updateNote`/`rows_written>0` CAS, ZERO migration, no op-verb — @e4ad1ad op-enum reverted). The trash
  marker lives under a **reserved system-namespace** (hidden from property UI + excluded from md/frontmatter
  export NOW + not user-editable). Delete is **sticky + recoverable** (undo toast immediately, or the
  **Trash view** via footer link); duplicate works. **PERF BUDGET PASS** (perf standing-value held):
  served JS 233.6 KB gzip, **+~8.6 KB raw whole-feature / single-digit-KB gzip, NO new dependency**
  (hand-rolled gesture, no framer-motion), load-feel unchanged. **OPEN:** (a) on-device FEEL-TUNING relay
  (planSys ↔ user; thresholds SNAP_OPEN=60/FAR_RIGHT=240/OPEN_RIGHT=120 + easing → gruntSys2); (b) real-D1
  trash round-trip (SA-T5/T6) exercised live by the user's session; (c) **swipe LEFT action still
  reserved/undecided** (Pin candidate). **Decision arc (storage):** F(version-record)→P(props)→F1(synced
  column)→**P(props+reserved-namespace)** — converged once devSys verified noteVersions doesn't sync + the
  history-bonus was void; P won on anti-bloat + reuse-of-hardened-D1-path + the user's own "special tag"
  model. **Process correction (user, firm):** push-when-ready is STANDING — ready+green+non-destructive
  ships proactively, no per-deploy greenlight ([[standing-authorization]]); only genuine data-safety gates
  a push (here: the interim deletedAt-delete didn't stick online + would resurrect → shipped complete Fork P
  instead).
- 2026-06-17 — **🔐 AUTH-MODEL PIVOT DECIDED (user, firm) — drop passkeys; go username+password.** The user
  finds the passkey / secret-key / QR model "opaque and unpleasant" and is pivoting the login path to:
  **username + password** primary credential, **optional TOTP 2FA**, **recovery phrase demoted to a
  forgot-password reset token** (no longer the crypto root). **CONTAINED to the auth/identity layer** —
  notes / sync / conflict-as-version / editor / swipe+trash are orthogonal and UNTOUCHED. **SUBSUMES the
  QR-finish task** (new device just logs in — no QR display/scanner needed; QR-join, passkeys, signed-
  challenge, Option-A custody, PRF seam all RETIRED). **Three design calls CONFIRMED (user, "yes to all"):**
  (1) day-to-day stays UNGATED — password is for sync / new-device / reset only, never an app-open prompt
  (preserves the [[auth-friction-philosophy]] principle; only the MECHANISM pivots passkey→password);
  (2) at-rest local notes rely on device/OS + browser-sandbox security for v1 (E2EE deferred to v2 — the
  wrapped-blob custody is dropped); (3) recovery phrase = a high-entropy password-reset token, not the seed.
  **KEY OPEN TENSION for the scope pass:** passkeys gave ungated-reload "for free" (durable device key →
  silent signed-challenge re-mint, no token at rest, honoring [[session-token-in-memory-only]]). Password
  has no durable device key → ungated-reload needs a DURABLE SESSION/REFRESH mechanism (httpOnly secure
  cookie same-origin? refresh token in IDB?), which RE-OPENS the token-at-rest secSys condition — secSys
  must resolve. **HONEST TRADEOFF (logged):** passwords are familiar but reintroduce phishing / reuse /
  server-side-hash-custody risks passkeys avoided; optional 2FA mitigates; defensible for a notes app,
  eyes-open. **NEXT:** planSys commissioned a devSys (build-scope: reused-vs-rewritten across `auth/store.ts`,
  `identity/*`, `routes/auth.ts`, enroll/unlock/recover/qr routes, worker challenge/session crypto, the
  frozen auth contract) + secSys (security model: Argon2id hashing + rate-limit + 2FA + reset-phrase binding
  + the ungated-reload-vs-token-at-rest resolution + at-rest posture) SCOPE PASS → estimate back to user →
  spec → build. Migration = clean re-enroll (dogfood-only, no data migration). Supersedes [[stream-a-identity-plan]],
  Option-A custody, PRF, QR-join.
