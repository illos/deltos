/**
 * D5 disclosure banner — rendered when getEnrollmentPrfStatus() returns usesPrf === false.
 *
 * ACCEPTANCE CONDITION (planSys done-gate, secSys PIN-ID-6 clearance):
 *   This disclosure MUST be shown on any enroll or unlock surface where the device binding
 *   is device-local (no PRF). Omitting it voids secSys's clearance of the no-PRF path.
 *   The copy below is a DRAFT pending planSys approval.
 */

interface DisclosureProps {
  /** Omit to show the default no-PRF disclosure. */
  children?: React.ReactNode;
}

/**
 * D5 disclosure copy — DRAFT for planSys approval.
 *
 * Honest statement of the no-PRF storage limitation in plain language.
 * planSys: please review wording and obtain user sign-off before shipping.
 */
const DISCLOSURE_DRAFT_TITLE = 'Security notice for this device';
const DISCLOSURE_DRAFT_BODY =
  'Your passkey on this device does not support cryptographic key binding (the PRF extension). ' +
  'deltos falls back to storing the decryption key for your identity in this browser\'s local storage — ' +
  'it is not itself encrypted by your passkey. ' +
  'Anyone who can read this browser\'s storage files (through malware, or with physical access to an unlocked device) ' +
  'could potentially access your notes. ' +
  'For stronger protection, use this app on a device where your passkey supports PRF binding ' +
  '(most modern iPhones with Face ID, Android devices with biometrics, and hardware security keys).';

export function Disclosure({ children }: DisclosureProps) {
  return (
    <div className="disclosure" role="alert">
      <div className="disclosure__title">⚠ {DISCLOSURE_DRAFT_TITLE}</div>
      <div className="disclosure__body">
        {children ?? DISCLOSURE_DRAFT_BODY}
      </div>
    </div>
  );
}
