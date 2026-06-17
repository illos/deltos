/**
 * Local-first shell boot-gate logic — DURABLE SESSION (auth pivot; username+password).
 *
 * selectBootView is the WHOLE gating decision, isolated as a pure function so the "which UI on
 * launch" contract is provable in [CLI-auto] without a DOM. Inputs: whether a durable session is live
 * (isAuthed — null while the cold-boot /refresh ride is in flight), and whether a live auth ceremony
 * is in progress (isAuthing). Day-to-day is ungated: a live session → the shell, no password prompt.
 */
import { describe, it, expect } from 'vitest';
import { selectBootView } from '../src/auth/shellGate.js';

describe('selectBootView — durable-session boot gate', () => {
  it('null (cold-boot /refresh not resolved) → boot skeleton, never an auth gate', () => {
    expect(selectBootView(null, false)).toBe('boot');
  });

  it('no durable session (first-run / logged-out / refresh failed) → the one blocking auth gate', () => {
    expect(selectBootView(false, false)).toBe('auth-gate');
  });

  it('durable session live → the notes shell, UNGATED (cold-boot re-mint or finalized ceremony)', () => {
    // The decision takes ONLY isAuthed (+ the isAuthing latch) — there is no per-action password
    // prompt, so a returning user with a valid refresh cookie lands straight on notes.
    expect(selectBootView(true, false)).toBe('shell');
  });

  describe('isAuthing latch — a live ceremony pins the auth surface (P0 regression guard)', () => {
    it('mid-ceremony after the in-memory session is minted (isAuthed would flip) → STILL auth-gate', () => {
      // The P0: the session-minted step must NOT flip the view to the shell, or the route unmounts
      // before the recovery phrase renders. The latch keeps the auth surface mounted end-to-end;
      // the shell opens ONLY at finalizeAuth (which clears isAuthing in the same update).
      expect(selectBootView(true, true)).toBe('auth-gate');
    });

    it('ceremony in progress before any session exists → auth-gate', () => {
      expect(selectBootView(false, true)).toBe('auth-gate');
    });

    it('latch wins even before the cold-boot refresh resolves', () => {
      expect(selectBootView(null, true)).toBe('auth-gate');
    });
  });

  describe('recovery-gate — P0 belt: a session with no finalized phrase is force-routed', () => {
    it('session live but recoveryEstablished=false → recovery-gate (not shell)', () => {
      expect(selectBootView(true, false, false)).toBe('recovery-gate');
    });

    it('recoveryEstablished=true → shell (the normal finalized account)', () => {
      expect(selectBootView(true, false, true)).toBe('shell');
    });

    it('omitted recoveryEstablished defaults to established → shell (2-arg callers unchanged)', () => {
      expect(selectBootView(true, false)).toBe('shell');
    });

    it('the isAuthing latch still wins over the recovery-gate (ceremony owns the screen)', () => {
      expect(selectBootView(true, true, false)).toBe('auth-gate');
    });

    it('no session → auth-gate regardless of the recovery flag', () => {
      expect(selectBootView(false, false, false)).toBe('auth-gate');
    });
  });
});
