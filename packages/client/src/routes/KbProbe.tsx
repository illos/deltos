import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Schema } from 'prosemirror-model';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { KeyboardSurface, deriveKeyboardContext } from '../editor/KeyboardSurface.js';
import type { KeyboardContext } from '../editor/KeyboardSurface.js';

/**
 * /kbprobe — the isolated test route (auth-bypassed in App). Originally the #68 inputmode=none probe;
 * now hosts the #69 custom-keyboard Phase-1 KEY-GRID so navSys can overlay-diff its geometry against
 * the reference screenshot and Jim can type-test the real grid before it's wired into the live editor.
 * A minimal inline-schema ProseMirror editor with inputmode=none (set at view-creation, before focus);
 * white-space:pre-wrap so multiple/trailing spaces render correctly (the real editor has this too).
 */

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'text*', toDOM: () => ['p', 0], parseDOM: [{ tag: 'p' }] },
    text: {},
  },
  marks: {},
});

export function KbProbe() {
  const mountRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<EditorView | null>(null);
  // The keyboard footprint reacts to the editor selection (Phase-1 context is always 'text' here since
  // the minimal schema has no selectable nodes, but the surface is wired selection-aware from day one).
  const [context, setContext] = useState<KeyboardContext>('text');
  // Back to the app — a PWA has no address bar, so the probe needs its own exit (client-route push).
  const navigate = useNavigate();

  useEffect(() => {
    if (!mountRef.current) return;
    const state = EditorState.create({ doc: schema.node('doc', null, [schema.node('paragraph')]), schema });
    const v = new EditorView(mountRef.current, {
      state,
      // inputmode=none from creation (before focus). autocorrect/capitalize off so the probe is clean.
      attributes: { inputmode: 'none', autocorrect: 'off', autocapitalize: 'off', 'aria-label': 'probe editor' },
      dispatchTransaction(tr) {
        const next = v.state.apply(tr);
        v.updateState(next);
        setContext(deriveKeyboardContext(next));
      },
    });
    setView(v);
    v.focus();
    return () => { v.destroy(); setView(null); };
  }, []);

  return (
    <div className="kbprobe">
      <button type="button" className="kbprobe__back" onClick={() => navigate('/')}>‹ Back to app</button>
      <h1 className="kbprobe__title">custom keyboard — geometry probe (#69)</h1>
      <p className="kbprobe__hint">
        The native keyboard stays down (inputmode=none). Type with the custom keyboard below — checking
        the key geometry vs muscle memory, multiple/trailing spaces, and backspace tap + hold-to-repeat.
      </p>
      <div ref={mountRef} className="kbprobe__editor" />
      <KeyboardSurface view={view} context={context} />
    </div>
  );
}
