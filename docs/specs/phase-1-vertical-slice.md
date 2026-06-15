# Spec — Phase 1 vertical slice (the thesis-prover)

**Phase:** 1 · **Status:** SPEC-READY (drafted at STAGE A off S1+S2) · **Handoff gate (STAGE B):**
P0 DONE + secSys-cleared · **Audit:** secSys on each chunk, hardest on the conflict engine + auth.

> **This spec is the integration of two cleared spikes + their audits.** All pinned constraints
> live in `docs/specs/phase-1-constraints.md` and are referenced here by tag (PIN-ID-*, PIN-SYNC-*).
> Read that file alongside this one — it carries the *why* and the exact mechanics; this is the
> buildable decomposition.

---

## Goal
The end-to-end thesis-prover: **install the PWA → unlock with a passkey → create/edit a note
offline → watch it sync** — all on clean deltos-native code, on the server-readable (D1, trkr-
derived) stack. One capture surface, the real spine, real sync with fork-on-conflict, real
passkey/recovery/QR identity. **Done when** that sentence is literally true on a device.

## Why this shape
This is the first slice that exercises substrate + spine + sync + identity + one surface together —
the minimum that proves the surface/substrate decoupling is real and the sync/identity foundations
hold. Everything here is load-bearing for every later phase, so correctness > breadth.

## Editor engine — DECIDED: **ProseMirror (direct)**
Rationale in `phase-1-constraints.md` §Editor. The spine is PM's node model; `NodeView` is the
plugin-island seam; PM Steps is the promote-to-DO collab path. Phase 1 builds the **collab-seam
*design*** (stable block IDs as node attrs + a documented PM-Steps→DO mapping), **not** collab
itself. *(LOCKED — user-confirmed ProseMirror, no veto, 2026-06-15. TipTap remains the fallback
only if raw-PM velocity later proves untenable.)*

---

## Workstreams

The slice decomposes into four streams that integrate at the end. **A (identity)** and
**B (substrate+sync)** are independent and parallelizable; **C (surface/editor)** depends on the
spine types (from P0) and consumes A+B; **D (integration)** stitches them.

### Stream A — Identity (passkey + recovery + QR), ~5–7d
Build deltos's always-on, **email-free** identity layer as a clean rewrite of full-beans custody
(S1: lift-with-surgery; reuse *understanding*, not files — packet is
`_inbox/SECURITY-STORAGE-SYNC-EXTRACTION.md`). Interfaces: `KeyDerivation`, `KeyStore`,
`DeviceRegistry` (S1 §3 shapes, rewritten deltos-native).

**Hard requirements (all from `phase-1-constraints.md`):**
- **PIN-ID-1:** `Identity.id` is an identifier, NEVER an authenticator. Server must not authorize
  any read/write on `id` alone.
- **PIN-ID-2:** request auth = **signed-challenge → opaque grant token**. Derive an **account
  signing keypair as a SLIP-21 sibling** of the root seed; register the pubkey server-side; device
  signs a server challenge → server mints the opaque grant token (the grants-registry model).
  **The signing keypair is a Phase-1 requirement** (it also authorizes QR-joined device enroll).
  *secSys to pressure-test the construction; the requirement (cryptographic request auth) is fixed.*
- **PIN-ID-3:** `Identity.id` = deterministic SLIP-21 sibling derivation — stable across the
  account's devices.
- **PIN-ID-4:** passkey/WebAuthn gates **local unlock** of the at-rest encrypted Identity blob;
  the **signing key** authenticates to the server. Keep the roles distinct.
- **PIN-ID-5:** device revocation is **grant-based** (revoke the opaque token) — account-level
  signing key acceptable for v1.
- **PIN-ID-6:** **PRF is an enhancement, not a dependency.** Baseline = UV-only + encrypted-
  IndexedDB blob. Conservative floor **iOS 18** (not 17); confirm matrix, don't hard-depend.
- **PIN-ID-7:** **QR join requires an out-of-band confirmation code** on the receiving device
  (Phase-1 requirement, not optional); UI states the in-person-only threat model.
- **PIN-ID-8:** `enrollNew()` guarded behind explicit "fresh account" intent; recovery goes through
  `enrollExisting(mnemonic)` — never silently orphan existing data.
- **PIN-ID-9:** WebAuthn call is the **first `await`** in any gesture flow (iOS transient
  activation); **RP ID = hostname** (served by hostname, not IP); passkey RP ID matches across
  Safari ↔ installed PWA (test explicitly).
- E2EE option (b): derive keys as **SLIP-21 siblings** so the Phase-2 encryption layer drops in
  without rework. Don't collapse the hierarchy.
- Accuracy: BIP39 mnemonic→seed **is** PBKDF2-HMAC-SHA512 ×2048 — don't tell the implementer
  "no KDF hardening."

**Backend:** D1 `DeviceRegistry` + `grants` registry (no OPFS/Evolu primitive). Crypto via
`@evolu/common` as a **crypto-only dep** (no DB pulled) *or* ~50-line WebCrypto SLIP-21 reimpl —
**reuse-discipline: if `@evolu/common` is used, zero Evolu-isms leak past `KeyDerivation`.**

**Acceptance:** enroll new account (passkey + 24-word phrase shown once, guarded); lock/unlock via
passkey; recover on a fresh device via phrase; QR-join a second device **with confirmation code**;
every authenticated request carries a verifiable signed-challenge grant, **none authorize on `id`
alone**; revoke a device by revoking its grant.

### Stream B — Substrate + sync (server-readable, D1), ~5.5d
Clean deltos-native sync engine (S2: rewrite, no trkr porting credit). Reuse trkr **patterns**
only — atomic write+enqueue, server-time/monotonic cursor, timestamp clamp, `/api/` SW denylist,
sync-indicator state model — all rewritten, zero `tasks`/`services` vestiges. Module shape per
S2 §4 (`db/schema.ts`, `db/mutate.ts`, `lib/syncEngine.ts`, `worker/routes/sync.ts`, etc.,
deltos-named).

**Spine storage:** whole-note granularity — block tree serialized as JSON in `notes.body`,
property bag as JSON in `notes.properties`, blobs referenced by **content hash, never inline**.

**Hard requirements (all from `phase-1-constraints.md`):**
- **PIN-SYNC-1 (HIGH):** the push conflict check is a **single atomic compare-and-swap**, never
  select-then-upsert (TOCTOU). `UPDATE … version=version+1 WHERE id=? AND notebook_id=? AND
  version=?base_version`; branch on **rows-affected** (1 → accepted; 0 → conflict → fork). New
  note via `INSERT … ON CONFLICT`. **PLUS** a client **single-flight guard on `syncNow()`** (the
  1s-debounce + 30s-poll + online-event triggers must not double-push). *The ~2.5d conflict-engine
  budget assumes this is built in from the start, not bolted on.*
- **PIN-SYNC-2:** cursor must not skip equal-timestamp notes — use a **monotonic cursor
  (server sequence/rowid)**, or `>=` + client de-dup by version. Per-notebook cursor either way.
- **PIN-SYNC-3:** delete-vs-edit policy = **preserve-as-fork with explicit resurrection labeling**
  (don't silently drop offline edits against a server tombstone; badge the fork "deleted on another
  device — your edits kept as a copy").
- **PIN-SYNC-4:** fork asymmetry accepted for v1 — **server keeps original ID, local edit forks to
  new ID** (inbound relations stay valid); fork carries **`forkedFromId`**.
- **PIN-SYNC-5:** cross-notebook move (changing `notebook_id`) is **out of scope for v1** — state
  the known ghost-in-old-notebook gap in one line, don't silently mis-handle it.
- Landmines as requirements: **stable client UUID at creation** (never server-assigned);
  **timestamp clamp** unconditional; **per-notebook cursor**; **edit-while-syncing** updates local
  `serverVersion` synchronously on push success; **`mergeIntoDexie` skips incoming update when a
  pending local edit exists in syncQueue**; **blob sync is a separate queue** ("note synced,
  attachment pending"); full-sync-on-cursor-clear acceptable v1 (design pull for keyset pagination
  later).

**Auth integration:** every `/api/sync/*` call passes through the single `can(principal, op,
resource)` chokepoint (P0 stub → real) authenticated by Stream A's grant token — **wires B to A's
PIN-ID-1/2.** Online read-mirrors (`notebooks`, `settings`) are server-authoritative, never queued.

**Build discipline (Stream B):** the conflict resolver is **test-shaped** — a pure contract
`(baseVersion, serverVersion, payload, serverState) → accepted | conflict→fork` plus the
single-flight gate — and a regression here corrupts data **silently**. Build it under
**tdd-cycle** (RED-GREEN-REFACTOR): write the race-scenario tests *first*, then the engine. This
is the explicit mitigation for the fact that the TOCTOU race slipped the S2 *design* — the fix is
no longer "spot the subtle race," it's "make these failing race tests pass."

**Acceptance (each is a written test, not a manual check):**
- create offline → queues → reconnect → atomic-CAS push accepts, version bumps.
- **concurrent push on the same base version → conflict FIRES, fork created with `forkedFromId`,
  both copies survive** (the bug class secSys flagged — the test must prove the CAS raises it).
- **single-flight:** overlapping triggers (1s-debounce + 30s-poll + online-event firing together)
  push a queue entry **at most once** concurrently — no double-apply.
- **edit-while-syncing:** an edit during an in-flight push lands safely; local `serverVersion`
  updates synchronously on push success before the next cycle; no lost edit on push success *or*
  failure (latest-wins dedup collapses).
- **pending-edit pull guard:** an incoming pull update does **not** stomp a note with a queued
  local edit.
- **delete-vs-edit (PIN-SYNC-3):** offline edit against a server tombstone → preserve-as-fork with
  the resurrection label, not silent loss.
- sync indicator reflects pending/syncing/offline/error.

### Stream C — Capture surface + editor (ProseMirror — LOCKED, user-confirmed 2026-06-15), depends on P0 spine types
One **capture surface** (the `/new` instant-capture route + a note editor). ProseMirror document
whose schema maps 1:1 to the core block types (heading/paragraph/list/quote/code/todo/divider +
the media/file/table types as available); `pmDocToSpine()` / `spineToPmDoc()` serialization (S2 §5).
Plugin-island seam **designed** via `NodeView` (no plugin built yet — seam shaped). Render-before-
data shell (paint editor instantly, hydrate from local store, persist optimistically).

**Cheap full-view hedge** [2026-06-15 design thread; coordinate with pilot]: route the surface's
note→view selection through a **resolution indirection** (Phase-1's only resolver = the block-body
editor) rather than hardcoding note→editor. Costs ~nothing now and lets Phase-2 **full-views**
(recipe cook-view, kanban, code-as-body — the bridge for non-document notes, **no note-type
polymorphism**) drop in without a rewrite. Phase 1 builds only the default resolver, not full-views.

**Explicitly in scope — the unique-block-ID plugin** [scopeSys catch, 2026-06-15]: the spine is
**ID-first**, but PM does **not** preserve node IDs across **copy/paste, split, or merge** for free
(paste can duplicate IDs; split must mint a fresh one; merge must pick one). A dedicated PM plugin
must guarantee **every block carries a stable, unique `attrs.id`** through all transforms — mint on
create, **re-mint on paste/split to avoid collisions**, preserve on move. Load-bearing for the
collab seam + future per-block history; under-specifying it corrupts the ID invariant the whole
spine assumes.

**Budget the cross-cutting editor infra honestly** [scopeSys, 2026-06-15]: the real first-slice
cost is **NOT** per-block-type boilerplate — it's the cross-cutting infrastructure: **selection
across nested blocks, clipboard serialize/parse (PM doc ↔ spine ↔ external), undo/redo history, and
mobile IME composition** (iOS). Size Stream C around these, not the ~12 block types.

**Dogfood on real iOS early** [scopeSys]: the primary capture surface is **mobile** — test the
editor on a real iPhone (Tailscale HTTPS) from the first working build, not at the end. IME /
selection / clipboard bugs surface only on-device.

**Acceptance:** tap the `/new` icon → already typing into a client-UUID note; edits persist
optimistically to the local store and flow into Stream B's queue; reload restores from local;
serialization round-trips spine ↔ PM doc losslessly for all core block types; **block IDs stay
unique + stable across copy/paste/split/merge** (explicit test); **selection, clipboard, undo/redo,
and iOS IME composition all verified on a real device.**

### Stream D — Integration & end-to-end proof
Wire A (unlock → grant) → B (authenticated sync) → C (surface writes). Boot sequence:
`KeyStore.unlock()` → hand `Identity` + grant to the app → surface renders → edits sync. Verify the
**full done-sentence** on a real installed PWA over Tailscale HTTPS (hostname RP ID per PIN-ID-9).

**Acceptance (the Phase-1 done-gate):** install PWA → unlock with passkey → create/edit a note
**offline** → reconnect → watch it sync; recover/join a second device via phrase/QR; a forced
conflict produces a fork, not a lost write. All on clean deltos-native code.

---

## Reuse-discipline gate (HARD — every stream)
Litmus on every file: *would a stranger reading it cold guess it was lifted from trkr/full-beans?*
If yes, not done. No `AppOwner`/Evolu-isms past `KeyDerivation`; no `tasks`/`services`/LWW vestiges
in sync; no cookie-auth leftovers. Packets give velocity of *understanding* (skip rediscovering the
SW denylist, the timestamp-clamp, SLIP-21 separation, WebAuthn-as-first-await), not velocity of
paste. **secSys audits this explicitly on Stream A and B.**

## Out of scope (Phase 1)
Second surface, notebooks-as-feature beyond the scoping column, universal search, plugin
manifest/registry build, blob store build (reference-by-hash only), E2EE, collaboration build
(design the seam only), Markdown export, history/trash, cross-notebook move.

## User decisions feeding this spec — both RESOLVED
- **D1 editor engine** — RESOLVED: **ProseMirror, user-confirmed 2026-06-15**, no veto. Stream C
  carries scopeSys's scope additions (unique-block-ID plugin; cross-cutting infra budget; iOS
  dogfood).
- **D4 relation scope** — RESOLVED-by-default: **global-by-id** (scopeSys: proceed, low flip risk;
  instant-ping if the user surprise-flips). No other user decision blocks Phase 1.
- *Heads-up:* the user notes D1 surfaced a **deeper question** they're discussing with scopeSys —
  no Phase-1 contract impact for now; will fold if it lands.

## secSys focus areas (called out for the audit queue)
1. **Stream A PIN-ID-1/2** — confirm no endpoint authorizes on `id` alone; the signed-challenge →
   grant construction is sound (replay resistance, challenge freshness, pubkey-to-account binding).
2. **Stream B PIN-SYNC-1** — confirm the conflict path is a true atomic CAS and a forced concurrent
   push actually raises a conflict (the TOCTOU bug class). Single-flight guard present.
3. Reuse-discipline on A + B.
