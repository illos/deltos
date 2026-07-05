import type { FormulaType } from '../formula/formulaTypes.js';
import { evaluateNumeric, numericRenderOutput, type NumericFormula } from '../formula/numericFormula.js';
import { bindRefs, extractLabel } from '../formula/refBinding.js';
import { evaluate as evalMath, detectTrailingExpression } from './mathEngine.js';

/**
 * The MATH formula type (docs/specs/inline-formulas.md §3) — the first consumer of the inline-formula
 * framework, now on the shared NUMERIC substrate (numericFormula.ts): its compute core is the safe
 * arithmetic engine (src/plugins/math/mathEngine.ts, no eval), its canonical unit is the bare number, and
 * its display is the plain decimal. Output kind = STATIC DERIVED value: recomputes when the spec is edited;
 * div0/malformed → a subtle '= ?'. No state (the `state` slot is for interactive types like dice).
 *
 * STEP 2 (formula-engine.md §6): math now speaks the substrate-common LABEL + REFERENCE layer —
 *   - `[Y: 2+2]` — the optional leading label is a visible tag that names the formula (never arithmetic);
 *   - `[12 x [Y] / 2]` — bracketed label-shaped tokens are REFERENCES, bound through the NumericEnv to raw
 *     scalars (the consuming type's canonical unit — here, plain numbers; locked decision #2);
 *   - a trailing `=` inside the bracket (`[12 x [Y] / 2 =]`) is tolerated as an explicit compute marker
 *     and normalized OUT of the stored spec.
 */

/** Math's numeric core: expression → scalar (canonical unit = the number itself), formatted as decimal.
 *  The spec's optional label tag is stripped (it names, never computes) and its `[Ref]` tokens resolve
 *  through `env` as raw numbers. */
export const mathNumeric: NumericFormula = {
  toNumber: (spec, env) => {
    const { body } = extractLabel(spec);
    const { skeleton, refs } = bindRefs(body);
    const r = evalMath(skeleton, (i) => {
      const name = refs[i];
      return name === undefined ? null : env.resolveRef(name);
    });
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

  // EXPLICIT [...]: '[1 + 1]' → math; '[5]' / '[note to self]' → null (stays literal). The Step-2 surface:
  // an optional label tag ('[Y: 2+2]') and reference tokens ('[12 x [Y] / 2]') are recognized too. The
  // "is a real computation" bar: ref-free content keeps the EXACT pre-Step-2 predicate (whole body =
  // detectTrailingExpression, ≥1 binary operator — '[5]' stays literal); ref-BEARING content must fully
  // parse with a probe binding (a reference is computation intent by itself, so no operator floor —
  // '[A: [B]]' is a legal labeled alias). Stored spec = trimmed content minus the trailing '=' marker,
  // label kept visible.
  recognize: (content) => {
    const spec = content.trim().replace(/\s*=$/, '');
    if (spec.length === 0) return null;
    const { body } = extractLabel(spec);
    if (body.trim().length === 0) return null;
    const { skeleton, refs } = bindRefs(body);
    const valid =
      refs.length > 0
        ? evalMath(skeleton, () => 1).ok
        : detectTrailingExpression(body) === body;
    return valid ? spec : null;
  },

  evaluate: (spec) => evaluateNumeric(mathNumeric, spec),

  // Output DOM: the shared numeric ' = <value>' widget (subtle ' = ?' on div0/malformed).
  renderOutput: numericRenderOutput('math'),
};
