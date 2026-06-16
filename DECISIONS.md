# deltos — Decisions Board

The async channel for anything I (planSys, the planner) need from you. Instead of interrupting,
I log open items here; you answer under each **My response** head whenever you have a moment, in
free text. I pick them up on my next turn and fold them into the plan. Answer in any order, or
leave the not-yet-ripe ones — they'll keep. Resolved items move to the bottom with the outcome.

---

## D6 · Server tenancy + account identity — ✅ RESOLVED: BUILD the account dimension; ADD usernames (account-vs-credential separation)

A systemic finding (secSys lead-sweep, pilot-verified, I confirmed first-hand): the server's **data
layer has no account dimension.** The `notes` table is `id/notebookId/title/body/version/timestamps`
with **no `accountFingerprint`**; `notebookId` is a bare client string never bound to an account. So
the data routes (note get/update/delete, block/property mutate, **search**, and sync push/pull) — all
now live behind the `guard()`+`can()` chokepoint — query by id/notebookId with **zero account
filter**, and a workspace-wide `note.search` returns *every* account's note titles + bodies. Device
records *are* account-scoped; note data is not, and there's no owner column for the per-route 404
pattern (that fixed the revoke BOLA) to compare against.

**This is not an active breach** — nothing real is deployed multi-account; it's the dev backend. But
it's structural, so it must be settled before the data model solidifies or any second account touches
the backend. **Severity hinges entirely on tenancy:**
- **Shared multi-account** (one backend serves you + others — family, friends, future public) ⇒
  **CRITICAL**: any authenticated account can read/write/delete/search every other account's notes.
  Fix = add the account dimension (notes/notebooks carry their owning account; every data query filters
  by the authenticated `principal.accountFingerprint`; notebook bound to its account; grants
  account-relative). Bounded, but architectural; must land before any multi-account deploy.
- **Strictly single-account-per-deployment** (deltos is self-hosted; each person runs their own
  instance; the DB only ever holds your one account) ⇒ **non-issue by construction** — no other account
  to leak to. Documented as such; no data-layer change forced.

**My recommendation: build the account dimension now, regardless of intent.** It's the correct data
model, it's cheap insurance, and it permanently closes this risk class whether you stay solo or ever add
a second account — versus a silent critical hole the day a second account appears. I do *not* recommend
isolated-DB-per-account (operationally heavy / overkill on Cloudflare). I only skip the build on a hard,
permanent commitment to one-account-per-instance — and even then I'd add the column for defense in depth.

**Fix is BOUNDED if shared-multi-account (not a rebuild)** — secSys + devSys scoped it: one
`notes.accountFingerprint` column + a per-query account-scope helper (the **PRIMARY fail-closed
control** — can't be bypassed by a forgotten `can()` arg) + a server-side owner write-stamp + one
`can()` ownership assertion (defense-in-depth) + the two-account test class. Modest, well-understood
data-layer change. Write-up: `docs/design/secSys-cross-account-sweep.md`. secSys (audit) + devSys (grant/can domain) held
for the follow-through. (Stream A auth done-gate is otherwise GREEN; BOLA revoke fixed 21/21.)

### My response

**BUILD it — YES (shared-multi-account-safe), AND add usernames.** User (2026-06-16): *"D6 yes build
it. … I'm fine with that risk [D5], but let's build usernames in as well. That way if we ever want to
change authentication methods, we can."*

Planner read + **critical coupling:** the usernames rationale (future auth-method flexibility) requires
the account identity to be **stable + credential-INDEPENDENT** — so the data dimension must key on a
stable random **accountId**, NOT on `accountFingerprint` (= hash(signingPublicKey), credential-derived;
keying notes on it would force a data migration the day auth changes — the exact pain usernames avoid).
This **rescopes** the `tenancy-grant-account-relative` scoped fix (which keyed on `accountFingerprint`).

Model — separate **ACCOUNT** from **CREDENTIAL**: immutable random **accountId** (the data-ownership
key) + unique **username** (human alias → accountId, server-arbitrated namespace) + **credentials**
attached to the account (v1 = signing key / `accountFingerprint`; future methods add OR replace without
changing accountId). Notes/notebooks key on accountId; every data + sync query filters by the
principal's accountId; grants account-relative.

Tradeoff (proceeding unless overruled): a unique-username namespace = server-arbitrated uniqueness — a
deliberate step from pure seed-only self-sovereign identity toward an account handle. Assumptions:
username = stable account handle + anchor; **local passkey/phrase unlock UNCHANGED**; built
credential-independent so methods add OR replace. **Frozen contract = ZERO-DELTA RE-POINT** (confirmed
by devSys/secSys + signed off): `Principal.id` + `grants.principalId` re-point `accountFingerprint` →
`accountId` (same shape, semantic fill); the `PrincipalVerification` union AND `PrincipalSchema` are
byte-for-byte untouched — **not a reopen, and not even an added field** (the strongest no-reopen + more
fail-closed than add-a-field). Signed off with 3 conditions (reader-audit, a semantic test guarding the
false-green, two-account isolation tests) + a back-fill migration guard. Tracked:
`[[account-identity-model]]`; handed to pilot as expanded task 12.

---

## D1 · Editor engine — ✅ RESOLVED: ProseMirror (direct), confirmed, no veto

S2 has reported and secSys endorsed its analysis, so this is now a real recommendation, not a
preview. **My pick: ProseMirror, used directly.** The reason is structural, not taste: our block
spine `{id, type, content, children?}` *is* ProseMirror's document model almost exactly, its
`NodeView` mechanism is precisely the "plugin block = opaque island" design we locked, and PM's
"Steps" are the natural path to the promote-a-note-to-a-Durable-Object collaboration seam we
committed to *designing now and building later*. For a substrate we'll live inside for years,
owning that document model directly beats wrapping it. The cost is real but bounded — more
boilerplate per block type, across only ~12 core types. TipTap (a ProseMirror wrapper, faster to
start) stays the documented fallback if raw-PM speed bites the first surface; the PM foundation is
there either way. Lexical I'm ruling out: its block IDs are ephemeral (friction for our stable-ID
needs) and its collab path is Yjs-first, off-axis from our design.

I'm drafting the Phase-1 spec around ProseMirror now so we don't stall — but **handoff to builders
waits on P0 finishing anyway, so you have a window to veto.** If you'd rather optimize first-slice
velocity over collab-seam cleanliness, say "TipTap" and I'll swap it; anything else, ProseMirror
ships.

### My response

**Confirmed: ProseMirror (direct). No veto.** Ship it. Two spec-hygiene asks folded in via
scopeSys: (1) put the unique-block-ID plugin explicitly in Phase-1 scope (PM does not preserve
node IDs across copy/paste/split for free), and (2) budget the cross-cutting editor infra
(selection across nested blocks, clipboard, history, mobile IME) honestly — that, not the
per-block-type boilerplate, is the real first-slice cost. Dogfood the editor on real iOS early
(primary capture surface is mobile). _A deeper related question is in discussion separately._

---

## D4 · Cross-notebook linking — relations are global  →  DECIDED: global-by-id (overridable)

A frozen-contract data-model call surfaced during P0: should a note's `relation` (a link to
another note) be allowed to point **anywhere** (any notebook), or only **within its own notebook**?
I've decided **global** — you can link a recipe to a project, a character to lore in another
notebook — because our "the notebook is the unit of everything" rule is about *ownership and
privacy scope*, not about what you're allowed to link to, and cross-notebook linking is a genuinely
useful feature that's painful to add back if we lock it out now. Two safety rails come with it: a
link never leaks access (if you can't see the target's notebook, the link just shows as unavailable,
never reveals content), and links are "soft" (a link to something deleted, moved, or offline
degrades to a cached title or a placeholder rather than breaking). This is decided and the build
proceeds on it — but it's your product call to overrule: if you'd rather relations stay strictly
within a notebook for v1, say so before STAGE B and I'll re-scope.

### My response

_____________________________________________

---

## D2 · iOS webclip-storage probe — ✅ CLOSED: storage isolated on both backends (OPFS + IDB)

You already said the device is available — the throwaway probe is now live on the tailnet. It
answers the one open S3 unknown: do two home-screen icons from the same origin **share** storage or
stay **isolated**? — which informs Phase-3 blob-store/storage scoping. Nothing leaves the device;
nothing is sent to a server. Skip freely if inconvenient — we proceed on best-evidence otherwise.

Two URLs:
- Clip A: https://devbox.tail41404c.ts.net:8449/?clip=A
- Clip B: https://devbox.tail41404c.ts.net:8449/?clip=B

Steps:
1. iPhone Safari → open **Clip A** URL → Share → Add to Home Screen → name it **Probe A** → Add.
2. Back in Safari → open **Clip B** URL → Share → Add to Home Screen → name it **Probe B** → Add.
3. Launch **Probe A** from the home screen → tap **"Write this clip's mark"** → see "Mark written."
4. Close Probe A → launch **Probe B** from the home screen.
5. Read its two result boxes and report what each says: **"Empty"** (green = isolated) vs
   **"SHARED"** (yellow = shared).

I just need Probe B's two results back: **OPFS = ?** and **IDB = ?** — I'll relay to the pilot.

### My response

Ran it on a real iPhone (Probe A → wrote mark → Probe B). Probe B result: **OPFS = Empty
(green/isolated)** and **IDB = Empty (green/isolated)**. So same-origin webclips do **NOT**
share storage — each home-screen clip is isolated on both backends. (Note: probe initially
403'd on device — Host-header allowlist bug in the probe server, missing the `:PORT` form;
fixed + verified before this run.)

---

## D3 · Any direction / sequencing / team-shape adjustment?

A thumbs-up or any tweak on the current shape while it's cheapest to change — only foundation plus
throwaway spikes are in flight. The shape today: team is pilot + 4 (devSys on impl, two grunts on
support, secSys on audit); the opening batch is P0 foundation plus the three de-risking spikes run
in parallel; the gate to Phase 1 is two-stage (draft the spec off S1+S2, hand it off once P0 is
also done). Silence here is fine — I'll read it as "looks right, proceed."

### My response

_____________________________________________

---

## D5 · Device revocation limits — ✅ ACKNOWLEDGED (v1 account-level accepted)

Surfacing a security-posture limitation for your awareness — it's already the decided v1 path, not
a fork. In our identity model your **24-word recovery phrase IS your account** (that's what makes
it email-free). The signing key that authenticates your devices is derived from that phrase, so it's
**the same on every device you own**. Consequence: if a device is lost/stolen, "revoking" it
invalidates its active session token (so it can't keep syncing), but **anyone still holding the
recovery phrase can simply re-enroll a new device** — revocation doesn't lock out the phrase itself.
This is inherent to any recovery-phrase system (whoever has the phrase is you), and it's what
secSys + devSys are documenting as the accepted v1 posture. The lost-device-*without*-the-phrase
case is fully covered; the phrase-compromise case is the irreducible part. The stronger alternative
— **per-device keypairs** giving true per-device lockout even against a phrase-holder — is now a
**non-breaking Phase-2 upgrade**: devSys is pre-shaping the device registry
(`deviceSigningPublicKey` + `deviceAuthorization`) so it can drop in later without reworking the
identity layer. Flag if you'd want it on the roadmap; otherwise we proceed account-level as-is.

### My response

**Acknowledged + accepted — proceed account-level for v1.** This exact limitation surfaced during
**full-beans** development (our custody-extraction source), so it's familiar, known, and an accepted
tradeoff for recovery-phrase identity. No upgrade roadmap requested now; keep the pre-shaped
device-registry seam so per-device lockout stays a non-breaking add if ever wanted. (via scopeSys)
