/**
 * Local-first shell boot-gate logic (acceptance matrix P1-6, P1-8).
 *
 * selectBootView is the WHOLE gating decision, isolated as a pure function so the "which UI on
 * launch" contract is provable in [CLI-auto] without a DOM: the only input is whether a local key
 * exists; session / unlock state must NEVER change the answer.
 */
import { describe, it, expect } from 'vitest';
import { selectBootView } from '../src/auth/shellGate.js';

describe('selectBootView — local-first boot gate (P1-6, P1-8)', () => {
  it('null (local identity read not resolved) → boot skeleton, never an auth gate', () => {
    expect(selectBootView(null)).toBe('boot');
  });

  it('no local key (first-run OR cleared data) → the one blocking enroll/recovery gate (P1-6)', () => {
    expect(selectBootView(false)).toBe('enroll-gate');
  });

  it('local identity present → the notes shell, regardless of session/unlock state (P1-8)', () => {
    // The decision takes ONLY isEnrolled — there is no isUnlocked / sessionState input, so a
    // locked-but-enrolled device can never be evicted to a "device not registered" boot gate.
    expect(selectBootView(true)).toBe('shell');
  });
});
