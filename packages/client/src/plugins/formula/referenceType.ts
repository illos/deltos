import type { FormulaType } from './formulaTypes.js';
import { numericRenderOutput } from './numericFormula.js';

/**
 * The REFERENCE formula type (formula-engine.md §6/§7, Step 2) — the chip a BARE `[Y]` / `[J:total]`
 * wraps into. Its spec is just the reference token text ('Y', 'J:total'); its VALUE is decision #1's one
 * rule (the SUM of the label's group — a unique label is itself; `:total` is the explicit synonym,
 * normalized away in refBinding before the resolver ever sees it).
 *
 * This type is fully ENGINE-DRIVEN: standalone `evaluate` has no environment, so it renders the quiet
 * ' = ?' until the lazy host environment (formulaEnvironment.ts) pushes the computed output into the
 * NodeView. The DISPLAY TYPE of a bare reference is the Step-2 host-side ruling (decision #5): a
 * type-HOMOGENEOUS referenced group formats with THAT group's type (an imperial Y echoes feet+inches, a
 * math Y its number); a MIXED-type group is the quiet ' = ?'. The engine itself stays unit-blind.
 *
 * NOT self-recognizing: `recognize` always declines, because whether a bracketed word is a reference
 * depends on the DOCUMENT (does any formula publish that label?), which the registry cannot see. The
 * bracket/absorb input handlers (formulaPlugin.ts) apply the grammar + the doc-label gate and create the
 * node explicitly — so prose like `[note to self]` or a markdown `[x]` NEVER turns into a dead ' = ?'
 * chip just for being letter-shaped.
 */
export const REFERENCE_FTYPE = 'ref';

export const referenceType: FormulaType = {
  id: REFERENCE_FTYPE,

  // The registry's content-claiming path never claims a reference (see above — doc-gated in the handlers).
  recognize: () => null,

  // No environment here → quietly unresolved; the host environment renders the live value.
  evaluate: () => ({ ok: false }),

  // The shared numeric ' = <value>' widget; the host supplies the group-typed display string.
  renderOutput: numericRenderOutput(REFERENCE_FTYPE),
};
