import { PluginKey } from 'prosemirror-state';
import type { Transaction } from 'prosemirror-state';

/**
 * THE GATE (design §2.2) — note-integrity critical. The transaction-level pipeline leg may convert ONLY
 * transactions explicitly tagged as genuine local user input (OPT-IN). Everything else — the #90 reconcile
 * (remote sync / MCP writes / history-restore), undo/redo, IME composition, untagged programmatic inserts
 * (voice, spell-fix, link form, palette) — must pass through untouched: a missed tag is a visible
 * "didn't convert" bug; a missed exclusion would be SILENT conversion of synced content. The invariant
 * corpus (test/inputPipeline.invariants.test.ts) pins this behavior permanently — never shrink it.
 */

export type PipelineTag =
  | { kind: 'typing'; text: string } // native handleTextInput self-dispatch (pure-variant only; unused under H)
  | { kind: 'deck'; text: string } // a Deck keypad insertion delivered as a tagged transaction
  | { kind: 'paste' } // a bulk plain-text insertion (the step-4 paste leg)
  | { kind: 'applied' }; // the pipeline's OWN appended output (loop guard — never re-enters)

/** Meta-only key carrying the opt-in tag. Distinct from the plugin's state key (which holds the undo record). */
export const inputPipelineTag = new PluginKey('inputPipelineTag');

/**
 * Returns the qualifying tag, or null if the pipeline must not touch this transaction.
 * Opt-in first; then the belt — defense in depth, none of these should ever BE tagged, refuse anyway:
 * `reconcile` (the one remote-content ingress, ProseMirrorEditor #90), `addToHistory:false`,
 * prosemirror-history meta (undo/redo must never re-trigger), `composition` (IME), and prosemirror-view's
 * `uiEvent` for cut/drop (only 'paste' is ever a transform input).
 *
 * ONE implicit shape qualifies alongside the explicit tags (step 4, design §2.2): prosemirror-view's own
 * default paste dispatch carries `uiEvent:'paste'` — set ONLY by its real paste path (doPaste, which also
 * serves `view.pasteText`). That meta counts as an implicit `{kind:'paste'}` tag, so the desktop
 * ClipboardEvent path needs no re-dispatch. The belt applies to the implicit shape in full.
 */
export function isPipelineInput(tr: Transaction): Exclude<PipelineTag, { kind: 'applied' }> | null {
  const tag = tr.getMeta(inputPipelineTag) as PipelineTag | undefined;
  if (tag?.kind === 'applied') return null;
  const ui = tr.getMeta('uiEvent') as string | undefined;
  const effective = tag ?? (ui === 'paste' ? ({ kind: 'paste' } as const) : undefined);
  if (!effective) return null;
  if (tr.getMeta('reconcile') === true) return null;
  if (tr.getMeta('addToHistory') === false) return null;
  if (tr.getMeta('history$')) return null;
  if (tr.getMeta('composition') != null) return null;
  if (ui && ui !== 'paste') return null;
  return effective;
}
