import type { FormulaType, FormulaOutput } from '../formula/formulaTypes.js';
import { evaluate as evalMath, detectTrailingExpression } from './mathEngine.js';

/**
 * The MATH formula type (docs/specs/inline-formulas.md §3) — the first consumer of the inline-formula
 * framework. Wraps the existing safe arithmetic engine (src/plugins/math/mathEngine.ts, no eval). Output
 * kind = STATIC DERIVED value: recomputes when the spec is edited; div0/malformed → a subtle '= ?'. No
 * state (the `state` slot is for interactive types like dice).
 */
export const mathType: FormulaType = {
  id: 'math',

  // AUTO-DETECT: '=' after a trailing arithmetic run (the existing predicate — fires 'I paid 10 x 2' → '10 x 2',
  // silent on prose). Both this and the [...] path require ≥1 binary operator + parseable (see the engine).
  autoTrigger: {
    char: '=',
    detect: (textBeforeCaret) => detectTrailingExpression(textBeforeCaret),
  },

  // EXPLICIT [...]: '[1 + 1]' → math; '[5]' / '[note to self]' → null (stays literal). Reuses the SAME
  // "is a real computation" bar as auto-detect (detectTrailingExpression of the whole trimmed content).
  recognize: (content) => {
    const trimmed = content.trim();
    return detectTrailingExpression(trimmed) === trimmed && trimmed.length > 0 ? trimmed : null;
  },

  evaluate: (spec): FormulaOutput => {
    const r = evalMath(spec);
    return r.ok ? { ok: true, display: String(r.value) } : { ok: false };
  },

  // Output DOM: ' = <value>' with the value emphasized; div0/malformed → a subtle ' = ?' error. Math is
  // static, so the render context (state/setState) is unused.
  renderOutput: (_spec, output) => {
    const span = document.createElement('span');
    span.contentEditable = 'false';
    if (output.ok) {
      span.className = 'formula-output formula-output--math';
      span.append(' = ');
      const value = document.createElement('span');
      value.className = 'formula-output__value';
      value.textContent = output.display ?? '';
      span.appendChild(value);
    } else {
      span.className = 'formula-output formula-output--math formula-output--error';
      span.textContent = ' = ?';
    }
    return span;
  },
};
