/**
 * Security disclosure banner — rendered at enroll and unlock for ALL devices.
 *
 * ACCEPTANCE CONDITION (planSys done-gate, secSys universal D5 ruling):
 *   Shown on ANY surface where an identity is enrolled or unlocked, regardless of PRF status.
 *   Omitting it (for any device) voids secSys's clearance.
 *
 *   prf=true  → PRF-bound device: passkey-assisted at-rest protection, but device lock screen
 *               is the primary guard; no claim of biometric/authenticator-grade at-rest security.
 *   prf=false → no-PRF device: decryption key stored device-locally; plaintext-in-IDB risk.
 *
 * Copy status: PENDING planSys approval (routed post-build).
 */

const TITLE = 'Security notice for this device';

const PRF_BODY =
  'Your notes are protected by your passkey and this device\'s lock screen. ' +
  'Anyone who can access this device\'s storage while it is unlocked — or extract it — ' +
  'may be able to reach your account and notes. ' +
  'Clearing browser data will log you out; you will need your recovery phrase to re-register on another device.';

const NO_PRF_BODY =
  'Your passkey on this device does not support cryptographic key binding (the PRF extension). ' +
  'deltos falls back to storing the decryption key for your identity in this browser\'s local storage — ' +
  'it is not itself encrypted by your passkey. ' +
  'Anyone who can read this browser\'s storage files (through malware, or with physical access to an unlocked device) ' +
  'could potentially access your notes. ' +
  'Clearing browser data will log you out; you will need your recovery phrase to re-register. ' +
  'For stronger protection, use this app on a device where your passkey supports PRF binding ' +
  '(recent iPhones, Android devices, and hardware security keys).';

interface DisclosureProps {
  /** true = PRF-bound device; false = no-PRF device-local fallback. */
  prf?: boolean;
  /** Custom content — overrides both body variants when provided. */
  children?: React.ReactNode;
}

export function Disclosure({ prf = false, children }: DisclosureProps) {
  return (
    <div className="disclosure" role="alert">
      <div className="disclosure__title">⚠ {TITLE}</div>
      <div className="disclosure__body">
        {children ?? (prf ? PRF_BODY : NO_PRF_BODY)}
      </div>
    </div>
  );
}
