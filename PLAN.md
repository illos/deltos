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
| A | Identity (passkey/recovery/QR, signed-challenge auth) | devSys (opus, re-tasked fresh post-clear) | auth union + `can()` **LOCKED** (`1cfaf3e`); bulk backend build |
| B | Substrate + sync (atomic-CAS conflict engine) | **devSys2 (opus, online)** — gruntSys on a non-correctness peripheral meanwhile | 🔔 trip-wire fired → opus; server CAS endorsed-correct; fixing client queue-drain race + false test |
| C | Capture surface + editor (ProseMirror) | gruntSys2 (sonnet) | iOS functional gate **PASSED** (user dogfood: IME/paste/nested-selection OK); 1 cosmetic fix pending (body center→left-align) |
| D | Integration / e2e | pilot | pending A+B+C |

**Done-gate:** install PWA → unlock w/ passkey → create/edit offline → sync; recover/QR-join 2nd
device; forced conflict → fork not lost-write. secSys audits each stream; **Stream-B trip-wire** =
promote to devSys/opus if first audit finds a CAS/single-flight/race defect.

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
