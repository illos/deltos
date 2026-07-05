import type { FormulaType, FormulaOutput } from '../formula/formulaTypes.js';
import { parseImperial, formatInches } from './imperialParse.js';

/**
 * The IMPERIAL-UNITS formula type (docs/specs/inline-formulas.md) — a carpenter's measurement adder. Output
 * kind = STATIC DERIVED value (like math): the editable spec is a whitespace/comma list of imperial
 * measurements, the output is their SUM as feet + inches rounded UP to 1/32", e.g.
 *   `[Trim: 12, 123” 4 4’5” 12-15/16” 12’6”]`  →  ` = 44′ 2-15/16″`.
 *
 * Reachable ONLY via the explicit `[...]` bracket path (no autoTrigger). The parse/format core is the pure
 * imperialParse module; this wrapper is recognize/evaluate/renderOutput glue.
 *
 * DISJOINT from math by construction (both live on the bracket path): imperial CLAIMS content only when
 * every token parses AND it is unambiguously imperial — there is a `label:` prefix OR at least one token
 * carries a feet/inch mark. So a bare `[12]` or an arithmetic `[12 + 3]` fall through to math; `[12']` and
 * `[Trim: …]` route here. Math, in turn, only claims content that is ENTIRELY a valid expression, which an
 * imperial spec (unit marks, labels, commas) never is.
 */
export const imperialType: FormulaType = {
  id: 'imperial',

  // EXPLICIT [...] ONLY (no autoTrigger). Claim iff it parses AND is unambiguously imperial (label OR a
  // unit mark). The stored spec is the trimmed content (label included — it stays as an editable tag).
  recognize: (content) => {
    const parsed = parseImperial(content);
    if (!parsed) return null;
    if (!parsed.hasLabel && !parsed.hasMark) return null; // bare numbers → let math's domain have it
    return content.trim();
  },

  evaluate: (spec): FormulaOutput => {
    const parsed = parseImperial(spec);
    return parsed ? { ok: true, display: formatInches(parsed.totalInches) } : { ok: false };
  },

  // Output DOM: mirrors mathType — ' = <total>' with the total emphasized; malformed → a subtle ' = ?'.
  // Reuses the shared .formula-output pill styling (no new CSS). Static type → render context unused.
  renderOutput: (_spec, output) => {
    const span = document.createElement('span');
    span.contentEditable = 'false';
    if (output.ok) {
      span.className = 'formula-output formula-output--imperial';
      span.append(' = ');
      const value = document.createElement('span');
      value.className = 'formula-output__value';
      value.textContent = output.display ?? '';
      span.appendChild(value);
    } else {
      span.className = 'formula-output formula-output--imperial formula-output--error';
      span.textContent = ' = ?';
    }
    return span;
  },
};
