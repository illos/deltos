/**
 * MigrationNotice — one-time dismissible banner shown when an existing user's at-rest
 * protection changes from passkey-bound (PRF) to device-local lock-screen (Option-A).
 *
 * Copy: planSys-approved, secSys honesty-recheck in progress.
 * Placement: devSys mounts at the migration unlock point (first unlock after the change).
 *
 * Self-contained show-once: uses localStorage key 'deltos:migrationNoticeSeen' so the
 * banner renders exactly once and never again after dismissal. This is a UI preference
 * flag, not security state — localStorage is safe here (F7 is about the bearer token only).
 */
import { useState } from 'react';

const STORAGE_KEY = 'deltos:migrationNoticeSeen';

const BODY =
  "Heads up — we've changed how your notes are protected on this device. " +
  "They're now secured by your device's lock screen rather than your passkey. " +
  "Day-to-day, your notes open instantly with no extra step; the trade is that the protection is your device lock, nothing more. " +
  "Your notes and recovery phrase are unchanged.";

export function MigrationNotice() {
  const [visible, setVisible] = useState(() => {
    try {
      return !localStorage.getItem(STORAGE_KEY);
    } catch {
      return false;
    }
  });

  const dismiss = () => {
    try {
      localStorage.setItem(STORAGE_KEY, '1');
    } catch {
      // ignore storage failure — just hide for this session
    }
    setVisible(false);
  };

  if (!visible) return null;

  return (
    <div className="migration-notice" role="note" aria-label="Change notice">
      <div className="migration-notice__body">{BODY}</div>
      <button
        className="migration-notice__dismiss"
        aria-label="Dismiss"
        onClick={dismiss}
      >
        Got it
      </button>
    </div>
  );
}
