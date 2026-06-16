/**
 * Local-first shell boot-gate logic (acceptance matrix P1-6, P1-8).
 *
 * selectBootView is the WHOLE gating decision, isolated as a pure function so the "which UI on
 * launch" contract is provable in [CLI-auto] without a DOM. Inputs: whether a completed local
 * identity exists, and whether a live enroll ceremony is in progress. Session / unlock state must
 * NEVER change the answer.
 */
import { describe, it, expect } from 'vitest';
import { selectBootView } from '../src/auth/shellGate.js';

describe('selectBootView — local-first boot gate (P1-6, P1-8)', () => {
  it('null (local identity read not resolved) → boot skeleton, never an auth gate', () => {
    expect(selectBootView(null, false)).toBe('boot');
  });

  it('no local key (first-run OR cleared data) → the one blocking enroll/recovery gate (P1-6)', () => {
    expect(selectBootView(false, false)).toBe('enroll-gate');
  });

  it('local identity present → the notes shell, regardless of session/unlock state (P1-8)', () => {
    // The decision takes ONLY isEnrolled (+ the enrolling latch) — there is no isUnlocked /
    // sessionState input, so a locked-but-enrolled device can never be evicted to a "device not
    // registered" boot gate.
    expect(selectBootView(true, false)).toBe('shell');
  });

  describe('enrolling latch — a live ceremony pins the enroll surface (P0 regression guard)', () => {
    it('mid-ceremony after a credential is sealed (isEnrolled flips true) → STILL enroll-gate', () => {
      // The P0: the credential-created step used to flip isEnrolled true → shell → EnrollRoute
      // unmounts before the recovery phrase shows / register+mint run. The latch must keep the
      // enroll surface mounted end-to-end regardless of isEnrolled.
      expect(selectBootView(true, true)).toBe('enroll-gate');
    });

    it('ceremony in progress before any blob exists → enroll-gate', () => {
      expect(selectBootView(false, true)).toBe('enroll-gate');
    });

    it('latch wins even before the local read resolves', () => {
      expect(selectBootView(null, true)).toBe('enroll-gate');
    });
  });
});
