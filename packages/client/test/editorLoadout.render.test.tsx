/**
 * #69 editor-loadout v1 (commit 2) — the Deploy-3 tool registry assembled into the Deck's layers:
 *  - EditorGroupSelector (below the keys): the 4 group toggles + Undo/Redo, host-injected via baseExtra.
 *  - EditorGroupSubmenu (above the keys): the active group's tools, host-injected via the submenu seam.
 *  - integration: the selector renders in the editor's Deck; tapping a group opens/closes its submenu.
 *
 * Reuses the MobileEditorBar registry + button classes — assembled, not redesigned.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { BlockBody } from '@deltos/shared';
import { EditorGroupSelector, EditorGroupSubmenu } from '../src/editor/editorLoadoutTools.js';
import { EMPTY_ACTIVE_STATE } from '../src/editor/editorState.js';
import { db } from '../src/db/schema.js';
import { writeCustomKeyboard } from '../src/db/kbPointer.js';
import { useCustomKeyboardStore } from '../src/lib/useCustomKeyboard.js';
import { ProseMirrorEditor } from '../src/editor/ProseMirrorEditor.js';
import { DeckHostProvider } from '../src/components/DeckHost.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const tap = (el: Element | null) => fireEvent.pointerDown(el!);
const groupBtn = (label: string) =>
  document.querySelector(`.elt-groups button[aria-label="${label}"]`) as HTMLButtonElement | null;

describe('EditorGroupSelector — group toggles + Undo/Redo (the row below the keys)', () => {
  it('renders the 4 groups + Undo/Redo; tapping a group calls toggleGroup with its id', () => {
    const toggleGroup = vi.fn();
    render(<EditorGroupSelector activeGroup={null} toggleGroup={toggleGroup} active={EMPTY_ACTIVE_STATE} onUndo={() => {}} onRedo={() => {}} />);
    for (const g of ['Style', 'Format', 'Lists', 'Insert']) expect(groupBtn(g), g).not.toBeNull();
    expect(document.querySelector('.elt-history button[aria-label="Undo"]')).not.toBeNull();
    expect(document.querySelector('.elt-history button[aria-label="Redo"]')).not.toBeNull();
    tap(groupBtn('Format'));
    expect(toggleGroup).toHaveBeenCalledWith('format');
  });

  it('highlights the open group (.is-active); Undo/Redo disabled per the active snapshot', () => {
    render(<EditorGroupSelector activeGroup="style" toggleGroup={() => {}} active={EMPTY_ACTIVE_STATE} onUndo={() => {}} onRedo={() => {}} />);
    expect(groupBtn('Style')!.className).toContain('is-active');
    expect(groupBtn('Format')!.className).not.toContain('is-active');
    // EMPTY_ACTIVE_STATE has nothing to undo/redo → both disabled.
    expect((document.querySelector('button[aria-label="Undo"]') as HTMLButtonElement).disabled).toBe(true);
    expect((document.querySelector('button[aria-label="Redo"]') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('EditorGroupSubmenu — the active group\'s tools (the layer above the keys)', () => {
  it('renders nothing when no group is open', () => {
    const { container } = render(<EditorGroupSubmenu activeGroup={null} active={EMPTY_ACTIVE_STATE} run={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('format group → B/I/U/S controls from the registry; tapping one runs that tool', () => {
    const run = vi.fn();
    render(<EditorGroupSubmenu activeGroup="format" active={EMPTY_ACTIVE_STATE} run={run} />);
    expect(document.querySelector('.elt-sub')).not.toBeNull();
    const bold = document.querySelector('.elt-sub button[aria-label="Bold"]');
    expect(bold).not.toBeNull();
    tap(bold);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0].id).toBe('bold');
  });
});

describe('editor loadout — integration (selector + submenu wired into the Deck)', () => {
  beforeEach(async () => {
    await db.deviceState.clear();
    useCustomKeyboardStore.setState({ enabled: false, _loaded: false });
    global.fetch = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })) as typeof fetch;
    await writeCustomKeyboard(true);
  });

  const emptyBody = [] as BlockBody;
  const renderEditor = () =>
    render(
      <MemoryRouter>
        <DeckHostProvider enabled>
          <ProseMirrorEditor noteId="n1" initialTitle="T" initialBody={emptyBody} onChange={() => {}} autoFocus />
        </DeckHostProvider>
      </MemoryRouter>,
    );

  it('selector renders below the keypad; tapping a group opens its submenu, tapping again closes it', async () => {
    renderEditor();
    await waitFor(() => expect(document.querySelector('.keypad')).not.toBeNull());
    expect(document.querySelector('.elt-groups')).not.toBeNull(); // selector present
    expect(document.querySelector('.elt-sub')).toBeNull();        // no group open at rest

    tap(groupBtn('Format'));
    expect(document.querySelector('.elt-sub')).not.toBeNull();
    expect(document.querySelector('.elt-sub button[aria-label="Bold"]')).not.toBeNull();

    tap(groupBtn('Format')); // sticky toggle — same group closes
    expect(document.querySelector('.elt-sub')).toBeNull();
  });
});
