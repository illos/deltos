/**
 * Typed-URL autolink tests — bare-domain broadening (Jim). detectTrailingUrl (scheme'd + allowlisted bare
 * domains, with the false-positive guard) + the two boundaries, both riding the unified input pipeline
 * ([ROAD-0007] step 3): SPACE (insert transforms — native handleTextInput AND the Deck's single space) and
 * ENTER (the shared enter chain both keyboards consume). Negatives (etc./file.txt/3.14/U.S./emails) must
 * NOT link.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Plugin } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap } from 'prosemirror-commands';
import { deltoSchema } from '../src/editor/schema.js';
import { detectTrailingUrl, linkifyTrailingUrl, registerAutolinkTransforms, unwrapLinkBackspace } from '../src/editor/autolink.js';
import { buildPmKeyActions } from '../src/editor/deckAdapter.js';
import { buildKeymapPlugin } from '../src/editor/keymap.js';
import { TransformRegistry, buildInputPipelinePlugin } from '../src/editor/inputPipeline/index.js';

/** Autolink-only production registrations (space rules + link-unwrap + enter-boundary linkify). */
function autolinkTransforms(): TransformRegistry {
  const r = new TransformRegistry();
  registerAutolinkTransforms(r, deltoSchema);
  return r;
}

let view: EditorView | null = null;
afterEach(() => { view?.destroy(); view = null; document.body.innerHTML = ''; });

function mount(text: string, plugins: Plugin[]): EditorView {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const para = deltoSchema.nodes['paragraph']!.create({ id: null }, text ? deltoSchema.text(text) : []);
  const doc = deltoSchema.nodes['doc']!.create(null, [deltoSchema.nodes['title']!.create({ id: null }), para]);
  let state = EditorState.create({ doc, plugins });
  state = state.apply(state.tr.setSelection(TextSelection.atEnd(state.doc)));
  view = new EditorView(container, { state });
  return view;
}
const type = (v: EditorView, ch: string) => { const { from } = v.state.selection; v.someProp('handleTextInput', (f) => f(v, from, from, ch)); };
function linkHref(v: EditorView): string | null {
  let href: string | null = null;
  v.state.doc.descendants((node) => {
    const m = node.marks.find((mk) => mk.type.name === 'link');
    if (m) href = m.attrs.href as string;
  });
  return href;
}

describe('detectTrailingUrl', () => {
  it('matches bare domains (allowlisted TLD), optionally www / path', () => {
    expect(detectTrailingUrl('visit google.com')).toBe('google.com');
    expect(detectTrailingUrl('www.google.com')).toBe('www.google.com');
    expect(detectTrailingUrl('see deltos.dev/docs')).toBe('deltos.dev/docs');
  });
  it('matches scheme\'d URLs', () => {
    expect(detectTrailingUrl('go https://x.io/a?b=1')).toBe('https://x.io/a?b=1');
  });
  it('does NOT match the false-positive cases', () => {
    for (const s of ['etc.', 'see file.txt', '3.14', 'U.S.', 'a.m.', 'word.word', 'foo.zzz']) {
      expect(detectTrailingUrl(s), s).toBeNull();
    }
  });
  it('does NOT match an email\'s domain (boundary guard)', () => {
    expect(detectTrailingUrl('mail me@google.com')).toBeNull();
  });
});

describe('autolink — SPACE boundary (pipeline insert rules, native path)', () => {
  const rules = () => [buildInputPipelinePlugin(autolinkTransforms())];
  it('bare google.com + space → link (href https://google.com) AND the space is preserved', () => {
    const v = mount('google.com', rules());
    type(v, ' ');
    expect(linkHref(v)).toBe('https://google.com/');
    expect(v.state.doc.child(1).textContent).toBe('google.com '); // space inserted, not swallowed
  });
  it('www.google.com + space → link', () => {
    const v = mount('www.google.com', rules());
    type(v, ' ');
    expect(linkHref(v)).toBe('https://www.google.com/');
  });
  it('scheme\'d URL + space → link (scheme preserved)', () => {
    const v = mount('http://x.com', rules());
    type(v, ' ');
    expect(linkHref(v)).toBe('http://x.com');
  });
  it('"etc." + space → NO link', () => {
    const v = mount('etc.', rules());
    type(v, ' ');
    expect(linkHref(v)).toBeNull();
  });
  it('"file.txt" + space → NO link', () => {
    const v = mount('see file.txt', rules());
    type(v, ' ');
    expect(linkHref(v)).toBeNull();
  });
});

describe('autolink — ENTER boundary (keymap + deckAdapter primitive)', () => {
  const paraCount = (v: EditorView) => { let n = 0; v.state.doc.descendants((nd) => { if (nd.type.name === 'paragraph') n++; }); return n; };
  it('hardware Enter: bare google.com → link AND the newline still happens', () => {
    const v = mount('google.com', [buildKeymapPlugin(deltoSchema, autolinkTransforms())]);
    expect(paraCount(v)).toBe(1);
    v.someProp('handleKeyDown', (f) => f(v, new KeyboardEvent('keydown', { key: 'Enter' })));
    expect(linkHref(v)).toBe('https://google.com/');
    expect(paraCount(v)).toBe(2);
  });
  it('linkifyTrailingUrl (the keypad/deckAdapter primitive) links a scheme\'d URL', () => {
    const v = mount('https://deltos.dev', [keymap(baseKeymap)]);
    expect(linkifyTrailingUrl(v.state, v.dispatch)).toBe(true);
    expect(linkHref(v)).toBe('https://deltos.dev/');
  });
  it('plain Enter with no trailing URL just splits (no link)', () => {
    const v = mount('hello', [buildKeymapPlugin(deltoSchema, autolinkTransforms())]);
    v.someProp('handleKeyDown', (f) => f(v, new KeyboardEvent('keydown', { key: 'Enter' })));
    expect(linkHref(v)).toBeNull();
    expect(paraCount(v)).toBe(2);
  });
});

// Mount a paragraph whose text carries the link mark, caret at the end (the run's RIGHT EDGE).
function mountLinked(text: string, plugins: Plugin[]): EditorView {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const link = deltoSchema.marks['link']!.create({ href: 'https://google.com/', title: null });
  const para = deltoSchema.nodes['paragraph']!.create({ id: null }, deltoSchema.text(text, [link]));
  const doc = deltoSchema.nodes['doc']!.create(null, [deltoSchema.nodes['title']!.create({ id: null }), para]);
  let state = EditorState.create({ doc, plugins });
  state = state.apply(state.tr.setSelection(TextSelection.atEnd(state.doc)));
  view = new EditorView(container, { state });
  return view;
}

describe('autolink — BACKSPACE unwrap + SPACE/ENTER re-link (#74; keymap + Deck)', () => {

  it('HARDWARE Backspace at a linked run right edge: strips the mark, keeps text, deletes NO char', () => {
    const v = mountLinked('google.com', [buildKeymapPlugin(deltoSchema, autolinkTransforms())]);
    expect(linkHref(v)).toBe('https://google.com/');
    v.someProp('handleKeyDown', (f) => f(v, new KeyboardEvent('keydown', { key: 'Backspace' })));
    expect(linkHref(v)).toBeNull();
    expect(v.state.doc.textContent).toBe('google.com'); // text intact — only the mark was removed
  });

  it('unwrapLinkBackspace returns false when NOT at a link edge (normal delete)', () => {
    const v = mount('hello', [keymap(baseKeymap)]);
    expect(unwrapLinkBackspace(v.state, v.dispatch)).toBe(false);
  });

  it('DECK Backspace (keypad path, bypasses the keymap) unwraps the link; a SECOND deletes a char', () => {
    const v = mountLinked('google.com', []);
    const acts = buildPmKeyActions(() => v, autolinkTransforms());
    acts.backspace();
    expect(linkHref(v)).toBeNull();
    expect(v.state.doc.textContent).toBe('google.com'); // first backspace: unlink only
    acts.backspace();
    expect(v.state.doc.textContent).toBe('google.co'); // second: normal char delete
  });

  it('DECK single SPACE links a trailing URL (the closed Deck gap) — links AND inserts the space', () => {
    const v = mount('google.com', []);
    expect(linkHref(v)).toBeNull();
    buildPmKeyActions(() => v, autolinkTransforms()).insert(' ');
    expect(linkHref(v)).toBe('https://google.com/'); // re-linked on the Deck space path
    expect(v.state.doc.textContent).toBe('google.com '); // space inserted, not consumed
  });
});
