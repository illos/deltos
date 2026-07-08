import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Note } from '@deltos/shared';

/**
 * Board render test (notebook-menu-and-keep-view.md §6, standing ui-features-need-rendered-ui-gate). Proves the
 * Keep grid mounts, renders a card per note (title + preview) in the SAME sortNotes order, and — on desktop —
 * opens the note popover-over-blur when the URL matches /note/:id (backdrop present). Store + device + the lazy
 * NoteRoute are mocked so the view mounts in isolation.
 */

const notesRef = { current: [] as Note[] };
const desktop = { current: true };
vi.mock('../db/storeHooks.js', () => ({
  useNotes: () => notesRef.current,
  useCurrentNotebook: () => ({ id: 'nb-1', name: 'Work', defaultCollectionView: 'board', noteSort: 'modified' }),
}));
vi.mock('../lib/useIsDesktop.js', () => ({ useIsDesktop: () => desktop.current }));
vi.mock('../routes/NoteRoute.js', () => ({ NoteRoute: () => <div data-testid="note-route">NOTE</div> }));
vi.mock('../components/FileNotePill.js', () => ({ FileNotePill: () => <div data-testid="file-pill" /> }));
vi.mock('../components/ConflictBadgeSlot.js', () => ({ ConflictBadgeSlot: () => null }));

import { Board } from './Board.js';

function note(id: string, title: string, updatedAt: string, body: unknown[] = []): Note {
  return { id, notebookId: 'nb-1', title, updatedAt, createdAt: updatedAt, properties: {}, body } as unknown as Note;
}

beforeEach(() => {
  notesRef.current = [
    note('n1', 'Alpha', '2026-06-01T00:00:00Z', [{ content: { segments: [{ text: 'first body' }] } }]),
    note('n2', 'Beta', '2026-06-02T00:00:00Z'),
  ];
  desktop.current = true;
});
afterEach(cleanup);

describe('Board (Keep grid view)', () => {
  it('mounts the grid and renders a card per note (modified DESC → Beta before Alpha)', () => {
    const { container, getByText } = render(
      <MemoryRouter initialEntries={['/']}>
        <Board notebookId={'nb-1' as never} />
      </MemoryRouter>,
    );
    expect(container.querySelector('.board')).not.toBeNull();
    const titles = Array.from(container.querySelectorAll('.board__card-title')).map((e) => e.textContent);
    expect(titles).toEqual(['Beta', 'Alpha']); // updatedAt DESC
    expect(getByText('first body')).not.toBeNull(); // preview line
  });

  it('renders the empty state with no notes', () => {
    notesRef.current = [];
    const { getByText } = render(
      <MemoryRouter initialEntries={['/']}>
        <Board notebookId={'nb-1' as never} />
      </MemoryRouter>,
    );
    expect(getByText('No notes yet.')).not.toBeNull();
  });

  it('opens the desktop note popover-over-blur when the URL is /note/:id', async () => {
    const { container, findByTestId } = render(
      <MemoryRouter initialEntries={['/note/n1']}>
        <Board notebookId={'nb-1' as never} />
      </MemoryRouter>,
    );
    expect(container.querySelector('.board-note-popover')).not.toBeNull();
    expect(container.querySelector('.board-note-popover__backdrop')).not.toBeNull();
    await findByTestId('note-route'); // the lazy NoteRoute mounts inside the popover
  });

  it('does NOT open a popover on mobile (note is a separate full-screen route)', async () => {
    desktop.current = false;
    const { container } = render(
      <MemoryRouter initialEntries={['/note/n1']}>
        <Board notebookId={'nb-1' as never} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(container.querySelector('.board')).not.toBeNull());
    expect(container.querySelector('.board-note-popover')).toBeNull();
  });
});
