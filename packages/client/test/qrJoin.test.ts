import { describe, it, expect } from 'vitest';
import { encodeQrPayload, decodeQrPayload, generateConfirmationCode } from '../src/identity/qrJoin.js';

/** A plausible 24-word BIP39 mnemonic (the ABANDON×23+ABOUT vector). */
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon ' +
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

// ── encodeQrPayload / decodeQrPayload roundtrip ────────────────────────────────────────────────

describe('encodeQrPayload + decodeQrPayload', () => {
  it('roundtrips the mnemonic through encode → decode', () => {
    const payload = encodeQrPayload(TEST_MNEMONIC);
    expect(decodeQrPayload(payload)).toBe(TEST_MNEMONIC);
  });

  it('encoded payload starts with the deltos:join: prefix', () => {
    const payload = encodeQrPayload(TEST_MNEMONIC);
    expect(payload.startsWith('deltos:join:')).toBe(true);
  });

  it('encoded payload ends with the mnemonic verbatim (no base64 or encoding)', () => {
    const payload = encodeQrPayload(TEST_MNEMONIC);
    expect(payload.endsWith(TEST_MNEMONIC)).toBe(true);
  });
});

// ── decodeQrPayload — invalid inputs ──────────────────────────────────────────────────────────

describe('decodeQrPayload — invalid inputs', () => {
  it('returns null for content without the deltos:join: prefix', () => {
    expect(decodeQrPayload('abandon abandon abandon')).toBeNull();
    expect(decodeQrPayload('https://example.com/join/abandon')).toBeNull();
    expect(decodeQrPayload('')).toBeNull();
  });

  it('returns null for the prefix alone (empty mnemonic after prefix)', () => {
    expect(decodeQrPayload('deltos:join:')).toBeNull();
    expect(decodeQrPayload('deltos:join:   ')).toBeNull(); // whitespace-only mnemonic
  });

  it('returns the trimmed mnemonic when there is surrounding whitespace', () => {
    const payload = `deltos:join:  ${TEST_MNEMONIC}  `;
    expect(decodeQrPayload(payload)).toBe(TEST_MNEMONIC);
  });
});

// ── generateConfirmationCode ───────────────────────────────────────────────────────────────────

describe('generateConfirmationCode', () => {
  it('returns a 6-character string', () => {
    const code = generateConfirmationCode();
    expect(code).toHaveLength(6);
  });

  it('contains only digit characters (000000–999999)', () => {
    const code = generateConfirmationCode();
    expect(/^\d{6}$/.test(code)).toBe(true);
  });

  it('is left-padded with zeros for values below 100000', () => {
    // Generate many codes to catch at least one < 100000 in the range 000000–099999.
    // With 1M space, ~10% of codes are < 100000; 50 draws have ~5^-7 chance of all ≥ 100000.
    const codes = Array.from({ length: 50 }, () => generateConfirmationCode());
    // All codes must be exactly 6 chars regardless of numeric value
    for (const code of codes) {
      expect(code).toHaveLength(6);
      expect(/^\d{6}$/.test(code)).toBe(true);
    }
  });

  it('returns different codes on consecutive calls (statistical — near-zero false-positive risk)', () => {
    // P(all 20 codes identical) = (1/1000000)^19 ≈ 10^-114
    const codes = new Set(Array.from({ length: 20 }, () => generateConfirmationCode()));
    expect(codes.size).toBeGreaterThan(1);
  });
});
