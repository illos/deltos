/**
 * Deploy 3 — slice C: desktop EditorToolbar render gate (rendered-UI gate). Mounts ProseMirrorEditor
 * at a desktop viewport and asserts the registry-driven toolbar's real DOM: 4 ordered groups + 3
 * dividers + accessible labels, a mark toggles the selection, a block button changes the block, and
 * the active treatment tracks the selection.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act, waitFor } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import type { BlockBody, BlockId } from '@deltos/shared';
import { deltoSchema } from '../src/editor/schema.js';
import { ProseMirrorEditor } from '../src/editor/ProseMirrorEditor.js';

// The PM-in-jsdom rect shim now lives in the shared test/setup.ts (task #65), so it covers every
// editor render test rather than just this one.

const PID = '22222222-2222-4222-8222-222222222222' as BlockId;
const body: BlockBody = [{ id: PID, type: 'paragraph', content: { segments: [{ text: 'hello' }] } }];

function mount(onViewInit?: (v: EditorView | null) => void) {
  return render(
    <ProseMirrorEditor noteId="n1" initialTitle="T" initialBody={body} onChange={() => {}} onViewInit={onViewInit} />,
  );
}
const fmtbar = () => document.querySelector('.editor__fmtbar') as HTMLElement | null;
const btn = (label: string) => document.querySelector(`.editor__fmtbar button[aria-label="${label}"]`) as HTMLButtonElement | null;

beforeEach(() => {
  // Desktop viewport → useIsDesktop true → the formatting toolbar renders (not the mobile interim bar).
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('EditorToolbar — desktop structure', () => {
  it('renders 4 groups in order, 3 dividers, and every tool with an accessible label', async () => {
    mount();
    await waitFor(() => expect(fmtbar()).not.toBeNull());

    expect(document.querySelectorAll('.editor__fmtbar-divider').length).toBe(3);
    for (const label of [
      'Title', 'Heading', 'Subhead', 'Mono',                 // style (Body removed — toggles to/from body)
      'Bold', 'Italic', 'Underline', 'Strikethrough', 'Highlight', 'Code', 'Link', // format (link desktop)
      'Bullet list', 'Numbered list', 'Checklist',           // lists
      'Quote', 'Divider',                                    // insert (image omitted)
    ]) {
      expect(btn(label), `${label} button`).not.toBeNull();
    }
    // Image is intentionally absent; Body is no longer a button (it's the implicit default — #69).
    expect(btn('Image')).toBeNull();
    expect(btn('Body')).toBeNull();
    // First 4 buttons are the style group in order (Mono moved up after Body's removal).
    const labels = [...document.querySelectorAll('.editor__fmtbar button')].slice(0, 4).map((b) => b.getAttribute('aria-label'));
    expect(labels).toEqual(['Title', 'Heading', 'Subhead', 'Mono']);
  });
});

describe('EditorToolbar — commands act on the selection', () => {
  it('clicking Bold with a selection wraps it in bold; clicking again removes it', async () => {
    let view: EditorView | null = null;
    mount((v) => { view = v; });
    await waitFor(() => expect(view).not.toBeNull());
    const v = view!;
    // 'hello' content: title 'T'(nodeSize 3) → paragraph opens at 3, content at 4, 'hello' 4..9.
    act(() => { v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 4, 9))); });

    fireEvent.mouseDown(btn('Bold')!);
    expect(v.state.doc.rangeHasMark(4, 9, deltoSchema.marks['bold']!)).toBe(true);

    act(() => { v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 4, 9))); });
    fireEvent.mouseDown(btn('Bold')!);
    expect(v.state.doc.rangeHasMark(4, 9, deltoSchema.marks['bold']!)).toBe(false);
  });

  it('clicking Heading turns the paragraph into an h2 and the button reads active', async () => {
    let view: EditorView | null = null;
    mount((v) => { view = v; });
    await waitFor(() => expect(view).not.toBeNull());
    const v = view!;
    act(() => { v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 6))); });

    fireEvent.mouseDown(btn('Heading')!);
    expect(v.state.doc.child(1).type.name).toBe('heading');
    expect(v.state.doc.child(1).attrs.level).toBe(2);
    // Active treatment reflects the selection now sitting in an h2.
    await waitFor(() => expect(btn('Heading')!.getAttribute('aria-pressed')).toBe('true'));

    // Tapping Heading AGAIN toggles it off to body (paragraph) — no Body button now (#69).
    fireEvent.mouseDown(btn('Heading')!);
    expect(v.state.doc.child(1).type.name).toBe('paragraph');
  });
});
