/**
 * #69 Phase 1 — the custom keyboard. Two concerns:
 *  - KeyGrid (the text-context layout): functional keys — letters (lowercase default), shift one-shot,
 *    space (stacks incl. trailing), backspace (own char-delete; tap=one, hold=accelerating), return.
 *  - KeyboardSurface (the footprint): renders the layout for the active context; the keypad is the
 *    'text' layout, replaceable AND hideable (a context with no registered layout renders nothing).
 * Geometry is navSys's overlay-diff gate; hold-accel cadence is Jim's on-device feel.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { Schema } from 'prosemirror-model';
import { EditorState, NodeSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { KeyGrid } from '../src/editor/KeyGrid.js';
import { KeyboardSurface, deriveKeyboardContext } from '../src/editor/KeyboardSurface.js';

// Minimal schema with a SELECTABLE atom node so we can exercise NodeSelection (non-text context).
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'text*', toDOM: () => ['p', 0], parseDOM: [{ tag: 'p' }] },
    widget: { group: 'block', atom: true, selectable: true, toDOM: () => ['div', { 'data-widget': '' }], parseDOM: [{ tag: 'div[data-widget]' }] },
    text: {},
  },
  marks: {},
});

let view: EditorView;
afterEach(() => { cleanup(); view?.destroy(); vi.useRealTimers(); vi.restoreAllMocks(); });

function mountGrid() {
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  view = new EditorView(mount, {
    state: EditorState.create({ doc: schema.node('doc', null, [schema.node('paragraph')]), schema }),
  });
  view.focus();
  render(<KeyGrid view={view} />);
}
const key = (label: string) => document.querySelector(`.kb__key[aria-label="${label}"]`) as HTMLButtonElement;
const tap = (label: string) => fireEvent.pointerDown(key(label));
const text = () => view.state.doc.textContent;

describe('KeyGrid — structure + typing', () => {
  it('renders the 4 rows + the full key set', () => {
    mountGrid();
    expect(document.querySelectorAll('.kb__row').length).toBe(4);
    for (const l of ['Q', 'A', 'Z', 'Shift', 'Backspace', 'Space', 'Return']) expect(key(l), l).not.toBeNull();
  });

  it('every key is a tiling hit CELL with the visible key as a centered .kb__face (#349 zero dead zones)', () => {
    mountGrid();
    const keys = [...document.querySelectorAll('.kb__key')];
    expect(keys.length).toBeGreaterThan(20);
    // The hit target (button) wraps a single visible face — the cell tiles, the face stays at geometry.
    for (const k of keys) expect(k.querySelector('.kb__face'), k.getAttribute('aria-label') ?? '').not.toBeNull();
  });
  it('letters insert lowercase by default', () => { mountGrid(); tap('Q'); tap('A'); tap('Z'); expect(text()).toBe('qaz'); });
  it('shift one-shot: capitalizes the next letter then auto-releases', () => {
    mountGrid();
    tap('Shift');
    expect(key('Shift').getAttribute('aria-pressed')).toBe('true');
    tap('Q'); tap('W');
    expect(text()).toBe('Qw');
    expect(key('Shift').getAttribute('aria-pressed')).toBe('false');
  });
  it('space stacks (multiple interior + a trailing space)', () => {
    mountGrid();
    tap('A'); tap('Space'); tap('Space'); tap('B'); tap('Space');
    expect(text()).toBe('a  b ');
  });
  it('backspace tap deletes one char', () => {
    mountGrid();
    tap('A'); tap('B'); tap('C');
    fireEvent.pointerDown(key('Backspace')); fireEvent.pointerUp(key('Backspace'));
    expect(text()).toBe('ab');
  });
  it('return splits the block', () => {
    mountGrid();
    tap('A'); tap('Return'); tap('B');
    expect(view.state.doc.childCount).toBe(2);
  });
  it('backspace hold deletes more than one char (accelerating repeat)', () => {
    vi.useFakeTimers();
    mountGrid();
    tap('A'); tap('B'); tap('C'); tap('D'); tap('E');
    fireEvent.pointerDown(key('Backspace'));
    vi.advanceTimersByTime(380 + 200 + 182);
    fireEvent.pointerUp(key('Backspace'));
    expect(text().length).toBeLessThan(4);
  });
});

describe('KeyboardSurface — context-driven footprint', () => {
  it('renders the keypad for the text context', () => {
    render(<KeyboardSurface view={null} context="text" />);
    expect(document.querySelector('.kb__grid')).not.toBeNull();
    expect(document.querySelector('.kb[data-kb-context="text"]')).not.toBeNull();
  });
  it('renders NOTHING for a context with no registered layout (keypad hideable)', () => {
    const { container } = render(<KeyboardSurface view={null} context="node:widget" />);
    expect(container.firstChild).toBeNull();
  });

  it('the surface swallows pointerdown on the backplane/gaps (preventDefault → editor never blurs)', () => {
    render(<KeyboardSurface view={null} context="text" />);
    // A tap on the container/gap (not a key) must be preventDefaulted so focus stays on the editor.
    const surface = document.querySelector('.kb') as HTMLElement;
    const ev = new Event('pointerdown', { bubbles: true, cancelable: true });
    surface.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    // And the inert 123 key is a real (non-disabled) focus-preserving button, not a dismisser.
    const mode = document.querySelector('.kb__key--mode') as HTMLButtonElement;
    expect(mode.disabled).toBe(false);
  });
  it('deriveKeyboardContext: TextSelection → text, NodeSelection → node:<type>', () => {
    // Lead with a paragraph so the default selection is a text caret; the widget follows for the node case.
    const base = EditorState.create({ doc: schema.node('doc', null, [schema.node('paragraph'), schema.node('widget')]), schema });
    expect(deriveKeyboardContext(base)).toBe('text'); // default caret in the paragraph
    const widgetPos = base.doc.child(0).nodeSize; // position just before the widget
    const nodeSel = base.apply(base.tr.setSelection(NodeSelection.create(base.doc, widgetPos)));
    expect(deriveKeyboardContext(nodeSel)).toBe('node:widget');
  });
});
