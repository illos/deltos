/**
 * #69 desktop Deck — EditorControlStrip render gate. The desktop editor toolbar is the Deck editor loadout's
 * converged registry rendered FLAT (all tools expanded inline; Jim's pick), not a click-to-expand collapse.
 * Mounts ProseMirrorEditor at a desktop viewport and asserts the strip's real DOM — all tools visible up
 * front + Undo/Redo, a tool acts on the selection, and the link tool opens the native URL+Title form.
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

describe('EditorControlStrip — desktop flat (expanded)', () => {
  it('renders ALL tools inline up front (no click-to-expand) + Undo/Redo', async () => {
    mount();
    await waitFor(() => expect(strip()).not.toBeNull());
    // Tools from every group are visible immediately — no group-toggle step.
    for (const label of ['Heading', 'Bold', 'Italic', 'Bullet list', 'Link', 'Undo', 'Redo']) {
      expect(btn(label), `${label} button`).not.toBeNull();
    }
    // No group-SELECTOR toggle buttons (that was the collapsed model); divider(s) separate groups instead.
    expect(btn('Style')).toBeNull();
    expect(document.querySelectorAll('.editor__deck-strip-divider').length).toBeGreaterThan(0);
  });

  it('Bold toggles the selection directly (no group to open first)', async () => {
    let view: EditorView | null = null;
    mount((v) => { view = v; });
    await waitFor(() => expect(view).not.toBeNull());
    const v = view!;
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

    fireEvent.pointerDown(btn('Link')!);
    const title = await waitFor(() => document.querySelector('input[aria-label="Link title"]') as HTMLInputElement);
    const url = document.querySelector('input[aria-label="Link URL"]') as HTMLInputElement;
    act(() => { fireEvent.change(title, { target: { value: 'My Site' } }); });
    act(() => { fireEvent.change(url, { target: { value: 'example.com' } }); });
    fireEvent.mouseDown(document.querySelector('button[aria-label="Apply link"]')!);

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
