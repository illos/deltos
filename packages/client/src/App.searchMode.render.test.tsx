import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Note } from '@deltos/shared';

/**
 * In-place search mode on the note list (search-rev, standing ui-features-need-rendered-ui-gate).
 *
 * Mounts the REAL HomeView inside the REAL DeckHostProvider (so the actual Deck surface renders) and
 * proves the routed DOM:
 *   - opening search (the shared flag the Deck Search slot flips) reveals a live field AND the note list
 *     STAYS present (parity with desktop — the list doesn't vanish until you type),
 *   - in keypad mode the Deck flips to a KEYS-ONLY 'search' loadout (keypad rows, empty base region, NO
 *     editor tools — no show/hide toggle, no top slot),
 *   - typing swaps the list for results; clearing restores the list,
 *   - closing exits search mode and the Deck context returns to 'navigation'.
 *
 * jsdom does no layout, so pixel geometry / --deck-h clearance is feel-tested on deploy; this pins the
 * structural contract (context flip + which loadout renders + the list⇄results swap).
 */

// Mobile shell → in-place search is active (desktop keeps the /search route).
vi.mock('./lib/useIsDesktop.js', () => ({ useIsDesktop: () => false }));
// Keypad mode is per-test controllable (keypad path vs native fallback).
const kp = vi.hoisted(() => ({ value: true }));
vi.mock('./lib/useKeypadMode.js', () => ({ useKeypadMode: () => kp.value }));
vi.mock('./lib/dnd/useNoteDnd.js', () => ({ useNoteDnd: () => null }));
vi.mock('./lib/dnd/useFileNoteDnd.js', () => ({ useFileNoteDnd: () => null }));
vi.mock('./lib/upload/useFilePickerUpload.js', () => ({ useFilePickerUpload: () => null }));
// No NavSheetProvider in the mount → the nav-sheet arm handlers are a no-op set.
vi.mock('./components/NavSheet.js', () => ({ useNavSheetArm: () => ({}) }));
// Side-effect seams (unused in these paths) stubbed so the mount is light.
vi.mock('./db/mutate.js', () => ({ mutateNotes: {} }));
vi.mock('./lib/syncEngine.js', () => ({ notifyQueueWrite: vi.fn() }));
vi.mock('./lib/toastEvents.js', () => ({ showToast: vi.fn(), showActionToast: vi.fn() }));

// Control the note list without standing up Dexie/liveQuery.
const notesRef: { current: Note[] } = { current: [] };
vi.mock('./db/storeHooks.js', () => ({
  useNotes: () => notesRef.current,
  useNotebooks: () => [],
  useCurrentNotebook: () => null,
}));
vi.mock('./lib/notebookStore.js', () => ({
  useNotebookStore: (sel: (s: unknown) => unknown) => sel({ currentNotebookId: null }),
}));
// Deterministic fuzzy engine: one hit for any non-empty query, none for empty.
vi.mock('./lib/search.js', () => ({
  searchNotes: (_notes: unknown, q: string) =>
    q
      ? [{
          note: { id: 'r1', notebookId: null, title: 'Groceries', updatedAt: Date.now() },
          score: 1,
          snippet: '',
          snippetRanges: [],
          titleRanges: [],
        }]
      : [],
}));

// Imported AFTER the mocks (vi.mock is hoisted).
import { HomeView } from './App.js';
import { DeckHostProvider } from './components/DeckHost.js';
import { useSearchModeStore } from './lib/searchModeStore.js';

function mountHome() {
  const utils = render(
    <MemoryRouter>
      <DeckHostProvider enabled>
        <HomeView notebookId={null} />
      </DeckHostProvider>
    </MemoryRouter>,
  );
  return utils.container;
}

function fakeNote(id: string): Note {
  const now = Date.now();
  return {
    id,
    notebookId: null,
    title: 'Note ' + id,
    content: { type: 'doc', content: [] },
    properties: {},
    createdAt: now,
    updatedAt: now,
  } as unknown as Note;
}

const openSearch = () => act(() => { useSearchModeStore.getState().setOpen(true); });
const deck = (c: HTMLElement) => c.querySelector('.deck') as HTMLElement;

beforeEach(() => {
  kp.value = true;
  notesRef.current = [fakeNote('a'), fakeNote('b')];
  useSearchModeStore.setState({ open: false });
});
afterEach(() => { cleanup(); useSearchModeStore.setState({ open: false }); });

describe('HomeView in-place search — keypad mode', () => {
  it('starts with the pill + the note list, Deck in the navigation context', () => {
    const c = mountHome();
    expect(c.querySelector('.home__search-field')).not.toBeNull();
    expect(c.querySelector('.home__search-input')).toBeNull();
    expect(c.querySelector('.home__notes')).not.toBeNull();
    expect(deck(c).getAttribute('data-deck-context')).toBe('navigation');
    expect(c.querySelector('.deck-nav')).not.toBeNull();
  });

  it('opening reveals the field, KEEPS the list, and flips the Deck to a keys-only search loadout', () => {
    const c = mountHome();
    openSearch();

    // The field appears in place; the note list is STILL there (parity: list doesn't vanish until typing).
    expect(c.querySelector('.home__search-input')).not.toBeNull();
    expect(c.querySelector('.home__notes')).not.toBeNull();
    expect((c.querySelector('.home') as HTMLElement).classList.contains('home--searching')).toBe(true);

    // Deck flipped to the 'search' context, showing the keypad keys.
    expect(deck(c).getAttribute('data-deck-context')).toBe('search');
    expect(c.querySelector('.keypad')).not.toBeNull();
    expect(c.querySelectorAll('.keypad__key').length).toBeGreaterThan(0);

    // KEYS-ONLY: the base-region container is present (locks key geometry) but empty — no editor tools.
    const base = c.querySelector('.keypad-loadout__base') as HTMLElement;
    expect(base).not.toBeNull();
    expect(base.children.length).toBe(0);
    expect(c.querySelector('.deck-kbd-toggle')).toBeNull();       // no show/hide toggle
    expect(c.querySelector('.keypad-loadout__top-slot')).toBeNull(); // no formatting/spell/link/voice slot
    expect(c.querySelector('.deck-nav')).toBeNull();               // nav loadout not shown while searching
  });

  it('the field suppresses the OS keyboard (inputMode=none) in keypad mode', () => {
    const c = mountHome();
    openSearch();
    expect(c.querySelector('.home__search-input')?.getAttribute('inputmode')).toBe('none');
  });

  it('typing on the keypad swaps the list for results; a keypad backspace to empty restores the list', async () => {
    const c = mountHome();
    openSearch();
    // Press a letter key on the keypad → drives the query via the keys-only KeyActions.
    const gKey = c.querySelector('.keypad__key[aria-label="G"]') as HTMLElement;
    expect(gKey).not.toBeNull();
    fireEvent.pointerDown(gKey);

    // Result row appears after the 200ms debounce flushes the fuzzy engine.
    await waitFor(() => expect(c.querySelector('.search__row-title')).not.toBeNull());
    expect(c.querySelector('.home__notes')).toBeNull(); // list gone once a query is present
    expect(c.querySelector('.search__row-title')?.textContent).toContain('Groceries');

    // Backspace the single character → query empty → list returns (still in search mode).
    const del = c.querySelector('.keypad__key--delete') as HTMLElement;
    fireEvent.pointerDown(del);
    fireEvent.pointerUp(del);
    await waitFor(() => expect(c.querySelector('.home__notes')).not.toBeNull());
    expect(c.querySelector('.search__body')).toBeNull();
    expect(c.querySelector('.home__search-input')).not.toBeNull(); // field still open
  });

  it('closing exits search mode and returns the Deck to the navigation context', () => {
    const c = mountHome();
    openSearch();
    expect(deck(c).getAttribute('data-deck-context')).toBe('search');

    const close = c.querySelector('.home__search-close') as HTMLElement;
    expect(close).not.toBeNull();
    fireEvent.click(close);

    expect(c.querySelector('.home__search-input')).toBeNull();
    expect(c.querySelector('.home__search-field')).not.toBeNull(); // back to the pill
    expect(c.querySelector('.home__notes')).not.toBeNull();
    expect(deck(c).getAttribute('data-deck-context')).toBe('navigation');
    expect(c.querySelector('.keypad')).toBeNull();
  });
});

describe('HomeView in-place search — native fallback (keypad mode off)', () => {
  beforeEach(() => { kp.value = false; });

  it('uses a plain search input and does NOT publish a Deck search loadout', () => {
    const c = mountHome();
    openSearch();
    const input = c.querySelector('.home__search-input') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.getAttribute('inputmode')).toBe('search');
    // No keypad published → the Deck stays on the nav context.
    expect(deck(c).getAttribute('data-deck-context')).toBe('navigation');
    expect(c.querySelector('.keypad')).toBeNull();
  });

  it('typing in the input swaps the list for results; clearing restores the list', async () => {
    const c = mountHome();
    openSearch();
    const input = c.querySelector('.home__search-input') as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'gro' } });
    await waitFor(() => expect(c.querySelector('.search__body')).not.toBeNull());
    expect(c.querySelector('.home__notes')).toBeNull();

    fireEvent.change(input, { target: { value: '' } });
    await waitFor(() => expect(c.querySelector('.home__notes')).not.toBeNull());
    expect(c.querySelector('.search__body')).toBeNull();
  });
});
