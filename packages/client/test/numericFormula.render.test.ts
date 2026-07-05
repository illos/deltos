/**
 * NumericFormula substrate tests (docs/specs/formula-engine.md §2) — the shared shape math + imperial both
 * implement. Covers the two per-type cores directly at the substrate seam (toNumber's canonical unit +
 * format), the evaluateNumeric bridge (null → { ok:false }), and the shared ' = value' output DOM the two
 * types previously duplicated. Behavior-preservation of the full types is proven by the untouched existing
 * suites (mathEngine / imperialParse / imperialType.render / formulaPlugin.render / imperialPlugin.render).
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateNumeric,
  numericRenderOutput,
  EMPTY_ENV,
  type NumericFormula,
} from '../src/plugins/formula/numericFormula.js';
import { mathNumeric } from '../src/plugins/math/mathType.js';
import { imperialNumeric } from '../src/plugins/imperial/imperialType.js';

describe('mathNumeric — canonical unit is the bare number', () => {
  it('parses an expression to its scalar', () => {
    expect(mathNumeric.toNumber('2+2', EMPTY_ENV)).toBe(4);
    expect(mathNumeric.toNumber('1 + 4 - 2 / 10', EMPTY_ENV)).toBe(4.8);
  });

  it('malformed / div0 → null (never throws)', () => {
    expect(mathNumeric.toNumber('2 +', EMPTY_ENV)).toBeNull();
    expect(mathNumeric.toNumber('1/0', EMPTY_ENV)).toBeNull();
    expect(mathNumeric.toNumber('', EMPTY_ENV)).toBeNull();
  });

  it('formats as plain decimal', () => {
    expect(mathNumeric.format(4.8)).toBe('4.8');
    expect(mathNumeric.format(20)).toBe('20');
  });
});

describe('imperialNumeric — canonical unit is INCHES', () => {
  it('parses a measurement list to total inches', () => {
    expect(imperialNumeric.toNumber(`5' 3"`, EMPTY_ENV)).toBe(63);
    expect(imperialNumeric.toNumber('Trim: 12, 123” 4 4’5” 12-15/16” 12’6”', EMPTY_ENV)).toBe(530.9375);
  });

  it('malformed → null (never throws)', () => {
    expect(imperialNumeric.toNumber('Trim: abc', EMPTY_ENV)).toBeNull();
    expect(imperialNumeric.toNumber('', EMPTY_ENV)).toBeNull();
  });

  it('formats inches as feet + inches rounded UP to 1/32', () => {
    expect(imperialNumeric.format(530.9375)).toBe('44′ 2-15/16″');
    expect(imperialNumeric.format(0)).toBe('0″');
  });

  it('a ZERO total is a real value, not a failure (0 ≠ null through the bridge)', () => {
    expect(imperialNumeric.toNumber('0', EMPTY_ENV)).toBe(0);
    expect(evaluateNumeric(imperialNumeric, '0')).toEqual({ ok: true, display: '0″' });
  });
});

describe('evaluateNumeric — the FormulaOutput bridge', () => {
  it('ok:true + formatted display on a parseable spec', () => {
    expect(evaluateNumeric(mathNumeric, '10 x 2')).toEqual({ ok: true, display: '20' });
    expect(evaluateNumeric(imperialNumeric, `5' 3"`)).toEqual({ ok: true, display: '5′ 3″' });
  });

  it('ok:false on null (no display)', () => {
    expect(evaluateNumeric(mathNumeric, 'nope')).toEqual({ ok: false });
  });

  it('EMPTY_ENV resolves nothing (the Phase-0 default)', () => {
    expect(EMPTY_ENV.resolveRef('anything')).toBeNull();
  });

  it('env is handed through to toNumber (the future-references seam)', () => {
    const probe: NumericFormula = {
      toNumber: (_spec, env) => env.resolveRef('Y'),
      format: String,
    };
    expect(evaluateNumeric(probe, '', { resolveRef: (k) => (k === 'Y' ? 4 : null) }))
      .toEqual({ ok: true, display: '4' });
  });
});

describe('numericRenderOutput — the shared " = value" DOM', () => {
  it('ok output: type-suffixed class + emphasized value', () => {
    const render = numericRenderOutput('math');
    const el = render('2+2', { ok: true, display: '4' }, { state: null, setState: () => {} });
    expect(el.className).toBe('formula-output formula-output--math');
    expect(el.textContent).toBe(' = 4');
    expect(el.querySelector('.formula-output__value')?.textContent).toBe('4');
    expect(el.contentEditable).toBe('false');
  });

  it('error output: subtle " = ?" with the error class', () => {
    const render = numericRenderOutput('imperial');
    const el = render('nope', { ok: false }, { state: null, setState: () => {} });
    expect(el.className).toBe('formula-output formula-output--imperial formula-output--error');
    expect(el.textContent).toBe(' = ?');
    expect(el.querySelector('.formula-output__value')).toBeNull();
  });
});
