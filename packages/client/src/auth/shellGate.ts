/**
 * Pure boot-view selector for the local-first shell, keyed on the DURABLE SESSION (auth pivot —
 * username+password; supersedes the passkey enroll/unlock model).
 *
 * Two inputs, both from the auth store (no extra network here — the cold-boot /refresh ride lives in
 * {@link AuthActions.init}; this is a pure function of its result + the ceremony latch):
 *
 *   1. `isAuthing` — a LIVE auth ceremony (register / login / reset) is in progress in THIS session.
 *      It PINS the auth surface end-to-end so the gate can NOT short-circuit a ceremony that has
 *      minted an in-memory session but not yet shown+acknowledged the recovery phrase (register) or
 *      finished its step (login/reset). Without this latch, the session-minted step would flip
 *      `isAuthed`/render the shell → the auth route unmounts mid-ceremony → the recovery phrase never
 *      renders = the P0 enroll-unmount bug class, carried forward verbatim. In-memory only (a reload
 *      drops it, by design — see {@link AuthActions.init}, which also refuses to open the shell while
 *      `isAuthing` so a background refresh can't race the latch).
 *   2. `isAuthed` — a durable session is live: an in-memory access token exists, either freshly minted
 *      by a ceremony (flipped at {@link AuthActions.finalizeAuth}) or re-minted on cold boot by the
 *      `/refresh` ride. `null` = the cold-boot refresh is still in flight (a brief neutral skeleton).
 *
 * Day-to-day is UNGATED: once `isAuthed` is true (including the silent cold-boot re-mint), the notes
 * shell renders with NO password prompt — password is for register / new-device login / reset only.
 * The ONLY blocking auth screen is the gate shown when there is no durable session and no live
 * ceremony.
 */
export type BootView =
  /** Cold-boot /refresh still in flight (no network decision yet) — a brief neutral skeleton. */
  | 'boot'
  /** No durable session (and no live ceremony) → the register / login / reset gate. */
  | 'auth-gate'
  /** Durable session live → render notes immediately, ungated. */
  | 'shell';

export function selectBootView(isAuthed: boolean | null, isAuthing: boolean): BootView {
  // A live ceremony owns the screen end-to-end — never short-circuit it to the shell, even once the
  // in-memory session has been minted (the recovery phrase / final step must complete first). This is
  // the P0 latch: the shell opens ONLY at finalizeAuth, which clears isAuthing in the same update.
  if (isAuthing) return 'auth-gate';
  if (isAuthed === null) return 'boot';
  return isAuthed ? 'shell' : 'auth-gate';
}
