/**
 * Inline-formula framework — public API (docs/specs/inline-formulas.md). The editor host imports ONLY from
 * here: the default registry, the plugins, the NodeView factory, and the deckAdapter dual-wire commands.
 * Editor core stays plugin-agnostic; the registry is injected.
 */
import { createFormulaRegistry, type FormulaRegistry } from './formulaTypes.js';
import { mathType } from '../math/mathType.js';

/**
 * The default formula registry — Phase 1 ships MATH as the only registered type. Loadout-AWARE by
 * construction: a future plugin loadout (e.g. a TTRPG loadout adding dice) builds its own registry with a
 * different type set; nothing here hardcodes a single global set.
 */
export function createDefaultFormulaRegistry(): FormulaRegistry {
  const registry = createFormulaRegistry();
  registry.register(mathType);
  return registry;
}

export { buildFormulaPlugins, formulaTriggerOnInsert, unwrapFormulaBackspace } from './formulaPlugin.js';
export { buildFormulaNodeView } from './formulaNodeView.js';
export { createFormulaRegistry } from './formulaTypes.js';
export type { FormulaRegistry, FormulaType, FormulaOutput, FormulaRenderContext, FormulaMatch } from './formulaTypes.js';
