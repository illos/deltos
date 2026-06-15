# Phase 1 — accumulating spec constraints (pin-list)

Running capture of decisions/requirements the **Phase-1 vertical-slice spec** must absorb, as
spike findings + audits land. I draft the full Phase-1 spec at STAGE A (S1+S2 reported+audited);
this file ensures nothing load-bearing slips between now and then. Source tags in brackets.

---

## Identity slice — pinned requirements

Derived from `docs/spikes/S1-findings.md` (verdict: lift-with-surgery, 5–7d, E2EE option-b
viable) + secSys audit flags relayed via pilot 2026-06-15. secSys endorsed the spike conclusion;
these close the gaps before the spec goes live.

### PIN-ID-1 — `Identity.id` is an identifier, NEVER an authenticator [FLAG-1, HIGH]
S1 says only `Identity.id` crosses the custody↔server seam and the server uses it for "row
ownership." That makes `id` a **bearer username**: anyone who learns a victim's `id` could
read/write their rows. In full-beans, `writeKey` was the *write-authorization proof*; S1 dropped
it as "Phase-1 dead weight" without naming a replacement. **The server MUST NOT authorize any
read/write on `id` alone.** Every mutating request must carry a cryptographic proof of account
possession. This is the one optimistic assumption in S1 and the spec must close it explicitly.

### PIN-ID-2 — auth mechanism: signed-challenge → opaque grant token [FLAG-1 + FLAG-2b]
Recommended construction (secSys to pressure-test, but the *requirement* — cryptographic request
auth — is non-negotiable):
- At enrollment, derive an **account signing keypair as a SLIP-21 sibling** of the root seed
  (siblings, never children — preserves full-beans' domain separation; collapsing keys re-opens
  the auth finding). Register the **public key** server-side.
- Session establishment: device **signs a server challenge** with the signing key → server
  verifies against the registered pubkey → mints an **opaque session/device grant token** (the
  grants-registry model already in the architecture: "device caches a long-lived grant; only
  sync re-validates server-side"). Requests carry the opaque token, not `id`.
- This makes the **signing keypair a Phase-1 requirement, not Phase-2** [FLAG-2b]. It is also the
  primitive that authorizes a QR-joined device to enroll (proof of mnemonic possession), so it's
  load-bearing for the join flow regardless.

### PIN-ID-3 — `id` derivation is deterministic and stable across devices [FLAG-2a]
`Identity.id` = a **deterministic SLIP-21 sibling derivation** from the root seed (e.g. hash of
the account signing pubkey, or a dedicated identity sibling). Same recovery phrase → same `id` on
every device the user joins. Resolves the §3 struct inconsistency (S1 called `id` a "hash of
signing key" with no signing key in the struct — PIN-ID-2 supplies the signing key).

### PIN-ID-4 — passkey gates LOCAL UNLOCK; signing key authenticates to SERVER
Keep the two roles distinct: the **passkey/WebAuthn assertion** gates unlocking the at-rest
encrypted `Identity` blob on-device (UV/PRF); the **signing key** proves identity to the server
(PIN-ID-2). Don't conflate "unlock the local key" with "authenticate the request."

### PIN-ID-5 — per-device revocation is grant-based
Revocation happens at the **grant layer** (revoke the device's opaque token in the registry —
revocability is first-class in the architecture), so an account-level signing key is acceptable
for Phase 1. Per-device keypairs (key-level revocation) are an option secSys/devSys may choose;
the *requirement* is only that a device can be revoked without rotating the whole account.

### PIN-ID-6 — PRF is an enhancement, not a dependency [FLAG-3, MEDIUM]
**Baseline = UV-only + encrypted-IndexedDB blob.** PRF (deriving the wrapping key from the
credential) is used **where available**, never required. Plan the conservative floor: secSys puts
PRF at **iOS 18** (S1 said iOS 17 — too optimistic); confirm the exact support matrix at
spec-draft, but since there's no hard PRF dependency the architecture doesn't hinge on the number.

### PIN-ID-7 — QR join requires an out-of-band confirmation code [NIT-b → REQUIREMENT]
secSys endorses **promoting from "consider" to a Phase-1 requirement**: the QR encodes the raw
24-word mnemonic = full account takeover for anyone who photographs the screen, with no expiry /
one-time / confirmation today. The receiving device MUST display a **confirmation code** the
sending device verifies before trust is established, and the UI must state the in-person-only
threat model. (The secret is the permanent root, so "one-time" applies to the transfer session,
not the phrase.)

### PIN-ID-8 — enroll guard (carry the footgun fix) [S1 §5]
`enrollNew()` on a device that already holds an `Identity` must be gated behind explicit
"this is a fresh account" intent; the recovery path goes through `enrollExisting(mnemonic)`. Bare
enroll silently orphans existing data — S1's single most dangerous footgun.

### PIN-ID-9 — iOS WebAuthn implementation rules [S1 §5]
- **WebAuthn call must be the first `await`** in any flow touching gestures/modals — iOS Safari
  drops transient activation across earlier awaits (the two-click split in full-beans is the fix).
- **RP ID = hostname**, served by hostname (Tailscale HTTPS / domain), never an IP.
- Passkey RP ID must **match across Safari ↔ installed PWA** (iCloud Keychain sync) — test
  explicitly; common trap.

### Implementer accuracy note [NIT-a]
Do **not** claim "no KDF hardening." BIP39 mnemonic→seed is **PBKDF2-HMAC-SHA512 ×2048**; SLIP-21
derives from that seed. No security impact — just don't mislead the implementer (S1 §5 wording).

### Sizing carried forward [S1 §3]
Identity slice ≈ **5–7 days**, a rewrite (not a port) of: `KeyDerivation`, `KeyStore` (WebAuthn
custody), QR module, join flow, boot wiring. Backend = **D1 DeviceRegistry + grant registry**
(no OPFS/Evolu primitive needed). Crypto primitives all pure; take `@evolu/common` as a
crypto-only dep (no DB pulled) **or** reimpl SLIP-21 in ~50 lines WebCrypto — reuse-discipline
applies: if `@evolu/common` is used, no Evolu-isms leak past `KeyDerivation`.

### E2EE option (b) — keep the seam open [S1 §4]
SLIP-21 **sibling** for `encryptionKey` is a Phase-2 add-on on the same trkr stack (no relay
lift). Phase-1 identity must derive keys as siblings of root so option (b) drops in without
rework. Don't collapse the hierarchy.

---

## Substrate / sync slice — pinned requirements

From `docs/spikes/S2-findings.md` (sizing ~5.5d substrate+sync, ~2.5d conflict engine, whole-note
granularity correct) + secSys audit flags via pilot 2026-06-15. secSys endorsed S2's conclusions;
these close correctness gaps before the spec goes live.

### PIN-SYNC-1 — conflict check is a single atomic CAS, NOT select-then-upsert [FLAG-1, HIGH — design-level]
S2 §2 writes the push check as two statements: `SELECT version` → `IF version==base_version THEN
UPSERT version+1 ELSE conflict`. That is a **TOCTOU race**: two concurrent pushes both read
version=3, both UPSERT→4, one write silently lost **and no conflict raised** — so fork-on-conflict
(the entire safety net) never fires. The spec **MUST mandate a single atomic compare-and-swap:**
```sql
UPDATE notes SET body=?, properties=?, title=?, updated_at=?, version = version + 1
WHERE id = ? AND notebook_id = ? AND version = ?base_version;
-- branch on rows-affected: 1 → accepted (new version = base+1); 0 → CONFLICT → §2-step-7 fork
```
New-note case (`base_version = 0`) via `INSERT ... ON CONFLICT(id) DO NOTHING` then check inserted.
**PLUS** a client-side **single-flight guard on `syncNow()`** so the 1s-debounce + 30s-poll +
online-event triggers can't push the same queue entry twice concurrently. secSys: **the ~2.5d
conflict-engine sizing holds ONLY IF this atomic CAS + single-flight is built in, not bolted on** —
the spec must call it out so devSys builds it from the start.

**Applies to ALL note-mutating write paths, not just `/sync/push`** [secSys P0 catch, 2026-06-15]:
the REST mutation ops (`update`, `appendBlock`, `setProperty`) hit the same `notes` rows and so
carry the **same lost-update class**. P0's frozen contract gains an **optional `expectedVersion`**
field on those requests (the pilot's contract-shape fix — in the orchestrator's lane, not a spec
change) so the **same atomic CAS** is honored on REST too: present → CAS on it; absent → last-write
(non-concurrent callers). PIN-SYNC-1 is therefore the rule for *every* path that bumps `version`.

### PIN-SYNC-2 — pull cursor must not skip equal-timestamp notes [FLAG-2, MEDIUM]
Pull uses strict `WHERE updated_at > since` against **server-clamped** timestamps → a note stamped
exactly `== cursor` is skipped forever. Batch pushes raise same-ms collision odds vs trkr's single
writes. **FIX:** use `>=` with **client de-dup by version**, OR — cleaner — a **monotonic cursor
(rowid or a server sequence/version) instead of time**. Spec picks one; monotonic-sequence is the
robust default (sidesteps clock semantics entirely). Per-notebook cursor either way.

### PIN-SYNC-3 — delete-vs-edit policy must be explicit [FLAG-3, LOW — planner decision]
If the server copy is a **tombstone** (another device deleted note N) and this device has offline
edits, the fork step would resurrect the deleted content as a copy — possibly intended, currently
undocumented. **Decision (planner): preserve-as-fork with explicit resurrection labeling.** Don't
silently discard the user's offline edits; write them as a fork titled/badged so the user sees
"deleted on another device — your offline edits kept as a copy," and can re-delete. Rationale:
data-loss avoidance > tidiness, consistent with the fork-on-conflict philosophy. Pin this in the
spec's conflict-handling section.

### PIN-SYNC-4 — fork asymmetry accepted for v1, with forkedFromId [FLAG-4, LOW]
Design keeps **server** content under the **original ID** and forks the **local** edit to a **new
ID** → inbound `relation`s stay valid, but the forking user's own edits orphan (new ID). Accept for
v1. Forked note carries **`forkedFromId`**. Note for later: relation *repair* needs an
inbound-relation lookup too (not just forkedFromId) — flag as a Phase-3 history/repair concern.

### PIN-SYNC-5 — cross-notebook move scoped OUT of v1 [NIT]
Changing a note's `notebook_id` leaves a **ghost** in the old notebook's clients (no tombstone
emitted there). Out of scope for v1 — the spec states this in one line so it's a known gap, not a
silent bug.

### Sync landmines → spec requirements [S2 §6]
- **Stable client UUID at creation** (`crypto.randomUUID()`), persisted immediately — never
  server-assigned (prevents dup-on-sync). · **Timestamp clamp** `min(client, serverNow)` on every
  push, unconditional. · **Per-notebook cursor** (`deltos.sync.cursor.v1.<notebookId>`). ·
  **Edit-while-syncing**: update local `serverVersion` synchronously on push success before the next
  cycle. · **Blob sync is a separate queue** with its own status ("note synced, attachment
  pending"). · **Full-sync on cursor clear** is acceptable v1; design the pull endpoint for keyset
  pagination later. · `mergeIntoDexie` pull guard: **skip incoming update if a pending local edit
  exists in syncQueue** (push flush reconciles).

### PIN-SUBSTRATE-1 — one-casing end-to-end, NO mapping layer [devSys P0 decision, 2026-06-15]
D1 columns are **camelCase, 1:1 with the spine** — a deliberate single-casing decision. **No
camelCase↔snake_case mapper anywhere** (`noteToServer`/`serverToNote` carry no case translation).
The mapping seam was a known bug source in trkr (S2 flagged the mapper rework); deltos removes the
seam entirely. Phase-1 storage/sync code MUST NOT reintroduce a case-mapping layer. IDs travel as
**plain strings on the wire / in storage** (branded `NoteId`/`NotebookId`/`BlockId` only in TS);
timestamps are **ISO-8601 strings** (never `Date` — survive JSON + D1 text, lexically sortable).

### Substrate module shape + sizing [S2 §4]
~5.5d substrate+sync, whole-note granularity (block tree serialized as JSON in `notes.body`;
blobs referenced by hash, never inline). D1: `notes` + `notebooks` + `grants` stub; index
`(notebook_id, updated_at)` (or the monotonic-cursor column per PIN-SYNC-2). Online read-mirrors:
`notebooks`, `settings` (server-authoritative, never in syncQueue). Reuse trkr **patterns** only
(atomic write+enqueue, server-time cursor, clamp, denylist) — rewritten deltos-native, zero
trkr/`tasks` vestiges.

---

## Data model — pinned

### PIN-MODEL-1 — `relation` is GLOBAL-by-id, access enforced at resolution [planner decision, 2026-06-15]
`relation` = `array<NoteId>`, **global by stable NoteId, NOT notebook-scoped at the type level.**
Rationale: "the notebook is the unit of everything" governs *ownership/scope*, not *linkability*;
"one database, many paths in" + globally-addressable stable UUIDs make cross-notebook linking a
real, wanted feature (recipe→project, character→lore). Notebook-scoping the *type* now would bake a
restriction into the frozen contract that's harder to relax later than the reverse. **Two guard
rails make global safe (both required):**
1. **Resolution is `can()`-gated** — a relation **never** confers access across a notebook /
   capability / encryption boundary. No access (cross-notebook no-grant, E2EE no-key) → resolves to
   a **generic "unavailable"** — **never** a cached title, target metadata, or any leaked detail.
2. **Relations are soft, non-referentially-enforced pointers** — no FK, no referential integrity.
   They **degrade gracefully**: show the target's title **only when the principal can access the
   target AND it's in their accessible local replica**; otherwise a placeholder. Covers
   inaccessible / offline-uncached / forked-away / moved. Consistent with "forks are relationally
   lossy" (PIN-SYNC-4) + "offline silently shrinks."
3. **Display title is ACCESS-CONDITIONAL, NOT a flat denormalized field** [scopeSys catch,
   2026-06-15]. The cached title shown for a relation must be **derived/resolved through `can()`
   from the principal's own accessible, cached set** at render time — it must **NOT** be stored
   denormalized onto the *source* note's payload, where a principal with access to the source but
   not the target's notebook would read it (a cross-notebook title leak — exactly what rail #1
   forbids). This also keeps relation titles out of the shared-Cache bucket per PIN-STORAGE-1: a
   relation's target title is notebook-scoped data about the *target*, so it lives only in the
   resolving principal's accessible replica, never flattened across the boundary.

**Consequence — no relation-repair machinery in v1:** the cross-notebook-move ghost (PIN-SYNC-5,
scoped out) and fork-to-new-ID asymmetry (PIN-SYNC-4) both just produce dangling-but-safe
relations, which is acceptable. Inbound-relation *repair* is a Phase-3 history concern. (Logged to
the user as DECISIONS.md D4 — decided + overridable before STAGE B; build proceeds global-by-id.)

## Storage isolation — pinned invariants (S3, secSys-audited 2026-06-15)

S3 confirmed (best-evidence; OPFS branch pending device probe): on iOS, **Cache Storage and the SW
registration are SHARED across all same-origin webclips; IndexedDB is per-webclip ISOLATED.** The
one-clip-per-notebook model (endorsed) leans on the IndexedDB silo as a confidentiality boundary —
which holds **only** under the following invariant.

### PIN-STORAGE-1 — SW must NEVER runtime-cache `/api/*` into Cache Storage [HARD, Phase-1+]
The Service Worker may cache **only origin-global, non-notebook-scoped assets (the app shell)** in
Cache Storage. It must **NEVER** runtime-cache `/api/*` responses — note bodies, search results,
property bags. Because Cache Storage is the **shared** bucket across webclips, any notebook-scoped
content placed there is readable by **another notebook's clip** via `caches.match()`, defeating the
per-notebook IndexedDB silo. **Bites hardest in server-readable Phase 1, where bodies are
CLEARTEXT.** No leak today — shipped `sw.ts` is precache-app-shell-only with `/api` on the nav
denylist (secSys confirmed) — but this is a **written invariant** so a future implementer doesn't
add `/api` runtime caching and silently breach isolation. Notebook-scoped data lives **only** in
(isolated) IndexedDB / the local store, never in (shared) Cache Storage. Holds even after E2EE
(v2) makes bodies ciphertext — the invariant is unconditional. *secSys focus: add an audit check
that `sw.ts` never adds `/api` to any runtime cache.*

### PIN-STORAGE-2 — RESOLVED: OPFS is ISOLATED on-device ⇒ trigger does NOT fire [Phase-3 blob]
**On-device probe result (2026-06-15, real iPhone, D2): OPFS = isolated, IndexedDB = isolated —
same-origin webclips do NOT share storage on either backend.** So the shared-OPFS branch this pin
guarded against **does not fire**: per-notebook blob encryption is **NOT forced on a storage-
sharing basis.** (Had OPFS been shared, content-addressed blobs would have been readable by any
clip guessing the hash — a hidden pointer is no boundary — mandating per-notebook blob encryption.
It isn't.) Blob encryption remains independently warranted **only** by E2EE when that lands (v2),
not by webclip storage sharing. **One-storage-clip-per-notebook is now real-device-confirmed
feasible**, not best-guess. **NOTE — does NOT relax PIN-STORAGE-1:** the probe tested OPFS + IDB;
**Cache Storage is still SHARED** (S3 FLAG-1), so the never-cache-`/api`-into-Cache invariant stands
unchanged. PIN-STORAGE-3 (per-origin quota/eviction) also unaffected — isolation governs read, not
eviction.

### PIN-STORAGE-3 — one quota + one eviction domain per origin; don't promise per-icon durability [UX]
All same-origin webclips share **one quota bucket and one eviction domain** (WebKit eviction is
per-**origin**). A media-heavy notebook can push the origin to quota and **evict other notebooks'
offline data.** IndexedDB isolation governs **read-access, not eviction independence.** **UX must
NOT promise each home-screen icon is independently durable / offline-safe.** Ties into the
backup-via-replica framing (the local replica is only as durable as the shared origin quota allows).

## Editor engine — DECISION: ProseMirror (direct)

S2 §5 doc-model mapping + secSys endorsement (ProseMirror cleanest / TipTap defensible / Lexical
weakest). **Planner pick: ProseMirror, used directly (not via TipTap).**

**Why:** the block spine `{id, type, content, children?}` **is** PM's `Node {type, attrs, content}`
model — a 1:1 structural match; `NodeView` **directly implements** the plugin-block "opaque island"
seam; and **PM Steps is the natural promote-to-DO collab path** the architecture commits to
*designing now* (brainstorm: "design the seam now, defer the build"). For a frozen substrate we live
in for years, owning the document model beats a TipTap abstraction tax at exactly the collab seam.
The cost — boilerplate per block type — is bounded (~12 core types). **TipTap is the documented
fallback** if raw-PM velocity bites the first surface (PM foundation remains either way). **Lexical
rejected:** ephemeral `__key` → stable-block-ID friction, and Yjs-first collab is off-axis from PM
Steps. Phase 1 builds the **collab-seam *design*** (PM Steps → DO message mapping documented + stable
block IDs as node attrs), **not** the collab build. → user-facing as `DECISIONS.md` D1 (recommended;
user may veto before STAGE B handoff).
