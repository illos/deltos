import type { DeltoSchema } from './schema.js';
import { TransformRegistry, undoLastTransform } from './inputPipeline/index.js';
import { registerFormulaTransforms } from '../plugins/formula/index.js';
import type { FormulaRegistry } from '../plugins/formula/index.js';
import { registerMarkdownTransforms } from './inputRules.js';
import { registerAutolinkTransforms } from './autolink.js';
import { markdownPasteBulk } from './markdownPaste.js';
import { deleteInlineAtomBackspace, deleteInlineAtomDelete } from './plugins/blockAtomChrome.js';

/**
 * THE canonical input-transform registry assembly ([ROAD-0007]) — the ONE place that decides which
 * transforms the editor runs and in what order. Used by the live editor (ProseMirrorEditor), the gating
 * invariant corpus, and the surface-parity tests, so they can never drift apart.
 *
 * Registration order IS execution order (design §5.4) and a registration-order test pins it:
 *   insert        : formula-auto → formula-bracket → formula-absorb → md blocks → md marks → autolink space rules
 *   backspace     : undo-autoformat (D3) → formula-unwrap → link-unwrap → atom-delete
 *   forwardDelete : formula-unwrap-delete → atom-delete
 *   enterBoundary : formula-boundary-wrap → linkify
 *   bulk          : md-paste (the step-4 paste leg)
 */

/**
 * D3 feel flag — Backspace immediately after an auto-format restores the literal trigger text (`- ` →
 * list → Backspace → literal `- `). Locked YES by Jim but explicitly feel-flagged: flip to false to
 * remove the behavior wholesale (the registration below is the only wiring).
 */
export const BACKSPACE_REVERTS_AUTOFORMAT = true;

export function buildEditorTransformRegistry(schema: DeltoSchema, formulaRegistry: FormulaRegistry): TransformRegistry {
  const r = new TransformRegistry();
  if (BACKSPACE_REVERTS_AUTOFORMAT) r.addEdit('backspace', { id: 'undo-autoformat', cmd: undoLastTransform });
  registerFormulaTransforms(r, formulaRegistry);
  registerMarkdownTransforms(r, schema);
  registerAutolinkTransforms(r, schema);
  // The paste bulk leg ([ROAD-0007] step 4): markdown conversion over a pasted range.
  r.addBulk(markdownPasteBulk(schema));
  // Block-object chrome (Mechanic A): inline-atom single-press delete closes both edit chains.
  r.addEdit('backspace', { id: 'atom-delete', cmd: deleteInlineAtomBackspace });
  r.addEdit('forwardDelete', { id: 'atom-delete', cmd: deleteInlineAtomDelete });
  return r;
}
