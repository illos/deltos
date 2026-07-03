import { Plugin } from 'prosemirror-state';
import type { Transaction } from 'prosemirror-state';
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
 *  • BULK / tagged transactions: `appendTransaction` runs the bulk transforms over the inserted range of
 *    any paste-shaped transaction that passes the §2.2 gate (explicit `{kind:'paste'}` tag OR
 *    prosemirror-view's own `uiEvent:'paste'` — the desktop ClipboardEvent path), and the post-insert
 *    runner on tagged single-insert shapes. Untagged or belt-refused transactions (reconcile, history,
 *    composition, cut/drop, voice-shape inserts) are structurally inert.
 *  • DECK PASTE delivery: an iOS edit-menu Paste under `inputmode=none` arrives as a `beforeinput` with
 *    `inputType==='insertFromPaste'` — never a `paste` ClipboardEvent, so prosemirror-view's own paste
 *    path (the only place `handlePaste` is synthesized) never runs. The adapter below extracts the text
 *    and re-delivers it through `view.pasteText(...)`, which IS that path — handlePaste plugins (embeds
 *    card, attachments) get their normal chance, and the dispatch carries `uiEvent:'paste'`, converging
 *    with desktop exactly.
 * The Deck's key call sites (deckAdapter) invoke the same runner/edit chains directly — no plugin needed
 * there; only paste needs a DOM-event adapter because iOS owns its delivery.
 */

/**
 * The inserted range of a transaction, in its END-doc coordinates: the union envelope of every step's
 * new-range, each mapped through the steps after it. Null when nothing was inserted.
 */
function insertedRange(tr: Transaction): { from: number; to: number } | null {
  let from = Infinity;
  let to = -Infinity;
  tr.mapping.maps.forEach((stepMap, i) => {
    const rest = tr.mapping.slice(i + 1);
    stepMap.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      const s = rest.map(newStart, 1);
      const e = rest.map(newEnd, -1);
      if (s < from) from = s;
      if (e > to) to = e;
    });
  });
  return from <= to ? { from, to } : null;
}

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
        // The Deck paste delivery adapter (extraction-only — conversion is the bulk leg's job). iOS
        // edit-menu Paste under inputmode=none is a cancelable beforeinput/insertFromPaste; re-deliver
        // through view.pasteText so it becomes a REAL prosemirror-view paste (handlePaste plugins run,
        // uiEvent:'paste' set). Prefer the synchronous dataTransfer text; when iOS omits it, read the
        // clipboard async (the paste IS a user gesture, so readText is permitted in an installed PWA).
        // insertReplacementText (autocorrect/text-substitution) is deliberately NOT intercepted: it
        // targets a range, not the selection — hijacking it would misplace genuine replacements.
        beforeinput: (view: EditorView, event: Event) => {
          const ie = event as InputEvent;
          if (ie.inputType !== 'insertFromPaste') return false;
          event.preventDefault();
          const syncText = ie.dataTransfer ? ie.dataTransfer.getData('text/plain') : '';
          // Hand the triggering event through (handlePaste handlers optional-chain `clipboardData` off it,
          // which an InputEvent simply lacks — same decline as an empty ClipboardEvent, no constructor needed).
          const asPaste = event as unknown as ClipboardEvent;
          if (syncText) {
            view.pasteText(syncText, asPaste);
            return true;
          }
          void (async () => {
            let clip = '';
            try {
              clip = await navigator.clipboard.readText();
            } catch {
              clip = '';
            }
            if (clip) view.pasteText(clip, asPaste);
          })();
          return true;
        },
      },
    },
    appendTransaction(trs, _oldState, newState) {
      for (let i = 0; i < trs.length; i++) {
        const tr = trs[i]!;
        if (!tr.docChanged) continue;
        const tag = isPipelineInput(tr);
        if (!tag) continue;
        if (tag.kind === 'paste') {
          // The BULK leg (design §4): find what this transaction inserted, map it forward through any
          // later transactions in the batch, and offer the range to the bulk transforms (first-non-null
          // wins). The handlers own every skip decision (rich content, code block, title, structure gate).
          const range = insertedRange(tr);
          if (!range) continue;
          let { from, to } = range;
          for (let j = i + 1; j < trs.length; j++) {
            from = trs[j]!.mapping.map(from, 1);
            to = trs[j]!.mapping.map(to, -1);
          }
          if (from >= to) continue;
          for (const b of registry.bulk) {
            const out = b.handler(newState, from, to);
            if (out) return out.setMeta(inputPipelineTag, { kind: 'applied' });
          }
          continue;
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
