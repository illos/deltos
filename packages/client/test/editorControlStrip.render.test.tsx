/**
 * #69 desktop Deck — EditorControlStrip render gate. The desktop editor toolbar is now the Deck editor
 * loadout (selector → submenu), not a flat row: mounts ProseMirrorEditor at a desktop viewport and asserts
 * the strip's real DOM — group buttons + Undo/Redo, tools hidden until a group opens, a tool acts on the
 * selection, and the link tool opens the native URL+Title form and inserts a linked title.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act, waitFor, fireEvent } from '@testing-library/react';
import { TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import type { BlockBody, BlockId } from '@deltos/shared';
import { deltoSchema } from '../src/editor/schema.js';
import { ProseMirrorEditor } from '../src/editor/ProseMirrorEditor.js';

const PID = '22222222-2222-4222-8222-222222222222' as BlockId;
const body: BlockBody = [{ id: PID, type: 'paragraph', content: { segments: [{ text: 'hello' }] } }];

function mount(onViewInit?: (v: EditorView | null) => void) {
  return render(
    <ProseMirrorEditor noteId="n1" initialTitle="T" initialBody={body} onChange={() => {}} onViewInit={onViewInit} />,
  );
}
const strip = () => document.querySelector('.editor__deck-strip') as HTMLElement | null;
const btn = (label: string) => document.querySelector(`.editor__deck-strip button[aria-label="${label}"]`) as HTMLButtonElement | null;

beforeEach(() => {
  // Desktop viewport → useIsDesktop true → the control strip renders (customKb is false on desktop).
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('EditorControlStrip — desktop selector', () => {
  it('renders the group selector + Undo/Redo; tools are hidden until a group opens', async () => {
    mount();
    await waitFor(() => expect(strip()).not.toBeNull());
    expect(btn('Style')).not.toBeNull();
    expect(btn('Format')).not.toBeNull();
    expect(btn('Insert')).not.toBeNull();
    expect(btn('Undo')).not.toBeNull();
    expect(btn('Redo')).not.toBeNull();
    // No keypad show/hide toggle on desktop, and tools collapse until a group is chosen.
    expect(btn('Bold')).toBeNull();
  });

  it('opening Format reveals its tools; Bold toggles the selection', async () => {
    let view: EditorView | null = null;
    mount((v) => { view = v; });
    await waitFor(() => expect(view).not.toBeNull());
    const v = view!;

    fireEvent.pointerDown(btn('Format')!);
    await waitFor(() => expect(btn('Bold')).not.toBeNull());

    act(() => { v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 4, 9))); });
    fireEvent.pointerDown(btn('Bold')!);
    expect(v.state.doc.rangeHasMark(4, 9, deltoSchema.marks['bold']!)).toBe(true);
  });
});

describe('EditorControlStrip — link form', () => {
  it('the link tool opens the URL+Title form and inserts a linked title', async () => {
    let view: EditorView | null = null;
    mount((v) => { view = v; });
    await waitFor(() => expect(view).not.toBeNull());
    const v = view!;
    act(() => { v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 9))); }); // caret at end of 'hello'

    // Link lives in the Insert ("+") group on the mobile/Deck tool set.
    fireEvent.pointerDown(btn('Insert')!);
    await waitFor(() => expect(btn('Link')).not.toBeNull());
    fireEvent.pointerDown(btn('Link')!);

    const title = await waitFor(() => document.querySelector('input[aria-label="Link title"]') as HTMLInputElement);
    const url = document.querySelector('input[aria-label="Link URL"]') as HTMLInputElement;
    act(() => { fireEvent.change(title, { target: { value: 'My Site' } }); });
    act(() => { fireEvent.change(url, { target: { value: 'example.com' } }); });
    fireEvent.mouseDown(document.querySelector('button[aria-label="Apply link"]')!);

    // The linked title text is inserted, carrying a link mark with the normalized href.
    const linkType = deltoSchema.marks['link']!;
    let found = false;
    v.state.doc.descendants((node) => {
      if (node.isText && node.text === 'My Site' && linkType.isInSet(node.marks)) {
        found = true;
        expect(node.marks.find((m) => m.type === linkType)?.attrs.href).toBe('https://example.com/');
      }
    });
    expect(found).toBe(true);
  });
});
