/**
 * Inline-formula framework — public API (docs/specs/inline-formulas.md). The editor host imports ONLY from
 * here: the default registry, the pipeline registration, the edit-surface plugin/commands, and the NodeView
 * factory. Editor core stays plugin-agnostic; the registry is injected.
 */
import { createFormulaRegistry, type FormulaRegistry } from './formulaTypes.js';
import { mathType } from '../math/mathType.js';
import { hexColorType } from '../hexcolor/hexColorType.js';

/**
 * The default formula registry — MATH (text/number output) + HEXCOLOR (visual swatch output). Both are
 * tiny (no dict/heavy deps), so static registration adds negligible bundle. Loadout-AWARE by construction:
 * a future plugin loadout (e.g. a TTRPG loadout adding dice) builds its own registry with a different set.
 */
export function createDefaultFormulaRegistry(): FormulaRegistry {
  const registry = createFormulaRegistry();
  registry.register(mathType);
  registry.register(hexColorType);
  return registry;
}

export { buildFormulaPlugins, registerFormulaTransforms, unwrapFormulaBackspace, maybeWrapBoundaryFormula } from './formulaPlugin.js';
export { buildFormulaNodeView } from './formulaNodeView.js';
export { createFormulaRegistry } from './formulaTypes.js';
export type { FormulaRegistry, FormulaType, FormulaOutput, FormulaRenderContext, FormulaMatch } from './formulaTypes.js';
