/**
 * Deploy 3 — slice F: the new keyboard shortcuts (spec §5). Asserts the bindings exist and that the
 * mark shortcuts apply their mark through the shared command layer (so a shortcut ≡ the toolbar button).
 */
import { describe, it, expect } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { deltoSchema } from '../src/editor/schema.js';
import { buildKeymap } from '../src/editor/keymap.js';

const S = deltoSchema;
const keys = buildKeymap(S);

function selectedState(): EditorState {
  const doc = S.node('doc', null, [
    S.node('title', { id: 't' }, [S.text('T')]),
    S.node('paragraph', { id: 'p' }, [S.text('hello')]),
  ]);
  let state = EditorState.create({ doc, schema: S });
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 4, 9))); // over 'hello'
  return state;
}

describe('keymap — new Deploy-3 bindings exist', () => {
  it('binds Mod-u, Mod-Shift-x, Mod-Shift-h, Mod-k', () => {
    for (const k of ['Mod-u', 'Mod-Shift-x', 'Mod-Shift-h', 'Mod-k']) {
      expect(typeof keys[k], k).toBe('function');
    }
  });
});

describe('keymap — mark shortcuts apply the mark', () => {
  const cases: Array<[string, string]> = [
    ['Mod-u', 'underline'],
    ['Mod-Shift-x', 'strikethrough'],
    ['Mod-Shift-h', 'highlight'],
  ];
  for (const [key, markName] of cases) {
    it(`${key} toggles ${markName} over the selection`, () => {
      const state = selectedState();
      let next = state;
      keys[key]!(state, (tr) => { next = state.apply(tr); });
      expect(next.doc.rangeHasMark(4, 9, S.marks[markName]!)).toBe(true);
    });
  }
});
