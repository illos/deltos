/**
 * Inline-formula REGISTRY + math-type contract tests (docs/specs/inline-formulas.md §1) — the pure,
 * editor-agnostic framework layer (no ProseMirror). Covers the two resolution paths (auto-detect by
 * trigger char + bracket recognize), trigger-char enumeration, idempotent register, and the math type's
 * detect/recognize/evaluate. The PM node/NodeView wiring is covered in formulaPlugin.render.
 */
import { describe, it, expect } from 'vitest';
import { createDefaultFormulaRegistry, createFormulaRegistry } from '../src/plugins/formula/index.js';
import { mathType } from '../src/plugins/math/mathType.js';

describe('formula registry', () => {
  it('the default registry has math registered + reachable by id', () => {
    const r = createDefaultFormulaRegistry();
    expect(r.get('math')).toBe(mathType);
    expect(r.get('dice')).toBeUndefined(); // dice is design-only, not registered
  });

  it('triggerChars lists the auto-trigger chars (math = "=")', () => {
    expect(createDefaultFormulaRegistry().triggerChars()).toEqual(['=']);
  });

  it('detectAuto resolves math on "=" after a numeric tail, null otherwise', () => {
    const r = createDefaultFormulaRegistry();
    expect(r.detectAuto('=', 'I paid 10 x 2')).toEqual({ type: mathType, spec: '10 x 2' });
    expect(r.detectAuto('=', 'name = value')).toBeNull(); // prose
    expect(r.detectAuto('[', '1 + 1')).toBeNull();        // wrong trigger char
  });

  it('resolveBracket matches a math expression, leaves prose unmatched', () => {
    const r = createDefaultFormulaRegistry();
    expect(r.resolveBracket('1 + 1')).toEqual({ type: mathType, spec: '1 + 1' });
    expect(r.resolveBracket('note to self')).toBeNull();
    expect(r.resolveBracket('5')).toBeNull(); // a bare number is not a computation
  });

  it('register is idempotent (re-registering the same id is a no-op)', () => {
    const r = createFormulaRegistry();
    r.register(mathType);
    r.register(mathType);
    expect(r.triggerChars()).toEqual(['=']); // not duplicated
  });
});

describe('math formula type', () => {
  it('autoTrigger detects a trailing computation', () => {
    expect(mathType.autoTrigger?.char).toBe('=');
    expect(mathType.autoTrigger?.detect('3 + 4')).toBe('3 + 4');
    expect(mathType.autoTrigger?.detect('hello')).toBeNull();
  });

  it('recognize accepts a computation, rejects a bare number / prose', () => {
    expect(mathType.recognize('1 + 1')).toBe('1 + 1');
    expect(mathType.recognize('  2 * 3  ')).toBe('2 * 3'); // trimmed
    expect(mathType.recognize('5')).toBeNull();
    expect(mathType.recognize('note')).toBeNull();
  });

  it('evaluate returns a display value, or ok:false on div0/malformed', () => {
    expect(mathType.evaluate('10 / 2', null)).toEqual({ ok: true, display: '5' });
    expect(mathType.evaluate('1 / 0', null).ok).toBe(false);
    expect(mathType.evaluate('1 +', null).ok).toBe(false);
  });
});
