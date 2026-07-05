import type { FormulaType } from '../formula/formulaTypes.js';
import { evaluateNumeric, numericRenderOutput, type NumericFormula } from '../formula/numericFormula.js';
import { evaluate as evalMath, detectTrailingExpression } from './mathEngine.js';

/**
 * The MATH formula type (docs/specs/inline-formulas.md §3) — the first consumer of the inline-formula
 * framework, now on the shared NUMERIC substrate (numericFormula.ts): its compute core is the safe
 * arithmetic engine (src/plugins/math/mathEngine.ts, no eval), its canonical unit is the bare number, and
 * its display is the plain decimal. Output kind = STATIC DERIVED value: recomputes when the spec is edited;
 * div0/malformed → a subtle '= ?'. No state (the `state` slot is for interactive types like dice).
 */

/** Math's numeric core: expression → scalar (canonical unit = the number itself), formatted as decimal.
 *  References (`env`) arrive with the reactive engine; the arithmetic grammar itself has none yet. */
export const mathNumeric: NumericFormula = {
  toNumber: (spec, _env) => {
    const r = evalMath(spec);
    return r.ok ? r.value : null;
  },
  format: (value) => String(value),
};

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

  evaluate: (spec) => evaluateNumeric(mathNumeric, spec),

  // Output DOM: the shared numeric ' = <value>' widget (subtle ' = ?' on div0/malformed).
  renderOutput: numericRenderOutput('math'),
};
