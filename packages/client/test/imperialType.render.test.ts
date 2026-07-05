/**
 * Imperial formula type tests (docs/specs/inline-formulas.md) — formula type #3. Type logic
 * (recognize gating / evaluate) + the ' = <total>' renderOutput. The pure parse/format math is covered in
 * imperialParse; the bracket-path PM integration + math-disjointness at the registry level is in
 * formulaPlugin.render.
 */
import { describe, it, expect } from 'vitest';
import { imperialType } from '../src/plugins/imperial/imperialType.js';

describe('imperialType.recognize — claims iff unambiguously imperial', () => {
  it('claims content carrying a unit mark', () => {
    expect(imperialType.recognize("12'")).toBe("12'");
    expect(imperialType.recognize(`5' 3"`)).toBe(`5' 3"`);
    expect(imperialType.recognize('4’5”')).toBe('4’5”');
  });

  it('claims content with a label (even bare-number tokens)', () => {
    expect(imperialType.recognize('Trim: 12 4')).toBe('Trim: 12 4');
    expect(imperialType.recognize('Trim: 12, 123” 4 4’5” 12-15/16” 12’6”'))
      .toBe('Trim: 12, 123” 4 4’5” 12-15/16” 12’6”');
  });

  it('trims surrounding whitespace on the stored spec', () => {
    expect(imperialType.recognize("  12'  ")).toBe("12'");
  });

  it('DECLINES a bare number (no label, no mark) → falls through to math', () => {
    expect(imperialType.recognize('12')).toBeNull();
    expect(imperialType.recognize('12 4')).toBeNull();
  });

  it('DECLINES an unparseable token / prose', () => {
    expect(imperialType.recognize('Trim: abc')).toBeNull();
    expect(imperialType.recognize('hello world')).toBeNull();
    expect(imperialType.recognize('3:30')).toBeNull(); // a time, not a label
  });
});

describe('imperialType.evaluate — sum → formatted total', () => {
  it('the worked example → 44′ 2-15/16″', () => {
    expect(imperialType.evaluate('Trim: 12, 123” 4 4’5” 12-15/16” 12’6”', null))
      .toEqual({ ok: true, display: '44′ 2-15/16″' });
  });

  it('a simple two-token sum rolls inches into feet', () => {
    expect(imperialType.evaluate(`5' 3"`, null)).toEqual({ ok: true, display: '5′ 3″' }); // 60+3=63" → 5′ 3″
  });

  it('ok:false on a malformed spec (never throws)', () => {
    expect(imperialType.evaluate('Trim: abc', null).ok).toBe(false);
    expect(imperialType.evaluate('', null).ok).toBe(false);
  });
});

describe('imperialType.renderOutput — mirrors math’s " = value"', () => {
  const ctx = { state: null, setState: () => {} };

  it('renders " = <total>" with the total in .formula-output__value', () => {
    const spec = 'Trim: 12, 123” 4 4’5” 12-15/16” 12’6”';
    const el = imperialType.renderOutput(spec, imperialType.evaluate(spec, null), ctx);
    expect(el.className).toContain('formula-output--imperial');
    expect(el.textContent).toBe(' = 44′ 2-15/16″');
    expect(el.querySelector('.formula-output__value')?.textContent).toBe('44′ 2-15/16″');
  });

  it('renders a subtle " = ?" on a malformed spec (never crashes)', () => {
    const el = imperialType.renderOutput('nope', imperialType.evaluate('nope', null), ctx);
    expect(el.className).toContain('formula-output--error');
    expect(el.textContent).toBe(' = ?');
    expect(el.querySelector('.formula-output__value')).toBeNull();
  });
});
