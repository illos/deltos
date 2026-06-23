import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { EditorView } from 'prosemirror-view';
import type { Node as PmNode } from 'prosemirror-model';
import type { SpellEngine } from '../deck/index.js';

/**
 * Spellcheck editor adapter (#69 §5, deltos-side) — wires the Deck-core SpellEngine to ProseMirror. ALL
 * the PM-specific glue lives here (the engine itself is editor-agnostic): a decoration plugin underlines
 * misspelled words with a squiggle, and a tap on one surfaces a suggestion popover (the host renders it).
 *
 * Async-safe: the engine runs in a worker, so checks are debounced and applied via a meta-transaction only
 * if the doc is unchanged since the check started (otherwise a newer debounced check is already queued).
 * Between checks, existing squiggles ride the transaction mapping so they track edits. Title + code_block
 * are excluded (no spellcheck in the note title or mono blocks).
 */

export const spellcheckKey = new PluginKey<DecorationSet>('spellcheck');
const SET_META = 'spellcheck$set';
const DEBOUNCE_MS = 500;

/** A squiggle-tapped misspelling handed to the host to position + populate the suggestion popover. */
export interface SpellTap {
  from: number;
  to: number;
  word: string;
  view: EditorView;
}

// Eligible textblocks for checking: every textblock EXCEPT the title node and code blocks. Returns each
// block's text + the doc position of its first character (so engine char-offsets map to doc positions).
// Exported for tests (the title/code_block exclusion is an acceptance criterion).
export function eligibleBlocks(doc: PmNode): { text: string; from: number }[] {
  const out: { text: string; from: number }[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'title' || node.type.name === 'code_block') return false; // skip + don't descend
    if (node.isTextblock && node.textContent.length > 0) out.push({ text: node.textContent, from: pos + 1 });
    return true;
  });
  return out;
}

async function computeSpans(engine: SpellEngine, doc: PmNode): Promise<{ from: number; to: number }[]> {
  const blocks = eligibleBlocks(doc);
  const perBlock = await Promise.all(blocks.map((b) => engine.check(b.text)));
  const spans: { from: number; to: number }[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const base = blocks[i]!.from;
    for (const r of perBlock[i]!) spans.push({ from: base + r.start, to: base + r.end });
  }
  return spans;
}

export function createSpellcheckPlugin(
  engine: SpellEngine,
  onTap: (t: SpellTap) => void,
  onDismiss: () => void,
  /** The plugin assigns a force-recheck fn here on mount (cleared on destroy) so the host can re-run the
   *  check after a non-doc change — e.g. the custom-dictionary allow-list updating (§5.2). */
  recheckRef: { current: (() => void) | null },
): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: spellcheckKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, decos) {
        const spans = tr.getMeta(SET_META) as { from: number; to: number }[] | undefined;
        if (spans) {
          return DecorationSet.create(
            tr.doc,
            spans.map((s) => Decoration.inline(s.from, s.to, { class: 'spell-error' })),
          );
        }
        return decos.map(tr.mapping, tr.doc); // track edits until the next check refreshes
      },
    },
    props: {
      decorations(state) {
        return spellcheckKey.getState(state);
      },
      handleClickOn(view, _pos, _node, _nodePos, event) {
        // A tap inside a squiggled word → open the suggestion popover (don't block normal cursor placement).
        const clickPos = view.posAtCoords({ left: (event as MouseEvent).clientX, top: (event as MouseEvent).clientY });
        if (!clickPos) return false;
        const here = spellcheckKey.getState(view.state)?.find(clickPos.pos, clickPos.pos) ?? [];
        if (here.length === 0) { onDismiss(); return false; } // tap-elsewhere → dismiss the suggestion bar
        const d = here[0]!;
        onTap({ from: d.from, to: d.to, word: view.state.doc.textBetween(d.from, d.to), view });
        return false;
      },
    },
    view(view) {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const run = () => {
        const checkedDoc = view.state.doc;
        void computeSpans(engine, checkedDoc).then((spans) => {
          if (view.isDestroyed) return;
          if (view.state.doc !== checkedDoc) return; // doc moved during the worker round-trip → newer check queued
          view.dispatch(view.state.tr.setMeta(SET_META, spans));
        });
      };
      const schedule = () => { if (timer) clearTimeout(timer); timer = setTimeout(run, DEBOUNCE_MS); };
      schedule(); // initial pass on mount
      recheckRef.current = schedule; // host can force a re-check (e.g. allow-list changed) without a doc edit
      return {
        update(v, prev) { if (v.state.doc !== prev.doc) schedule(); },
        destroy() { if (timer) clearTimeout(timer); recheckRef.current = null; },
      };
    },
  });
}

/** Replace a misspelled range with a suggestion in one transaction, then refocus. */
export function applySpellCorrection(view: EditorView, from: number, to: number, replacement: string): void {
  view.dispatch(view.state.tr.insertText(replacement, from, to).scrollIntoView());
  view.focus();
}
