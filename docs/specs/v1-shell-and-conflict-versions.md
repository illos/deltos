# v1 Course-Correction Spec — Local-First Shell + Conflict-as-Version

**Status:** SPEC-READY (planSys, 2026-06-16). Handoff target = pilot. Supersedes the in-flight
"E4 = make re-auth work on reload" framing and reframes the PRF / disclosure / Option-A-B / autoUnlock
work under the corrected shell. **Reuse-discipline gate applies** (rewrite-to-native; KICKOFF §Reuse).

## Why
Mid-v1-dogfood the user halted the team: the E4 thread (plain reload → full-screen "device not registered,
use recovery phrase") had drifted into piling auth machinery **into the launch path**, violating the
LOCKED architecture (`KICKOFF.md` §Locked architecture, verbatim):
- *"Render-before-data + SW precache → launch feels ~native"*
- *"Optimistic write buffer + stale-while-revalidate reads"*
- *"Offline auth must not block launch"*
- *"Fork only on actual conflict … no CRDT/merge"*

The user's recalled model (online-first, local-first quick load, background sync, duplicate-on-conflict)
matches the locked arch exactly → **the build drifted, the doc didn't.** This spec re-anchors v1 to it and
folds conflict resolution into note version history (option A), which also *removes* the contrived
duplicate-note fork and fixes a known relation-orphan problem.

---

## Part 1 — Local-first shell (load decoupled from auth)

**Goal:** launch renders notes from the local store immediately; auth + sync are a background concern;
the recovery-phrase screen is a non-blocking nudge, never a boot gate.

**Behavior (acceptance-bearing):**
1. On launch, the app reads the local store and **renders the notes UI before any session/auth await**
   (render-before-data). The local account identity (stable `accountId`, the durable wrapped key, and its
   `keyId`) is read from **durable** storage so the app knows whose notes to show without the server.
2. Silent session establishment (signed-challenge re-auth from the stored key) runs in the **background
   after first paint**. Success is invisible; the user never "re-authorizes."
3. On auth/sync failure (offline / lost key / server down): the UI keeps working fully on local data and
   shows a quiet, **non-blocking** "offline / not-synced" status; retry with backoff. **No eviction to a
   recovery screen.**
4. A **blocking** auth screen appears ONLY for: (a) genuine first-run (no local account/data) → enroll;
   (b) no local key present (e.g. after the user cleared browsing data) → recovery-phrase re-register.
   These are the *only* logout paths — matching the user's line "the only thing that logs me out is
   clearing browsing data."
5. The E4 "device hasn't been registered" full-screen is **removed as a boot gate**; it survives only as
   the no-local-key recovery path in (4b).

**Acceptance:**
- Enrolled device, **plain reload** → lands directly in notes; no recovery-phrase prompt; no perceptible
  auth wait. (E4 closed *properly*, not just by the keyId patch.)
- **Offline cold start** (airplane mode) → notes render and are editable; status shows offline; no gate.
- **Clear browsing data** → next load → recovery-phrase path (expected; the only logout).
- **F7 invariant unchanged:** session token stays in-memory-only; never persisted at rest.

**Reuse / don't rebuild:** the durable-keyId fix (`2d629a6`) stays as the underlying correctness fix
(pointer co-located with the wrapped key in IndexedDB, surviving iOS eviction); the local Dexie store +
reactive query already exist — this is wiring the shell to render from them and demoting auth/sync to
background, not new storage.

---

## Part 2 — Sync + conflict-as-version (option A)

**Goal:** online → near-real-time sync; offline → buffer then sync on reconnect; a conflict retains the
divergent edit as a **version of the same note**, never lost, never a duplicate note.

**Behavior (acceptance-bearing):**
1. **Online editing** → debounced push of each note's changes to the server (near-real-time; reuse the
   autosave debounce cadence — team sizes the settle window).
2. **Offline editing** → edits accumulate in the local store + push queue; flushed on reconnect.
3. **Conflict detection** → each note tracks the **base version it last synced from**. On push, the server
   CAS (`expectedVersion`, PIN-SYNC-1) decides: if the server version advanced beyond the device's base →
   **conflict**; else fast-forward (no conflict).
4. **Conflict outcome** → DO NOT overwrite, DO NOT fork to a new note. The device's divergent edit is
   **retained as a conflict version attached to the SAME note (same note ID)**. The server's current
   content stays the note's live content; the divergent edit is stored as an alternate whole-note-snapshot
   version keyed to that note. Note gains a `hasConflict` state + ≥1 retained conflict-version snapshot.
   *(Build on whatever the sync engine already retains for the Stream-B no-lost-edit guarantee — this is a
   representation change, not a new conflict-detection mechanism.)*
5. **User surface:**
   - On conflict (detected during background sync) → a **non-blocking toast**: *"Sync conflict on '<note
     title>' — your version was kept."*
   - The note shows a **persistent conflict badge** until resolved.
   - Opening the note / tapping the badge → a conflict view: see both versions; resolve with **keep mine /
     keep theirs / keep both**. Resolving clears the badge.
     - *keep mine* → the divergent local version becomes live (pushed as the new top version).
     - *keep theirs* → discard the retained divergent version; server content stays live.
     - *keep both* → **planner ruling:** retain both as versions of the one note (no data loss, no auto
       second note); a user who genuinely wants a split uses an explicit "duplicate to new note" action.
       *(Overridable if the user prefers keep-both = auto-split.)*
6. **Revises prior pins:**
   - **PIN-SYNC-4** — no more new-ID sibling fork. The note keeps its ID → **inbound relations stay valid
     for free** (removes the Phase-3 relation-repair concern the old fork model created). `forkedFromId`
     retired for the conflict path.
   - **PIN-SYNC-3** (offline-edit vs server-delete) — the note's live state may be a tombstone, but the
     divergent offline edit is retained as a conflict version; the toast/badge let the user resurrect it
     via *keep mine*. Same non-loss principle, now expressed as a version not a fork.
7. **Grain:** whole-note snapshots (per S2-findings). Per-block history stays Phase 3 (block-IDs already
   preserved for it).
8. **Deferred to Phase 3:** the full version-history **timeline / browse / restore-any UI**. This v1
   surface is **conflict-only**, but it lays the per-note versions data model that Phase 3 extends.

**Acceptance:**
- Offline edit → reconnect, **server unchanged** → fast-forward, no conflict, no toast.
- Offline edit → reconnect, **server changed** → toast + persistent badge; **both versions retained**;
  resolve (mine/theirs/both) works; relations pointing at the note still resolve.
- **No conflict ever produces a second note in the list.**
- Stream-B no-lost-edit invariants still hold (re-run the trip-wire tests).

**Reuse / don't rebuild:** the **audited Stream-B no-lost-edit core** (both sides already retained — the
hard correctness half is done); the version-counter / `expectedVersion` CAS; the autosave debounce
(extend to debounced server push).

---

## Constraints still in force
PIN-STORAGE-1 (SW never runtime-caches `/api`), F7 (token in-memory only), PIN-SYNC-1 (atomic CAS on every
version-bumping path), PIN-SYNC-2 (monotonic pull cursor), D6 accountId scoping on every data/sync query,
F13 prod tripwire (fail-closed). PIN-ID-9 (hostname RP-ID).

## At-rest custody / disclosure — re-scope, don't drop
Option A (device-local custody, lock-screen-grade) **stands** for the at-rest key. The honest D5-style
disclosure stays a requirement, but lives **at enroll (and recovery), OUT of the launch path** — it is not
shown on a silent background re-auth. secSys re-confirms the shell decouple doesn't change its Option-A
6-condition ruling; gruntSys2's disclosure copy (`a73752e`) still needs planSys copy-approval before final.

## Out of scope (this spec)
Full version-history UI, per-block history, cross-notebook move (PIN-SYNC-5), E2EE (v2), the add/replace-
credential endpoint (Phase-2, needs AUTH_PURPOSE).

## Open during build (flag to planner)
- Exact debounce/push cadence for "near-real-time" online sync (team sizes; intent = feels live, not
  per-keystroke chatter).
- Whether any of the paused PRF/Option-A-B/autoUnlock work is now redundant under the background-auth
  shell (likely simplifiable — pilot/secSys assess; don't rebuild what the decouple obviates).
