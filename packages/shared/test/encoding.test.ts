import { describe, it, expect } from 'vitest';
import { base64urlEncode, base64urlDecode } from '../src/auth/encoding.js';

/**
 * base64url is the ONE binary↔text encoding the auth layer agrees on across the client and the
 * worker: the client computes `Identity.id = base64urlEncode(SHA-256(signingPublicKey))` and the
 * server computes `accountFingerprint` the same way (F2). If these two implementations ever
 * disagreed by a single character, the server's fingerprint↔key binding would silently break, so
 * the codec is pinned to RFC 4648 §5 (URL-safe alphabet, NO padding) by vector.
 */

const bytes = (...b: number[]) => new Uint8Array(b);
const ascii = (s: string) => new TextEncoder().encode(s);

describe('base64urlEncode', () => {
  // RFC 4648 §10 progression — exercises every byte-group remainder (0/1/2 trailing bytes).
  it.each([
    ['', ''],
    ['f', 'Zg'],
    ['fo', 'Zm8'],
    ['foo', 'Zm9v'],
    ['foob', 'Zm9vYg'],
    ['fooba', 'Zm9vYmE'],
    ['foobar', 'Zm9vYmFy'],
  ])('encodes %o to %o with no padding', (input, expected) => {
    expect(base64urlEncode(ascii(input))).toBe(expected);
  });

  it('uses the URL-safe alphabet (- and _, never + or /)', () => {
    expect(base64urlEncode(bytes(0xff, 0xff, 0xff))).toBe('____');
    expect(base64urlEncode(bytes(0xfb, 0xff, 0xbf))).toBe('-_-_');
  });
});

describe('base64urlDecode', () => {
  it('round-trips every byte value', () => {
    const all = new Uint8Array(256).map((_, i) => i);
    expect(base64urlDecode(base64urlEncode(all))).toEqual(all);
  });

  it('decodes URL-safe input without padding', () => {
    expect(base64urlDecode('-_-_')).toEqual(bytes(0xfb, 0xff, 0xbf));
    expect(base64urlDecode('Zm9vYmFy')).toEqual(ascii('foobar'));
  });
});
