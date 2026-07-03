import { Plugin } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { inputPipelineTag, isPipelineInput } from './gate.js';
import { inputPipelineKey } from './key.js';
import type { AppliedTransformRecord } from './key.js';
import { runPreInsert, runPostInsert } from './runner.js';
import type { TransformRegistry } from './registry.js';

/**
 * The unified input-pipeline plugin (design §3) — the generic surface wiring, written once:
 *  • NATIVE typing: `handleTextInput` runs the pre-insert runner directly (Variant H — bit-identical to
 *    the prosemirror-inputrules plugin it replaces, including the compositionend re-run).
 *  • BULK / tagged transactions: `appendTransaction` runs the post-insert runner on transactions that
 *    pass the §2.2 gate — the leg the step-4 paste migration lands on. Untagged or belt-refused
 *    transactions (reconcile, history, composition, cut/drop, voice-shape inserts) are structurally inert.
 * The Deck's call sites (deckAdapter) invoke the same runner/edit chains directly — no plugin needed there.
 */

export function buildInputPipelinePlugin(registry: TransformRegistry): Plugin {
  const plugin = new Plugin<AppliedTransformRecord | null>({
    key: inputPipelineKey,
    state: {
      init: (): AppliedTransformRecord | null => null,
      // prosemirror-inputrules' recipe: hold the record set by the runner's meta; any other selection/doc
      // change clears it (the revert window is exactly "immediately after the transform"). One deltos
      // addition: an APPENDED transaction (meta 'appendedTransaction' — e.g. uniqueBlockIdPlugin minting
      // ids for a rule-created list wrapper in the same dispatch cycle) must NOT close the window — its
      // root either set the record (our conversion) or already cleared it, so `prev` is the right answer.
      apply(tr, prev) {
        const stored = tr.getMeta(inputPipelineKey) as AppliedTransformRecord | undefined;
        if (stored) return stored;
        if (tr.getMeta('appendedTransaction')) return prev;
        return tr.selectionSet || tr.docChanged ? null : prev;
      },
    },
    props: {
      handleTextInput(view, from, to, text) {
        return runPreInsert(view, from, to, text, registry.insert);
      },
      handleDOMEvents: {
        // Reference parity: after an IME composition settles, give the rules one pass at the caret.
        compositionend: (view: EditorView) => {
          setTimeout(() => {
            const sel = view.state.selection as { $cursor?: { pos: number } | null };
            const $cursor = sel.$cursor;
            if ($cursor) runPreInsert(view, $cursor.pos, $cursor.pos, '', registry.insert);
          });
        },
      },
    },
    appendTransaction(trs, _oldState, newState) {
      for (const tr of trs) {
        if (!tr.docChanged) continue;
        const tag = isPipelineInput(tr);
        if (!tag) continue;
        if (tag.kind === 'paste') {
          // The bulk conversion (markdownTextToSlice over the inserted range) lands at migration step 4;
          // the gate + invariant corpus already protect this leg.
          return null;
        }
        const out = runPostInsert(newState, tag.text, registry.insert);
        // Tag our own output 'applied' so isPipelineInput refuses it — loop guard §5.2 (belt: handler
        // output no longer matches its own trigger anyway).
        if (out) return out.setMeta(inputPipelineTag, { kind: 'applied' });
      }
      return null;
    },
  });
  return plugin;
}
