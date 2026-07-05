import type { FormulaType } from '../formula/formulaTypes.js';
import { evaluateNumeric, numericRenderOutput, type NumericFormula } from '../formula/numericFormula.js';
import { parseImperial, formatInches } from './imperialParse.js';

/**
 * The IMPERIAL-UNITS formula type (docs/specs/inline-formulas.md) — a carpenter's measurement adder, on the
 * shared NUMERIC substrate (numericFormula.ts): same machine as math, different grammar + formatting. Its
 * canonical unit is INCHES (feet are ×12/÷12 at the I/O edges only — there is no base-12 arithmetic); its
 * literal grammar (unit marks, the `12-15/16` mixed-number dash) is deliberately its OWN parser, never
 * shared with math (the dash collides with subtraction). Output kind = STATIC DERIVED value: the editable
 * spec is a whitespace/comma list of imperial measurements, the output is their SUM as feet + inches
 * rounded UP to 1/32", e.g.
 *   `[Trim: 12, 123” 4 4’5” 12-15/16” 12’6”]`  →  ` = 44′ 2-15/16″`.
 *
 * Reachable ONLY via the explicit `[...]` bracket path (no autoTrigger). The parse/format core is the pure
 * imperialParse module; this wrapper is recognize glue + the substrate hookup.
 *
 * DISJOINT from math (both live on the bracket path): imperial CLAIMS content only when every token
 * parses AND it is unambiguously imperial — there is a `label:` prefix OR at least one token carries a
 * feet/inch mark. So a bare `[12]` or an arithmetic `[12 + 3]` fall through to math; `[12']` and
 * `[Trim: …]` route here. Since Step 2 math ALSO understands labels (`[Y: 2+2]`), the residual ambiguity —
 * a labeled body BOTH grammars parse, e.g. `[Trim: 12-15/16]` (imperial mixed-number feet vs math
 * subtraction+division) — is settled by REGISTRY ORDER: imperial registers BEFORE math, preserving
 * imperial's pre-Step-2 claim over labeled measurement specs exactly.
 */

/** Imperial's numeric core: measurement list → total INCHES (canonical unit), formatted feet+inches.
 *  A bound `[Ref]` resolves through `env` as raw INCHES (the engine's NumericEnv seam), NOT as the
 *  bare-number-means-feet literal (formula-engine.md locked decision #2). */
export const imperialNumeric: NumericFormula = {
  toNumber: (spec, env) => parseImperial(spec, (name) => env.resolveRef(name))?.totalInches ?? null,
  format: formatInches,
};

export const imperialType: FormulaType = {
  id: 'imperial',

  // EXPLICIT [...] ONLY (no autoTrigger). Claim iff it parses AND is unambiguously imperial (label OR a
  // unit mark). The stored spec is the trimmed content (label included — it stays as an editable tag).
  // Recognition uses a PROBE reference binding (every ref resolves to 0) — structural validity only; the
  // real values arrive from the engine environment at evaluation time.
  recognize: (content) => {
    const parsed = parseImperial(content, () => 0);
    if (!parsed) return null;
    if (!parsed.hasLabel && !parsed.hasMark) return null; // bare numbers → let math's domain have it
    return content.trim();
  },

  evaluate: (spec) => evaluateNumeric(imperialNumeric, spec),

  // Output DOM: the shared numeric ' = <total>' widget (subtle ' = ?' on malformed) — mirrors math.
  renderOutput: numericRenderOutput('imperial'),
};
