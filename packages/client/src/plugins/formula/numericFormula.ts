import type { FormulaOutput, FormulaType } from './formulaTypes.js';

/**
 * NUMERIC-formula substrate (docs/specs/formula-engine.md §2) — the shared shape of every formula type in
 * the "reduce a source string to ONE scalar" family. Math and imperial are the same machine wearing two
 * grammars: the only per-type parts are (a) the input LITERAL grammar (imperial's `4'5"` / `12-15/16`
 * mixed-number sugar vs math's plain arithmetic — deliberately NOT shared, the mixed-number dash collides
 * with subtraction) and (b) the output FORMATTING (decimal vs feet+inches). Everything between — the
 * FormulaOutput plumbing, the ' = value' output DOM, and (next) the reactive reference/environment layer —
 * is family-common and lives here, written once.
 *
 * The scalar is in the type's own CANONICAL UNIT (imperial = inches; math = the bare number). Cross-type
 * references flow as raw scalars with NO dimensional analysis (locked decision): the CONSUMING type decides
 * display. hexcolor / link-card are not numeric and do not implement this.
 *
 * Pure glue at this layer (no ProseMirror); only {@link numericRenderOutput} touches the DOM — the same
 * boundary formulaTypes.ts already draws.
 */

/**
 * The reference ENVIRONMENT handed to {@link NumericFormula.toNumber} — the seam the reactive engine
 * (src/formula-engine/) plugs into. When the reference feature lands, the host resolves a formula's `[Ref]`
 * tokens through the engine, binds each to a scalar, and hands the bindings here; the type's parser treats
 * a bound reference as a RAW SCALAR in its own canonical unit (an imperial spec consuming `[Y]` reads Y as
 * inches — never as a bare-number-means-feet literal). Phase 0/1: nothing produces references yet, so every
 * call site passes {@link EMPTY_ENV} and behavior is exactly the pre-substrate behavior.
 */
export interface NumericEnv {
  /** Resolve a bound reference key to its scalar, or null if unknown (an unknown ref → parse failure). */
  resolveRef(key: string): number | null;
}

/** The no-references environment — resolves nothing. The Phase-0 default everywhere. */
export const EMPTY_ENV: NumericEnv = Object.freeze({ resolveRef: () => null });

/**
 * A numeric formula type's compute core: parse + format, nothing else. Implementations MUST be pure and
 * never throw (malformed input → null). The reactive engine computes with `toNumber` (it needs the scalar,
 * not the display string); the editor shows `format`'s string.
 */
export interface NumericFormula {
  /**
   * Parse the type's literals/expression to a single scalar in the type's canonical unit, resolving any
   * bound references through `env`. Returns null when the spec is malformed (or a reference is unknown).
   */
  toNumber(spec: string, env: NumericEnv): number | null;
  /** Format a scalar (canonical unit) for display — e.g. math `4.8`, imperial `44′ 2-15/16″`. */
  format(value: number): string;
}

/** Bridge a {@link NumericFormula} to the FormulaType.evaluate contract: null → { ok:false }. */
export function evaluateNumeric(nf: NumericFormula, spec: string, env: NumericEnv = EMPTY_ENV): FormulaOutput {
  const value = nf.toNumber(spec, env);
  return value === null ? { ok: false } : { ok: true, display: nf.format(value) };
}

/**
 * The shared numeric output DOM — ' = <value>' with the value emphasized, or a subtle ' = ?' on error —
 * previously duplicated verbatim in mathType/imperialType (modulo the type-suffixed class). Numeric types
 * are static (no interactive state), so the render context is unused.
 */
export function numericRenderOutput(typeId: string): FormulaType['renderOutput'] {
  return (_spec, output) => {
    const span = document.createElement('span');
    span.contentEditable = 'false';
    if (output.ok) {
      span.className = `formula-output formula-output--${typeId}`;
      span.append(' = ');
      const value = document.createElement('span');
      value.className = 'formula-output__value';
      value.textContent = output.display ?? '';
      span.appendChild(value);
    } else {
      span.className = `formula-output formula-output--${typeId} formula-output--error`;
      span.textContent = ' = ?';
    }
    return span;
  };
}
