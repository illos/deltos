/**
 * Step-2 substrate tests (formula-engine.md §6) — the shared label/reference layer as PURE logic:
 * extractLabel (the `Label:` tag lifted out of imperial into the substrate), refTokenName (the
 * `[Name]` / `[Name:total]` grammar + the `:total` → bare-label normalization, decision #4), bindRefs
 * (token → sentinel skeleton), and the ONE grammar production each numeric type gained — a sentinel
 * resolves through NumericEnv as a raw scalar in the type's canonical unit (math: number; imperial:
 * INCHES, never the feet default).
 */
import { describe, it, expect } from 'vitest';
import {
  extractLabel,
  bindRefs,
  refTokenName,
  REF_OPEN,
  REF_CLOSE,
} from '../src/plugins/formula/refBinding.js';
import { mathNumeric, mathType } from '../src/plugins/math/mathType.js';
import { imperialNumeric, imperialType } from '../src/plugins/imperial/imperialType.js';
import { EMPTY_ENV, type NumericEnv } from '../src/plugins/formula/numericFormula.js';
import { createDefaultFormulaRegistry } from '../src/plugins/formula/index.js';

const env = (bindings: Record<string, number>): NumericEnv => ({
  resolveRef: (key) => (key in bindings ? bindings[key]! : null),
});

describe('extractLabel — the substrate-common Label: tag', () => {
  it('splits a leading letter-led label off the body', () => {
    expect(extractLabel('Y: 2+2')).toEqual({ label: 'Y', body: '2+2' });
    expect(extractLabel('Trim: 12, 4’5”')).toEqual({ label: 'Trim', body: '12, 4’5”' });
    expect(extractLabel('Trim boards: 12')).toEqual({ label: 'Trim boards', body: '12' });
  });

  it('no label → body is the whole spec', () => {
    expect(extractLabel('2 + 2')).toEqual({ label: null, body: '2 + 2' });
  });

  it('a digit-led token (a time like 3:30) is NOT a label', () => {
    expect(extractLabel('3:30 + 5').label).toBeNull();
  });
});

describe('refTokenName — reference-token grammar + :total normalization (decision #4)', () => {
  it('a label-shaped token is its own name', () => {
    expect(refTokenName('Y')).toBe('Y');
    expect(refTokenName('Trim boards')).toBe('Trim boards');
  });

  it('[Label:total] normalizes to the bare label — one rule, one token', () => {
    expect(refTokenName('J:total')).toBe('J');
    expect(refTokenName('J : total')).toBe('J');
    expect(refTokenName('J:Total')).toBe('J'); // friendly case on the keyword
  });

  it('non-label-shaped content is NOT a reference', () => {
    expect(refTokenName('1 + 1')).toBeNull();
    expect(refTokenName('12')).toBeNull();
    expect(refTokenName('#ff0000')).toBeNull();
    expect(refTokenName('J:tot')).toBeNull(); // a colon suffix must be exactly :total
  });
});

describe('bindRefs — token → sentinel skeleton', () => {
  it('replaces reference tokens with indexed sentinels, in order', () => {
    const { skeleton, refs } = bindRefs('12 x [Y] / [Z]');
    expect(refs).toEqual(['Y', 'Z']);
    expect(skeleton).toBe(`12 x ${REF_OPEN}0${REF_CLOSE} / ${REF_OPEN}1${REF_CLOSE}`);
  });

  it('duplicate tokens keep separate sentinels but the same name (one binding)', () => {
    const { refs } = bindRefs('[Y] + [Y]');
    expect(refs).toEqual(['Y', 'Y']);
  });

  it('normalizes [J:total] to J at bind time — before any resolver sees it', () => {
    expect(bindRefs('2 x [J:total]').refs).toEqual(['J']);
  });

  it('a NON-label-shaped bracketed run stays literal (never a bogus reference)', () => {
    const { skeleton, refs } = bindRefs('[1 + 1] + 2');
    expect(refs).toEqual([]);
    expect(skeleton).toBe('[1 + 1] + 2'); // the grammar then fails on '[' → quiet decline
  });
});

describe('math — the reference production (sentinel → raw number)', () => {
  it('resolves references as raw scalars: 12 x [Y] / 2 with Y=4 → 24', () => {
    expect(mathNumeric.toNumber('12 x [Y] / 2', env({ Y: 4 }))).toBe(24);
  });

  it('the label tag never affects the math: "Y: 2+2" → 4', () => {
    expect(mathNumeric.toNumber('Y: 2+2', EMPTY_ENV)).toBe(4);
  });

  it('an unresolved reference fails the whole expression quietly (null, not a throw)', () => {
    expect(mathNumeric.toNumber('12 x [Y] / 2', EMPTY_ENV)).toBeNull();
  });

  it('recognize: label + references + the trailing "=" compute marker', () => {
    expect(mathType.recognize('Y: 2+2')).toBe('Y: 2+2'); // label kept visible in the spec
    expect(mathType.recognize('12 x [Y] / 2 =')).toBe('12 x [Y] / 2'); // '=' normalized out
    expect(mathType.recognize('12 x [Y] / 2')).toBe('12 x [Y] / 2');
    expect(mathType.recognize('A: [B]')).toBe('A: [B]'); // labeled alias — a ref IS computation intent
  });

  it('recognize regressions hold: bare numbers and prose still decline', () => {
    expect(mathType.recognize('5')).toBeNull();
    expect(mathType.recognize('note to self')).toBeNull();
    expect(mathType.recognize('1 + 1')).toBe('1 + 1');
  });
});

describe('imperial — the reference production (sentinel → raw INCHES, never feet)', () => {
  it('a bound ref reads as inches: "Total: [J] 6″" with J=12 → 18 inches (NOT 12 feet + 6)', () => {
    expect(imperialNumeric.toNumber('Total: [J] 6″', env({ J: 12 }))).toBe(18);
  });

  it('unresolved reference → null (quiet)', () => {
    expect(imperialNumeric.toNumber('Total: [J] 6″', EMPTY_ENV)).toBeNull();
  });

  it('recognize claims ref-bearing labeled specs (probe binding), keeps the spec verbatim', () => {
    expect(imperialType.recognize('Total: [J] 4’6”')).toBe('Total: [J] 4’6”');
  });

  it('pre-Step-2 behavior identical: Trim: still parses, bare numbers still mean feet', () => {
    expect(imperialNumeric.toNumber('Trim: 12, 4', EMPTY_ENV)).toBe(16 * 12);
  });
});

describe('registry precedence — imperial before math on labeled ambiguity (behavior-preserving)', () => {
  const registry = createDefaultFormulaRegistry();

  it('[Trim: 12-15/16] keeps resolving to IMPERIAL (mixed-number feet), exactly as pre-Step-2', () => {
    const match = registry.resolveBracket('Trim: 12-15/16');
    expect(match?.type.id).toBe('imperial');
  });

  it('[Y: 2+2] resolves to labeled MATH (imperial declines the +)', () => {
    const match = registry.resolveBracket('Y: 2+2');
    expect(match?.type.id).toBe('math');
    expect(match?.spec).toBe('Y: 2+2');
  });

  it('unlabeled unmarked arithmetic still routes to math: [12-15/16] and [1 + 1]', () => {
    expect(registry.resolveBracket('12-15/16')?.type.id).toBe('math');
    expect(registry.resolveBracket('1 + 1')?.type.id).toBe('math');
  });

  it('the registry NEVER self-claims a bare reference (doc-gated in the handlers)', () => {
    expect(registry.resolveBracket('Y')).toBeNull();
    expect(registry.resolveBracket('note to self')).toBeNull();
  });
});
