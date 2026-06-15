# Spike S2 — trkr sync-engine sizing

**Type:** THROWAWAY research spike (written finding + sizing, **not kept code**). ·
**Proposed owner:** a grunt (sonnet). · **Parallel with:** P0, S1, S3. Sizes the Phase 1
substrate slice and **feeds the editor-engine decision**.

## Question to answer
trkr already implements deltos's sync **Mechanism A** (optimistic write buffer + read mirror)
on Dexie + Worker+Hono+D1 with **LWW**. How much has to change to become deltos-native:
1. **Schema → the hybrid spine** (identity + loose property bag + **nestable block-tree** body)
   instead of trkr's flat record schema. The block-tree is the big delta — what does a tree of
   blocks do to the write queue, the cursor pull, and the read mirror?
2. **LWW → fork-on-conflict** via a per-note **version counter** (compare on flush; unchanged →
   apply, moved → write a copy "(offline edit, date)"). What in trkr's LWW path is load-bearing
   vs. has to be rebuilt?

## Why it matters
Sizes the substrate+sync slice of Phase 1 (the thesis-prover). Also: how the block-tree rides
the sync queue **directly informs the editor-engine choice** (ProseMirror / Lexical / TipTap) —
whichever engine's document model maps cleanest onto the synced block-tree wins. Surface that.

## Investigate (read the packet first)
- `_inbox/OFFLINE_SYNC_HANDOFF.md` — the trkr sync packet.
- Map trkr's: atomic write+enqueue, cursor-based pull, online-only read-mirror, sync indicator,
  the timestamp-clamp **security lesson**. Mark each: reusable-as-pattern / needs-rework / drop.
- Work the block-tree question concretely: are blocks synced as part of the note payload (whole-
  note granularity, fits version-counter fork) or addressed individually? Whole-note is the
  brainstorm lean — pressure-test it against editing UX and payload size.
- Work the version-counter fork: where does the counter live, when does it bump, how does the
  flush-time compare + copy-on-moved actually thread through trkr's queue.

## Deliverable (written finding — `docs/spikes/S2-findings.md`)
- **Change-map:** trkr sync component → keep-as-pattern / rework / drop, each with a why.
- **Sizing** of the Phase 1 substrate+sync slice (rough effort + the deltos-native module shape).
- A concrete recommendation on **block sync granularity** (whole-note vs per-block) with trade.
- The **editor-engine implication**: which engine's doc model maps cleanest onto the synced
  block-tree, and why — to seed the Phase 1 decision (planner makes the final call).
- Landmines banked (dup-on-sync without stable client UUIDs, edit-while-syncing, the
  timestamp-clamp security issue).

## Reuse-discipline gate
Research only — **no kept code.** You're sizing a deltos-native rewrite of the sync engine, not
porting trkr's. No LWW assumptions, no trkr schema shapes carried forward. Packet = velocity of
*understanding* (skip rediscovering the `/api` SW denylist bug, the timestamp-clamp), not paste.

## Out of scope
Building sync. Choosing the editor engine (you *inform* it; planner decides at Phase 1). E2EE /
encrypted-blob path (v2).
