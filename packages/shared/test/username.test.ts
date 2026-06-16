import { describe, it, expect } from 'vitest';
import { normalizeUsername, UsernameClaimRequestSchema, USERNAME_RESERVED } from '../src/auth/username.js';

/**
 * The username directory layer (D6, account-identity). `normalizeUsername` is the PURE boundary
 * function that decides the uniqueness key (the NFKC + casefold *normalized* form) and the display
 * form, or rejects with a typed reason. Two invariants under test drive everything downstream:
 *
 *   1. UNIQUENESS IS DECIDED ON THE FOLDED FORM (secSys S1) — `Alice` / `alice` / `ALICE` and the
 *      fullwidth `ＡＬＩＣＥ` must all collapse to ONE normalized key, so the atomic-unique claim in the
 *      store cannot be raced by a casing/compatibility variant.
 *   2. CONSERVATIVE CHARSET kills confusables/homoglyphs at the boundary (secSys S1) — only
 *      `[a-z0-9_-]`, 3–32, must start alphanumeric; zero-width/control chars rejected explicitly.
 *
 * These are the authenticated-claim normalization rules; the endpoint runs THIS, never its own.
 */

const ok = (raw: string) => {
  const r = normalizeUsername(raw);
  if (!r.ok) throw new Error(`expected ok, got reject: ${r.reason}`);
  return r.value;
};
const reason = (raw: string) => {
  const r = normalizeUsername(raw);
  return r.ok ? 'OK' : r.reason;
};

describe('normalizeUsername — folded-form uniqueness (secSys S1)', () => {
  it('casefolds: Alice / alice / ALICE collide on the normalized key', () => {
    expect(ok('Alice').normalized).toBe('alice');
    expect(ok('alice').normalized).toBe('alice');
    expect(ok('ALICE').normalized).toBe('alice');
  });

  it('preserves the as-typed casing in the display form', () => {
    expect(ok('Alice').display).toBe('Alice');
    expect(ok('AzureSky_7').display).toBe('AzureSky_7');
  });

  it('NFKC folds fullwidth to ASCII so the compatibility variant collides too', () => {
    // U+FF21.. fullwidth "ＡＬＩＣＥ" → "ALICE" → normalized "alice".
    expect(ok('ＡＬＩＣＥ').normalized).toBe('alice');
  });

  it('trims surrounding whitespace (incl. NBSP, which NFKC maps to a space) before claiming', () => {
    expect(ok('  alice  ').display).toBe('alice');
    expect(ok(' alice ').normalized).toBe('alice');
  });
});

describe('normalizeUsername — conservative charset + bounds (secSys S1)', () => {
  it('accepts a-z0-9_- with an alphanumeric start', () => {
    expect(reason('good_name-1')).toBe('OK');
    expect(reason('a1b')).toBe('OK');
  });

  it('rejects an empty / whitespace-only input', () => {
    expect(reason('')).toBe('empty');
    expect(reason('   ')).toBe('empty');
  });

  it('rejects too short (<3) and too long (>32)', () => {
    expect(reason('ab')).toBe('too-short');
    expect(reason('a'.repeat(33))).toBe('too-long');
    expect(reason('a'.repeat(32))).toBe('OK');
    expect(reason('abc')).toBe('OK');
  });

  it('rejects out-of-charset characters (spaces, dots, unicode letters/homoglyphs, emoji)', () => {
    expect(reason('bad name')).toBe('charset'); // inner space
    expect(reason('bad.name')).toBe('charset'); // dot
    expect(reason('café')).toBe('charset'); // accented latin survives NFKC, out of [a-z0-9_-]
    expect(reason('аlice')).toBe('charset'); // leading Cyrillic homoglyph "а" (U+0430)
    expect(reason('hi😀there')).toBe('charset'); // emoji
  });

  it('requires an alphanumeric first character (no leading _ or -)', () => {
    expect(reason('_alice')).toBe('leading');
    expect(reason('-alice')).toBe('leading');
  });

  it('rejects zero-width / control characters explicitly (not silently stripped)', () => {
    expect(reason('ali\u200bce')).toBe('control'); // embedded zero-width space
    expect(reason('ali\u0000ce')).toBe('control'); // embedded NUL control char
    expect(reason('al\ufeffice')).toBe('control'); // embedded BOM / zero-width no-break space
    // A *surrounding* zero-width is trimmed like any whitespace, so it folds to a valid name — only
    // an EMBEDDED one is a smuggling attempt; a trailing BOM is trimmed away, leaving a valid name.
    expect(reason('alice\ufeff')).toBe('OK');
  });
});

describe('normalizeUsername — reserved-name denylist (secSys S1)', () => {
  it('rejects reserved names case-insensitively', () => {
    expect(reason('admin')).toBe('reserved');
    expect(reason('ADMIN')).toBe('reserved');
    expect(reason('root')).toBe('reserved');
    expect(reason('deltos')).toBe('reserved');
    expect(reason('support')).toBe('reserved');
  });

  it('the denylist is non-empty and lowercase-normalized', () => {
    expect(USERNAME_RESERVED.size).toBeGreaterThan(0);
    for (const name of USERNAME_RESERVED) expect(name).toBe(name.toLowerCase());
  });
});

describe('UsernameClaimRequestSchema (.strict, fail-closed)', () => {
  it('accepts a bare { username }', () => {
    expect(UsernameClaimRequestSchema.safeParse({ username: 'alice' }).success).toBe(true);
  });

  it('REJECTS a body-supplied accountId — authz keys on the principal, never a body field (invariant i)', () => {
    const r = UsernameClaimRequestSchema.safeParse({ username: 'alice', accountId: 'attacker-account' });
    expect(r.success).toBe(false);
  });

  it('rejects a missing username and a non-string username', () => {
    expect(UsernameClaimRequestSchema.safeParse({}).success).toBe(false);
    expect(UsernameClaimRequestSchema.safeParse({ username: 123 }).success).toBe(false);
  });
});
