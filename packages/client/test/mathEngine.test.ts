import { describe, it, expect } from 'vitest';
import { evaluate, detectTrailingExpression } from '../src/plugins/math/mathEngine.js';

/**
 * Inline-math ENGINE tests (docs/specs/inline-math.md §2). TDD: Jim's 4 examples + standard precedence,
 * decimals, negatives, parens, div-by-zero, malformed, and the trigger predicate (true/false incl. the
 * prose negatives). Also pins the HARD rule's observable contract: malformed input never throws.
 */

/** Helper: assert a successful evaluation equals the expected clean value. */
const val = (expr: string) => {
  const r = evaluate(expr);
  expect(r.ok, `${expr} should evaluate`).toBe(true);
  return (r as { ok: true; value: number }).value;
};

describe('evaluate — Jim\'s examples', () => {
  it('1 + 1 = 2', () => { expect(val('1 + 1')).toBe(2); });
  it('10 / 10 = 1', () => { expect(val('10 / 10')).toBe(1); });
  it('10 x 2 = 20 (x is multiply)', () => { expect(val('10 x 2')).toBe(20); });
  it('1 + 4 - 2 / 10 = 4.8 (precedence: / before +/-) with NO float noise', () => {
    expect(val('1 + 4 - 2 / 10')).toBe(4.8);
  });
});

describe('evaluate — operators, precedence, aliases', () => {
  it('honours * / before + -', () => {
    expect(val('2 + 3 * 4')).toBe(14);
    expect(val('20 - 12 / 4')).toBe(17);
  });
  it('left-associates same-precedence ops', () => {
    expect(val('10 - 3 - 2')).toBe(5);
    expect(val('100 / 10 / 2')).toBe(5);
  });
  it('treats x, X, ×, *, ÷ as aliases', () => {
    expect(val('3 x 4')).toBe(12);
    expect(val('3 X 4')).toBe(12);
    expect(val('3 × 4')).toBe(12);
    expect(val('3 * 4')).toBe(12);
    expect(val('12 ÷ 4')).toBe(3);
  });
  it('tolerates no surrounding whitespace', () => {
    expect(val('10x2')).toBe(20);
    expect(val('1+1')).toBe(2);
  });
});

describe('evaluate — decimals, negatives, parentheses', () => {
  it('decimals', () => { expect(val('0.1 + 0.2')).toBe(0.3); }); // float-noise killed
  it('a leading decimal point', () => { expect(val('.5 + .5')).toBe(1); });
  it('negative numbers (unary minus)', () => {
    expect(val('-5 + 2')).toBe(-3);
    expect(val('3 * -2')).toBe(-6);
    expect(val('-3 - -3')).toBe(0);
  });
  it('parentheses override precedence', () => {
    expect(val('(1 + 4 - 2) / 10')).toBe(0.3);
    expect(val('2 * (3 + 4)')).toBe(14);
    expect(val('-(2 + 3)')).toBe(-5);
  });
  it('trims trailing zeros / integer results show clean', () => {
    expect(val('4.50 + 0.50')).toBe(5);
    expect(val('2.0 * 2.0')).toBe(4);
  });
});

describe('evaluate — failures never throw (return ok:false)', () => {
  it('division by zero', () => {
    expect(evaluate('1 / 0').ok).toBe(false);
    expect(evaluate('5 / (3 - 3)').ok).toBe(false);
  });
  it('malformed expressions', () => {
    // NB: '1 + +2' is NOT here — it parses as 1 + (+2) = 3 via unary plus, the same mechanism that gives
    // negatives ('3 * -2'). Permissive but safe + consistent; the bar is "never throw / never wrong", met.
    for (const bad of ['1 +', '+ ', '(1 + 2', '1 + 2)', '* 5', '1 2', '', '   ', '1 + ', '/ 2']) {
      expect(evaluate(bad).ok, bad).toBe(false);
    }
  });
  it('unknown characters (no eval / never executes the string)', () => {
    for (const bad of ['1 + a', 'alert(1)', '2 ** 3', '1 % 2', 'console.log(1)', '1; 2']) {
      expect(evaluate(bad).ok, bad).toBe(false);
    }
  });
});

describe('detectTrailingExpression — the "=" trigger predicate', () => {
  it('returns the trailing run for a valid numeric expression', () => {
    expect(detectTrailingExpression('1 + 1')).toBe('1 + 1');
    expect(detectTrailingExpression('10 / 10')).toBe('10 / 10');
    expect(detectTrailingExpression('10 x 2')).toBe('10 x 2');
  });
  it('fires mid-sentence on the trailing numeric run only', () => {
    expect(detectTrailingExpression('I paid 10 x 2')).toBe('10 x 2');
    expect(detectTrailingExpression('total = 5 + 3')).toBe('5 + 3'); // the prose head is ignored
  });
  it('does NOT fire on prose (tails that are not numeric expressions)', () => {
    expect(detectTrailingExpression('name = value')).toBeNull();
    expect(detectTrailingExpression('x = y')).toBeNull();
    expect(detectTrailingExpression('hello world')).toBeNull();
    expect(detectTrailingExpression('the fox')).toBeNull();
  });
  it('requires at least one BINARY operator (a bare number or a lone sign → null)', () => {
    expect(detectTrailingExpression('42')).toBeNull();
    expect(detectTrailingExpression('-5')).toBeNull();
    expect(detectTrailingExpression('3.14')).toBeNull();
  });
  it('does not fire on an unparseable trailing run', () => {
    expect(detectTrailingExpression('1 +')).toBeNull();
    expect(detectTrailingExpression('fox x 2')).toBeNull(); // 'x 2' is a leading operator → unparseable
  });
  it('ignores trailing whitespace', () => {
    expect(detectTrailingExpression('10 x 2   ')).toBe('10 x 2');
  });
});
