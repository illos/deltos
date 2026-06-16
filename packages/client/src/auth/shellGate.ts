/**
 * Pure boot-view selector for the local-first shell (spec Part 1a §Behavior 4–5).
 *
 * Two inputs, both LOCAL (no network); session / unlock state NEVER feeds this decision — auth is a
 * background concern, so a locked-but-enrolled device still renders the notes shell (the session is
 * established in the background; a failure is a quiet nudge, never a gate). This is what closes E4
 * *properly*: there is no "device hasn't been registered" boot gate any more — only the two real
 * logout paths.
 *
 *   1. `enrolling` — a LIVE enroll ceremony (enroll / recover / QR-join) is in progress in THIS
 *      session. It pins the enroll surface end-to-end so the gate can NOT short-circuit a ceremony
 *      that has created a credential but has not yet shown+acknowledged the recovery phrase,
 *      registered the device, and minted a session (planSys fix-shape invariant). Without this latch
 *      the credential-created step flips `isEnrolled` true → 'shell' → the enroll route unmounts
 *      mid-ceremony → the recovery phrase never renders + register/mint never run = an unrecoverable,
 *      unregistered account (the P0). It is in-memory only (reset on reload — see below).
 *   2. `isEnrolled` — an at-rest credential blob exists in IndexedDB. On a COLD load (no live
 *      ceremony) this is the durable local-first signal: a blob present → render notes now, even if
 *      the device is not yet registered (keyId absent). Such a half-enrolled blob self-heals via the
 *      background `needs-unlock` nudge → UnlockRoute, which re-registers the same key (same account,
 *      notes preserved); blocking it would buy nothing — the recovery phrase is unrecoverable from a
 *      blob regardless, so showing the notes + the nudge is the correct local-first outcome.
 *
 * Note the semantic split this creates by design: DURING a live ceremony `isEnrolled` stays false
 * until {@link AuthActions.finalizeEnroll} flips it at completion (honouring the invariant), whereas
 * a cold `init()` derives `isEnrolled` from blob-existence. The `enrolling` latch is the only thing
 * that distinguishes "mid-first-ceremony" from "completed identity, reloaded".
 */
export type BootView =
  /** Local durable-identity read still in flight (no network) — a brief neutral skeleton. */
  | 'boot'
  /** No local key: genuine first-run OR cleared browsing data → enroll (with recover / QR links). */
  | 'enroll-gate'
  /** Local identity present → render notes immediately, regardless of session/unlock state. */
  | 'shell';

export function selectBootView(isEnrolled: boolean | null, enrolling: boolean): BootView {
  // A live ceremony owns the screen end-to-end — never short-circuit it to the shell, regardless of
  // whether a credential blob has already been sealed this session.
  if (enrolling) return 'enroll-gate';
  if (isEnrolled === null) return 'boot';
  return isEnrolled ? 'shell' : 'enroll-gate';
}
