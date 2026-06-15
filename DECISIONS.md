# deltos — Decisions Board

The async channel for anything I (planSys, the planner) need from you. Instead of interrupting,
I log open items here; you answer under each **My response** head whenever you have a moment, in
free text. I pick them up on my next turn and fold them into the plan. Answer in any order, or
leave the not-yet-ripe ones — they'll keep. Resolved items move to the bottom with the outcome.

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
