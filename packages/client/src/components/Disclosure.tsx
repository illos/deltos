/**
 * Security disclosure banner -- at-rest residual-risk (copy A, planSys @2cd2958).
 * Rendered at credential-establishment paths (sign-up + login reaffirm).
 *
 * secSys hard requirement: honest, device/OS-level, not-E2EE, local-read attacker.
 * Copy: planSys approved. The prf prop is retained but ignored -- uniform under Option-A.
 */

const TITLE = 'How your notes are kept';

// Copy A -- planSys @2cd2958.
const BODY =
  "Your notes live on this device and sync to your account, so they're on all your devices." +
  " On this device they're protected by your device's own security" +
  " — they aren't end-to-end encrypted," +
  " so anyone who can unlock or read this device can read your notes." +
  " Treat them the way you'd treat notes in any everyday notes app.";

interface DisclosureProps {
  /** Ignored under Option-A -- kept so existing call sites don't need a simultaneous update. */
  prf?: boolean;
  /** Custom content -- overrides the standard body when provided. */
  children?: React.ReactNode;
}

export function Disclosure({ children }: DisclosureProps) {
  return (
    <div className="disclosure" role="note" aria-label="Security information">
      <div className="disclosure__title">{'ℹ'} {TITLE}</div>
      <div className="disclosure__body">
        {children ?? BODY}
      </div>
    </div>
  );
}
