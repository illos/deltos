/**
 * Imperial-units parser/formatter (pure) — the input→output core of the imperial formula type
 * (docs/specs/inline-formulas.md; feature: [Trim: …] adder). Written test-first: a rich corpus of
 * per-token → inches, full-string sums, and the round-UP-to-1/32 formatter. The FormulaType wrapper +
 * the PM bracket-path integration live in imperialType.render / formulaPlugin.render.
 *
 * Unit marks are handled BOTH straight and curly (iOS auto-smart-quotes turns ' " into ’ ” ′ ″).
 */
import { describe, it, expect } from 'vitest';
import { parseImperial, formatInches } from '../src/plugins/imperial/imperialParse.js';

/** Convenience: parse a single token/string to total inches (null on failure). */
const inches = (s: string): number | null => parseImperial(s)?.totalInches ?? null;

describe('parseImperial — per-token value in inches', () => {
  it('a bare number is FEET (no unit mark → feet)', () => {
    expect(inches('12')).toBe(144); // 12 ft
    expect(inches('4')).toBe(48);   // 4 ft
  });

  it('an inches-marked token (straight and curly)', () => {
    expect(inches('123"')).toBe(123);
    expect(inches('123”')).toBe(123);
    expect(inches('6"')).toBe(6);
  });

  it('a feet-marked token (straight and curly)', () => {
    expect(inches("1/2'")).toBe(6);   // half a foot
    expect(inches('1/2’')).toBe(6);
    expect(inches("5'")).toBe(60);
  });

  it('a combined feet+inch token (straight and curly)', () => {
    expect(inches(`4'5"`)).toBe(53);  // 4ft + 5in
    expect(inches('4’5”')).toBe(53);
    expect(inches(`12'6"`)).toBe(150); // 12ft + 6in
    expect(inches('12’6”')).toBe(150);
  });

  it('whole-plus-fraction and bare-fraction inches (the - is a whole/frac separator, same unit)', () => {
    expect(inches('12-15/16"')).toBe(12.9375);
    expect(inches('12-15/16”')).toBe(12.9375);
    expect(inches('15/16"')).toBe(0.9375);
  });

  it('a decimal measure', () => {
    expect(inches('4.5"')).toBe(4.5);
    expect(inches("2.5'")).toBe(30); // 2.5 ft
  });
});

describe('parseImperial — full strings (sum), commas + whitespace separators', () => {
  it('straight and curly "5 3" split into two tokens summed', () => {
    expect(inches(`5' 3"`)).toBe(63);
    expect(inches('5’ 3”')).toBe(63);
  });

  it('the worked example: label stripped, six tokens summed', () => {
    // Trim: 12(=144) 123”(=123) 4(=48) 4’5”(=53) 12-15/16”(=12.9375) 12’6”(=150) = 530.9375
    const p = parseImperial('Trim: 12, 123” 4 4’5” 12-15/16” 12’6”');
    expect(p).not.toBeNull();
    expect(p!.totalInches).toBe(530.9375);
    expect(p!.hasLabel).toBe(true);
    expect(p!.hasMark).toBe(true);
  });

  it('a comma with no space still separates tokens', () => {
    expect(inches("1',2'")).toBe(36); // 12 + 24
  });
});

describe('parseImperial — label handling', () => {
  it('strips a leading "word:" label without affecting the math', () => {
    const p = parseImperial('Trim: 12 4');
    expect(p!.totalInches).toBe(192); // 144 + 48
    expect(p!.hasLabel).toBe(true);
  });

  it('a multi-word label (letters/digits/spaces) is allowed', () => {
    const p = parseImperial('Board 2: 12');
    expect(p!.hasLabel).toBe(true);
    expect(p!.totalInches).toBe(144);
  });

  it('a leading digit token (e.g. a time 3:30) is NOT a label → fails to parse', () => {
    expect(parseImperial('3:30')).toBeNull();
  });
});

describe('parseImperial — flags for recognize() gating', () => {
  it('bare numbers only → parses but hasMark:false, hasLabel:false', () => {
    const p = parseImperial('12');
    expect(p).not.toBeNull();
    expect(p!.hasMark).toBe(false);
    expect(p!.hasLabel).toBe(false);
  });

  it('a unit mark sets hasMark:true', () => {
    expect(parseImperial("12'")!.hasMark).toBe(true);
    expect(parseImperial('12"')!.hasMark).toBe(true);
  });

  it('returns null when ANY token is unparseable', () => {
    expect(parseImperial('Trim: abc')).toBeNull();
    expect(parseImperial('12 abc')).toBeNull();
    expect(parseImperial('hello world')).toBeNull();
    expect(parseImperial('')).toBeNull();
    expect(parseImperial('   ')).toBeNull();
  });

  it('a feet mark with trailing junk (no inch mark) fails', () => {
    expect(parseImperial("4'5")).toBeNull(); // 4ft then bare 5 with no inch mark → ambiguous → reject
  });

  it('a zero denominator fraction fails', () => {
    expect(parseImperial('1/0"')).toBeNull();
  });
});

describe('formatInches — round UP to 1/32, feet/inch/fraction rendering (′ ″)', () => {
  it('the worked example renders exactly 44′ 2-15/16″', () => {
    expect(formatInches(530.9375)).toBe('44′ 2-15/16″');
  });

  it('inches only, no feet', () => {
    expect(formatInches(6)).toBe('6″');
  });

  it('rolls inches into feet at 12', () => {
    expect(formatInches(16)).toBe('1′ 4″');
    expect(formatInches(12)).toBe('1′');
  });

  it('reduces the 1/32 fraction to lowest terms', () => {
    expect(formatInches(16 / 32)).toBe('1/2″');   // 16/32 → 1/2
    expect(formatInches(8 / 32)).toBe('1/4″');    // 8/32 → 1/4
    expect(formatInches(4 / 32)).toBe('1/8″');    // 4/32 → 1/8
    expect(formatInches(2 / 32)).toBe('1/16″');   // 2/32 → 1/16
    expect(formatInches(1 / 32)).toBe('1/32″');   // 1/32 stays
  });

  it('a whole-inch + fraction joins with a dash; a pure fraction has no leading dash', () => {
    expect(formatInches(2 + 15 / 16)).toBe('2-15/16″');
    expect(formatInches(15 / 16)).toBe('15/16″'); // exact 15/16 does NOT round up to 31/32
  });

  it('rounds UP to the next 1/32 (never down)', () => {
    expect(formatInches(2.01)).toBe('2-1/32″'); // 2.01" → up to 2 1/32"
  });

  it('zero renders as 0″', () => {
    expect(formatInches(0)).toBe('0″');
  });
});
