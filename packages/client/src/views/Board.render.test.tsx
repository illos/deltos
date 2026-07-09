import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, cleanup, waitFor } from '@testing-library/react';
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
const resizeObservers: MockResizeObserver[] = [];

class MockResizeObserver {
  elements = new Set<Element>();
  constructor(private readonly cb: ResizeObserverCallback) {
    resizeObservers.push(this);
  }
  observe = (el: Element) => { this.elements.add(el); };
  unobserve = (el: Element) => { this.elements.delete(el); };
  disconnect = () => { this.elements.clear(); };
  trigger(entries: Array<{ target: Element; height: number }>) {
    this.cb(entries.map(({ target, height }) => {
      // The hook measures the BORDER box: borderBoxSize (absent in jsdom) → getBoundingClientRect() fallback.
      // Stub the target's bounding rect so the fallback yields the intended border-box height.
      (target as HTMLElement).getBoundingClientRect = () =>
        ({ height, width: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
      return {
        target,
        contentRect: { height: 0 } as DOMRectReadOnly, // deliberately wrong — proves the hook ignores contentRect
      } as ResizeObserverEntry;
    }), this as unknown as ResizeObserver);
  }
}

vi.mock('../db/storeHooks.js', () => ({
  useNotes: () => notesRef.current,
  useCurrentNotebook: () => ({ id: 'nb-1', name: 'Work', defaultCollectionView: 'board', noteSort: 'modified' }),
}));
vi.mock('../lib/useIsDesktop.js', () => ({ useIsDesktop: () => desktop.current }));
// The mock reads useParams like the real NoteRoute — regression guard: the popover must mount it inside a
// matching Route context or the :id param is undefined (the live "Invalid note URL" bug).
vi.mock('../routes/NoteRoute.js', async () => {
  const { useParams } = await import('react-router-dom');
  return { NoteRoute: () => <div data-testid="note-route">{useParams().id ?? 'NO-PARAM'}</div> };
});
vi.mock('../components/FileNotePill.js', () => ({ FileNotePill: () => <div data-testid="file-pill" /> }));
vi.mock('../components/ConflictBadgeSlot.js', () => ({ ConflictBadgeSlot: () => null }));

import { Board } from './Board.js';

function note(id: string, title: string, updatedAt: string, body: unknown[] = []): Note {
  return { id, notebookId: 'nb-1', title, updatedAt, createdAt: updatedAt, properties: {}, body } as unknown as Note;
}

beforeEach(() => {
  resizeObservers.length = 0;
  vi.stubGlobal('ResizeObserver', MockResizeObserver);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => window.setTimeout(() => cb(performance.now()), 0));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
  notesRef.current = [
    note('n1', 'Alpha', '2026-06-01T00:00:00Z', [{ content: { segments: [{ text: 'first body' }] } }]),
    note('n2', 'Beta', '2026-06-02T00:00:00Z'),
  ];
  desktop.current = true;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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

  it('keeps one DOM-ordered grid and writes measured row spans onto cells', async () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/']}>
        <Board notebookId={'nb-1' as never} />
      </MemoryRouter>,
    );
    const cells = Array.from(container.querySelectorAll<HTMLElement>('.board__cell'));
    const cards = Array.from(container.querySelectorAll<HTMLElement>('.board__card'));
    expect(cells).toHaveLength(2);
    expect(cards.map((card) => card.textContent)).toEqual([
      expect.stringContaining('Beta'),
      expect.stringContaining('Alpha'),
    ]);
    await waitFor(() => expect(resizeObservers[0]?.elements.size).toBe(2));

    act(() => {
      resizeObservers[0]!.trigger([
        { target: cards[0]!, height: 88 },
        { target: cards[1]!, height: 28 },
      ]);
    });

    await waitFor(() => {
      expect(cells[0]!.style.getPropertyValue('--board-row-span')).toBe('5');
      expect(cells[1]!.style.getPropertyValue('--board-row-span')).toBe('2');
    });
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
    // The lazy NoteRoute mounts inside the popover AND receives the :id route param (not 'NO-PARAM').
    const noteRoute = await findByTestId('note-route');
    expect(noteRoute.textContent).toBe('n1');
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
