/**
 * Security disclosure banner — rendered at credential-establishment points only:
 * enroll, recovery, QR-join. Never on the day-to-day launch path.
 *
 * Uniform copy (Option-A, planSys-approved): one honest statement of device-local
 * lock-screen-grade at-rest custody. The prf prop is retained but ignored — the
 * disclosure is the same for all devices under Option-A.
 *
 * Copy: planSys approved, secSys honesty-recheck in progress.
 */

const TITLE = ‘Your notes on this device’;

// planSys definitive synthesis — supersedes all prior drafts. Wired verbatim.
const BODY =
  "Your notes are stored on this device and protected by its lock screen — no extra password needed day-to-day. " +
  "There’s no separate lock on the notes themselves, though: once this device is unlocked, your notes are open, " +
  "so anyone who can use it while it is unlocked, or copy its storage, could read your account and notes. " +
  "To use your notes on another device — or after clearing your browser data — you’ll need your recovery phrase.";

interface DisclosureProps {
  /** Ignored under Option-A — kept so existing call sites don't need a simultaneous update. */
  prf?: boolean;
  /** Custom content — overrides the standard body when provided. */
  children?: React.ReactNode;
}

export function Disclosure({ children }: DisclosureProps) {
  return (
    <div className="disclosure" role="note" aria-label="Security information">
      <div className="disclosure__title">ℹ {TITLE}</div>
      <div className="disclosure__body">
        {children ?? BODY}
      </div>
    </div>
  );
}
