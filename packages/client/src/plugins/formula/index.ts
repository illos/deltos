/**
 * Inline-formula framework — public API (docs/specs/inline-formulas.md). The editor host imports ONLY from
 * here: the default registry, the pipeline registration, the edit-surface plugin/commands, and the NodeView
 * factory. Editor core stays plugin-agnostic; the registry is injected.
 */
import { createFormulaRegistry, type FormulaRegistry } from './formulaTypes.js';
import { mathType } from '../math/mathType.js';
import { hexColorType } from '../hexcolor/hexColorType.js';
import { imperialType } from '../imperial/imperialType.js';
import { referenceType } from './referenceType.js';

/**
 * The default formula registry — MATH (text/number output) + HEXCOLOR (visual swatch output) + IMPERIAL
 * (feet/inch adder, text output) + REFERENCE (the bare `[Y]` / `[J:total]` chip — never self-claims,
 * doc-gated in the bracket handlers). All tiny (no dict/heavy deps), so static registration adds
 * negligible bundle; everything ENGINE-shaped stays behind the formulaHost lazy boundary. Loadout-AWARE
 * by construction: a future plugin loadout (e.g. a TTRPG loadout adding dice) builds its own registry.
 *
 * Registration order = bracket-path precedence. IMPERIAL registers BEFORE math (Step 2): both grammars
 * now understand the substrate-common `Label:` tag, and the residual labeled ambiguity (`[Trim: 12-15/16]`
 * — imperial mixed-number feet vs math subtraction) must keep resolving to imperial exactly as it did
 * pre-Step-2. This changes nothing math previously claimed: imperial's recognize gate (label OR unit mark)
 * declines every spec math wins (`[12-15/16]`, `[1 + 1]` — unlabeled, unmarked).
 */
export function createDefaultFormulaRegistry(): FormulaRegistry {
  const registry = createFormulaRegistry();
  registry.register(imperialType);
  registry.register(mathType);
  registry.register(hexColorType);
  registry.register(referenceType);
  return registry;
}

export { registerFormulaTransforms, unwrapFormulaBackspace } from './formulaPlugin.js';
export { buildFormulaNodeView } from './formulaNodeView.js';
export { createFormulaRegistry } from './formulaTypes.js';
export type { FormulaRegistry, FormulaType, FormulaOutput, FormulaRenderContext, FormulaMatch } from './formulaTypes.js';
export { createFormulaBroker, ENGINE_FTYPES, LABELED_FTYPES } from './formulaHost.js';
export type { FormulaBroker, FormulaHandle, FormulaEnvironmentRuntime } from './formulaHost.js';
export { referenceType, REFERENCE_FTYPE } from './referenceType.js';
export { extractLabel, bindRefs, refTokenName, REF_OPEN, REF_CLOSE } from './refBinding.js';
