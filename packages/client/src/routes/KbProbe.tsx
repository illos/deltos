import { useEffect, useRef } from 'react';
import { Schema } from 'prosemirror-model';
import { EditorState } from 'prosemirror-state';
import type { Command } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { baseKeymap, deleteSelection, joinBackward } from 'prosemirror-commands';

/**
 * Task #68 — THROWAWAY probe (not product). De-risks the custom-keyboard direction (the #1 unknown from
 * research #67): does inputmode="none" RELIABLY keep the iOS soft keyboard DOWN while a ProseMirror
 * editor is focused, and can we type via OUR keys with a usable caret — across focus / scroll /
 * blur-refocus, AND in the INSTALLED home-screen PWA (how Jim actually runs it)?
 *
 * Isolated: its own /kbprobe route (auth-bypassed in App), a minimal inline schema, no shared editor
 * code touched. inputmode="none" is set on the contenteditable at view-creation (BEFORE focus — dynamic
 * toggling is unreliable on Safari). Keys fire on pointerdown + preventDefault so the editor never blurs.
 */

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'text*', toDOM: () => ['p', 0], parseDOM: [{ tag: 'p' }] },
    text: {},
  },
  marks: {},
});

const LETTERS = ['t', 'h', 'e', 'q', 'u', 'i', 'c', 'k', 'a', 'o', 'n', 's'];

export function KbProbe() {
  const mountRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    if (!mountRef.current) return;
    const state = EditorState.create({ doc: schema.node('doc', null, [schema.node('paragraph')]), schema });
    const view = new EditorView(mountRef.current, {
      state,
      // inputmode=none from creation (before focus). autocorrect/capitalize off so the probe is clean.
      attributes: { inputmode: 'none', autocorrect: 'off', autocapitalize: 'off', 'aria-label': 'probe editor' },
    });
    viewRef.current = view;
    view.focus();
    return () => { view.destroy(); viewRef.current = null; };
  }, []);

  // Run a key on the live view, keeping focus (pointerdown preventDefault already blocks the blur).
  const press = (fn: (v: EditorView) => void) => (e: React.PointerEvent) => {
    e.preventDefault();
    const v = viewRef.current;
    if (!v) return;
    fn(v);
    v.focus();
  };
  const insert = (t: string) => (v: EditorView) => v.dispatch(v.state.tr.insertText(t));
  const runBase = (key: string) => (v: EditorView) => { (baseKeymap[key] as Command)(v.state, v.dispatch, v); };
  // PROBE FINDING: single-char Backspace is normally the NATIVE keyboard's job (baseKeymap.Backspace only
  // joins at block boundaries), and we suppressed the keyboard — so the custom keyboard must own char
  // delete itself. Mid-textblock → delete the char before the caret; at block start → join backward.
  const doBackspace = (v: EditorView) => {
    const { selection } = v.state;
    if (!selection.empty) { deleteSelection(v.state, v.dispatch); return; }
    if (selection.$from.parentOffset > 0) { v.dispatch(v.state.tr.delete(selection.from - 1, selection.from)); return; }
    joinBackward(v.state, v.dispatch, v);
  };

  return (
    <div className="kbprobe">
      <h1 className="kbprobe__title">inputmode=none keyboard probe</h1>
      <p className="kbprobe__hint">
        The native keyboard should STAY DOWN while this editor is focused (caret blinking). Type with the
        keys below. Test: initial focus, scroll, tap away + back, and the installed home-screen PWA.
      </p>
      <div ref={mountRef} className="kbprobe__editor" />
      <div className="kbprobe__pad" role="group" aria-label="Probe keypad">
        {LETTERS.map((c) => (
          <button key={c} type="button" className="kbprobe__key" onPointerDown={press(insert(c))}>{c}</button>
        ))}
        <button type="button" className="kbprobe__key kbprobe__key--wide" onPointerDown={press(insert(' '))}>space</button>
        <button type="button" className="kbprobe__key" onPointerDown={press(doBackspace)} aria-label="Backspace">⌫</button>
        <button type="button" className="kbprobe__key" onPointerDown={press(runBase('Enter'))} aria-label="Enter">⏎</button>
      </div>
    </div>
  );
}
