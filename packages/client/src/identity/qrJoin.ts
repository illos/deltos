/**
 * QR-join protocol utilities — implements the receiving side of PIN-ID-7.
 *
 * Threat model (from stream-a-auth-strawman §7):
 *   QR encodes the raw mnemonic — possession of it is FULL TAKEOVER. The out-of-band
 *   confirmation code (generated on the RECEIVING device and shown to the SENDER in person)
 *   stops a silently-intercepted QR from being used: the attacker cannot know the code, so
 *   the sender's verbal confirmation step must fail for them.
 *
 * Protocol:
 *   1. Sender   — calls `encodeQrPayload(mnemonic)` and displays the resulting QR.
 *   2. Receiver — scans QR → `decodeQrPayload(content)` → mnemonic (or null if invalid).
 *   3. Receiver — calls `generateConfirmationCode()` and displays the code on-screen.
 *   4. Sender   — reads the displayed code aloud (out-of-band, in-person).
 *   5. Receiver — user taps "Confirmed" → `keyStore.enrollExisting(mnemonic)` + register with server.
 *
 * D5 DISCLOSURE OBLIGATION (planSys done-gate, pin from secSys):
 *   After `keyStore.enrollExisting(mnemonic)` the UI MUST call `getEnrollmentPrfStatus()` from
 *   `webAuthnKeyStore.ts` and render an honest disclosure if `usesPrf === false` — the wrapping
 *   key is stored plaintext in IndexedDB and a local storage-read attacker could recover it.
 *   This disclosure is an ACCEPTANCE CONDITION for Phase-1 (secSys ruling on PIN-ID-6 baseline).
 */

/** Identifies a QR payload as a deltos join invitation. */
const QR_PAYLOAD_PREFIX = 'deltos:join:';

/**
 * Encode a mnemonic into the canonical QR payload string the sender device displays.
 * The mnemonic is embedded verbatim after the prefix — BIP39 words are all lowercase ASCII.
 */
export function encodeQrPayload(mnemonic: string): string {
  return `${QR_PAYLOAD_PREFIX}${mnemonic}`;
}

/**
 * Decode the raw string from a scanned QR code and extract the mnemonic.
 * Returns null for any input that is not a valid deltos join payload.
 * The caller is responsible for passing the extracted mnemonic to `keyStore.enrollExisting()`.
 */
export function decodeQrPayload(content: string): string | null {
  if (!content.startsWith(QR_PAYLOAD_PREFIX)) return null;
  const mnemonic = content.slice(QR_PAYLOAD_PREFIX.length).trim();
  if (mnemonic.length === 0) return null;
  return mnemonic;
}

/**
 * Generate a 6-digit confirmation code for out-of-band in-person verification (PIN-ID-7).
 * The sender verifies this code verbally before the receiver calls `enrollExisting`. This
 * prevents a silently-intercepted QR from being used without the sender's knowledge.
 *
 * The code is padded to 6 digits so each party reads and confirms the same width string
 * (a 4-digit code `0042` is read as "zero zero four two", not "forty-two").
 */
export function generateConfirmationCode(): string {
  const buf = crypto.getRandomValues(new Uint32Array(1));
  const n = buf[0] ?? 0;
  return (n % 1_000_000).toString().padStart(6, '0');
}
