/**
 * MigrationNotice — one-time notice shown when at-rest protection transitions from
 * passkey-bound (PRF) to device-local lock-screen (Option-A silent rewrap).
 *
 * Copy: planSys final (B) with residual-risk echo, secSys PASSED.
 * Mounting + show-once logic: caller's responsibility (UnlockRoute reads
 * useAuthStore().justMigratedToDeviceLocal and calls clearMigrationNotice() on dismiss).
 */

// planSys final (B), secSys PASSED. Wired verbatim.
const BODY =
  "Heads up — we've changed how your notes are protected on this device. " +
  "They're now secured by your device's lock screen rather than your passkey. " +
  "Day-to-day, your notes open instantly with no extra step; the trade is that the protection is your device lock, nothing more — " +
  "so anyone who can use this device while it is unlocked, or copy its storage, could read your notes. " +
  "Your notes and recovery phrase are unchanged.";

interface MigrationNoticeProps {
  onDismiss: () => void;
}

export function MigrationNotice({ onDismiss }: MigrationNoticeProps) {
  return (
    <div className="migration-notice" role="note" aria-label="Change notice">
      <div className="migration-notice__body">{BODY}</div>
      <button
        className="migration-notice__dismiss"
        aria-label="Dismiss"
        onClick={onDismiss}
      >
        Got it
      </button>
    </div>
  );
}
