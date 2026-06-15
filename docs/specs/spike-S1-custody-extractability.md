# Spike S1 — full-beans custody extractability

**Type:** THROWAWAY research spike (learn-and-discard; output is a written finding + sizing,
**not kept code**). · **Proposed owner:** a grunt (sonnet). · **Parallel with:** P0, S2, S3.
**Highest-value spike** — identity is load-bearing and email-free, and it gates the Phase 1
identity build.

## Question to answer
Is the **passkey + 24-word recovery phrase + QR cross-device join** custody flow from
`full-beans` cleanly **liftable as deltos's general identity layer, independent of Evolu's
`AppOwner`**? full-beans entangles custody with Evolu's owner/key machinery; deltos's
server-readable default path (trkr-derived) is **not** on Evolu. We need to know how separable
custody is from that engine before Phase 1 commits to building identity.

## Why it matters
- Identity here is the **always-on** layer (NO EMAIL ANYWHERE), decoupled from E2EE. Phase 1
  needs passkey unlock + recovery + QR join working on the server-readable stack.
- Also decides feasibility of E2EE **option (b)** later (encrypt-on-trkr-stack) — if custody is
  cleanly liftable, (b) gets much more attractive.

## Investigate (read the packet first)
- `_inbox/SECURITY-STORAGE-SYNC-EXTRACTION.md` — the full-beans custody/crypto packet.
- Map: which parts of passkey reg/auth, the BIP39 24-word recovery phrase derivation, and the
  QR cross-device join are **pure** (WebAuthn + key derivation + transport) vs. which assume
  Evolu's `AppOwner` / Evolu key hierarchy (SLIP-21 etc.).
- Identify the seam: what does custody actually *need* from the storage engine (a place to
  stash a wrapped key? a device record? nothing)? Could it sit on D1 + the grant registry
  instead of `AppOwner`?
- Note the multi-device key-delivery story and whether it survives the engine swap.

## Deliverable (written finding — `docs/spikes/S1-findings.md`)
- **Verdict:** clean-lift / lift-with-surgery / entangled — with the evidence.
- The **custody ↔ engine seam** described concretely (what crosses it).
- A **sizing** for the Phase 1 identity slice: rough shape + effort + the deltos-native
  interfaces custody would need (a `KeyStore`/`DeviceRegistry`-shaped boundary?).
- Explicit read on E2EE **option (b)** feasibility given what you found.
- Any landmines (passkey UX on installed iOS PWA, QR channel security, recovery-phrase entropy).

## Reuse-discipline gate
This is research — **no production code is kept.** You're sizing a *rewrite*, not staging a
port. Describe what deltos would build fresh; do not lift full-beans files into the tree. The
packet is for understanding (skip rediscovering SLIP-21 key separation, HMAC owner-delete),
not for paste.

## Out of scope
Building identity. Any E2EE implementation. The DO relay (that's mined later for the E2EE zone,
not now).
