import { useEffect, useRef, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Schema } from 'prosemirror-model';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { Deck, Keypad } from '../deck/index.js';
import type { DeckContext, DeckLoadoutRegistry } from '../deck/index.js';
import { deriveDeckContext, buildPmKeyActions } from '../editor/deckAdapter.js';

/**
 * /kbprobe — the isolated test route (auth-bypassed in App). Originally the #68 inputmode=none probe;
 * now hosts the #69 custom-keyboard Phase-1 KEY-GRID so navSys can overlay-diff its geometry against
 * the reference screenshot and Jim can type-test the real grid before it's wired into the live editor.
 * A minimal inline-schema ProseMirror editor with inputmode=none (set at view-creation, before focus);
 * white-space:pre-wrap so multiple/trailing spaces render correctly (the real editor now matches — #329
 * fixed the missing pre-wrap on .editor__pm .ProseMirror; PM requires it).
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
  const viewRef = useRef<EditorView | null>(null);
  const [ready, setReady] = useState(false);
  // The Deck reacts to the editor selection (Phase-1 context is always 'text' here since the minimal
  // schema has no selectable nodes, but the surface is wired selection-aware from day one).
  const [context, setContext] = useState<DeckContext>('text');
  // Back to the app — a PWA has no address bar, so the probe needs its own exit (client-route push).
  const navigate = useNavigate();

  // The keypad's KeyActions wired to the probe's PM view via the SAME deltos adapter the real editor uses.
  const deckActions = useRef(buildPmKeyActions(() => viewRef.current)).current;
  const deckLoadouts = useMemo<DeckLoadoutRegistry>(() => ({ text: <Keypad actions={deckActions} /> }), [deckActions]);

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
        setContext(deriveDeckContext(next));
      },
    });
    viewRef.current = v;
    setReady(true);
    v.focus();
    return () => { v.destroy(); viewRef.current = null; setReady(false); };
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
      {ready && <Deck context={context} loadouts={deckLoadouts} />}
    </div>
  );
}
