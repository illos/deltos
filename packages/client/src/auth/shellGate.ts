/**
 * Pure boot-view selector for the local-first shell (spec Part 1a §Behavior 4–5).
 *
 * The ONLY input is whether a local identity exists (`isEnrolled` = an at-rest credential blob in
 * IndexedDB). Session / unlock state NEVER feeds this decision — auth is a background concern, so a
 * locked-but-enrolled device still renders the notes shell (the session is established in the
 * background; a failure is a quiet nudge, never a gate). This is what closes E4 *properly*: there is
 * no "device hasn't been registered" boot gate any more — only the two real logout paths.
 */
export type BootView =
  /** Local durable-identity read still in flight (no network) — a brief neutral skeleton. */
  | 'boot'
  /** No local key: genuine first-run OR cleared browsing data → enroll (with recover / QR links). */
  | 'enroll-gate'
  /** Local identity present → render notes immediately, regardless of session/unlock state. */
  | 'shell';

export function selectBootView(isEnrolled: boolean | null): BootView {
  if (isEnrolled === null) return 'boot';
  return isEnrolled ? 'shell' : 'enroll-gate';
}
