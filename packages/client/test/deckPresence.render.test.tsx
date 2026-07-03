/**
 * Deck presence is MODALITY-driven, not setting-driven (the custom-keyboard-toggle-no-longer-gates-the-Deck
 * refinement). Mounts the REAL AuthedShell (mobile / touch-first — useTouchPrimary's jsdom default is TRUE)
 * and proves:
 *
 *  - With the custom-keyboard setting OFF, the Deck host STILL renders its navigation loadout and
 *    body.deck-custom is applied (which is what hides the legacy standalone BottomNav) — the setting no
 *    longer makes the Deck vanish / the old BottomNav reappear (the reported regression).
 *  - With the setting ON, shell behavior is unchanged (Deck present + deck-custom).
 *  - WRINKLE: on the note route in NATIVE mode (setting OFF) the Deck is SUPPRESSED (body.deck-suppressed →
 *    CSS-hides .deck) so it can't float over the editor's sticky MobileEditorBar / the native keyboard —
 *    but it stays MOUNTED (the host is intact). With the setting ON (keypad), it is NOT suppressed.
 *
 * The heavy shell chrome (nav panes, session/sync status, sync engine, the lazy NoteRoute editor) is stubbed
 * at the module seam so the assertions target the Deck wiring under test; the REAL DeckHostProvider / Deck /
 * DeckNavLoadout render so "nav loadout present" is a real-DOM assertion (ui-features-need-rendered-ui-gate).
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Sync engine: no timers / network in a render test.
vi.mock('../src/lib/syncEngine.js', () => ({
  startSyncTriggers: vi.fn(() => () => {}),
  syncNow: vi.fn(),
  notifyQueueWrite: vi.fn(),
}));
// Data seams — deterministic empty lists (no Dexie liveQuery).
vi.mock('../src/db/storeHooks.js', () => ({
  useNotes: () => [],
  useNotebooks: () => [],
  useCurrentNotebook: () => null,
}));
vi.mock('../src/lib/dnd/useNoteDnd.js', () => ({ useNoteDnd: () => null }));
vi.mock('../src/lib/dnd/useFileNoteDnd.js', () => ({
  useFileNoteDnd: () => ({ allowFileDrop: () => false, dropFilesOnList: vi.fn() }),
}));
vi.mock('../src/db/mutate.js', () => ({ mutateNotes: new Proxy({}, { get: () => vi.fn() }) }));
vi.mock('../src/lib/toastEvents.js', () => ({ showToast: vi.fn(), showActionToast: vi.fn() }));
// Shell chrome we don't assert on — stub to keep the tree light and store-independent.
vi.mock('../src/components/DrawerNav.js', () => ({ DrawerNav: () => null }));
vi.mock('../src/components/FullScreenNav.js', () => ({ FullScreenNav: () => null }));
vi.mock('../src/components/SessionStatus.js', () => ({ SessionStatus: () => null }));
vi.mock('../src/components/SyncIndicator.js', () => ({ SyncIndicator: () => null }));
vi.mock('../src/components/ConflictToastHostSlot.js', () => ({ ConflictToastHostSlot: () => null }));
vi.mock('../src/components/UploadProgressHost.js', () => ({ UploadProgressHost: () => null }));
// The legacy standalone BottomNav — a marker stub so we can confirm it's still in the tree (CSS, not JS,
// hides it via body.deck-custom, mirroring the fileDrop test's "assert the class the CSS keys on" approach).
vi.mock('../src/components/BottomNav.js', () => ({
  BottomNav: () => <nav className="bottom-nav" data-testid="bottom-nav" />,
}));
// The note editor is a lazy chunk — stub it so the /note route resolves without mounting ProseMirror.
vi.mock('../src/routes/NoteRoute.js', () => ({ NoteRoute: () => <div data-testid="note-route">note</div> }));

import { AuthedShell } from '../src/App.js';
import { useAuthStore } from '../src/auth/store.js';
import { useNotebookStore } from '../src/lib/notebookStore.js';
import { useCustomKeyboardStore } from '../src/lib/useCustomKeyboard.js';

function seed(customKeyboard: boolean) {
  useAuthStore.setState({ sessionState: 'active' } as Parameters<typeof useAuthStore.setState>[0]);
  useNotebookStore.setState({ _ready: true, currentNotebookId: null });
  useCustomKeyboardStore.setState({ enabled: customKeyboard, _loaded: true });
}

function mountShell(route: string) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <AuthedShell />
    </MemoryRouter>,
  );
}

const deck = () => document.querySelector('.deck');
const navAction = (label: string) =>
  document.querySelector(`.deck-nav__action[aria-label="${label}"]`);

beforeEach(() => {
  global.fetch = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })) as typeof fetch;
});
afterEach(() => {
  cleanup();
  document.body.classList.remove('deck-custom', 'deck-suppressed');
  vi.restoreAllMocks();
});

describe('Deck presence is touch-first, not custom-keyboard-setting driven', () => {
  it('setting OFF + browsing: the Deck nav loadout renders + body.deck-custom (legacy BottomNav hidden)', async () => {
    seed(false);
    mountShell('/');
    await waitFor(() => expect(deck()).not.toBeNull());
    // The nav loadout — New + Search present (browsing controls that replace the standalone BottomNav).
    expect(document.querySelector('[data-deck-context="navigation"]')).not.toBeNull();
    expect(navAction('New note')).not.toBeNull();
    expect(navAction('Search')).not.toBeNull();
    // body.deck-custom is the mechanism the stylesheet keys on to hide `.bottom-nav` (jsdom applies no CSS,
    // so — like the fileDrop test — we assert the class, not computed visibility). The BottomNav is still
    // mounted (present) but CSS-suppressed by this class.
    expect(document.body.classList.contains('deck-custom')).toBe(true);
    expect(document.querySelector('[data-testid="bottom-nav"]')).not.toBeNull();
    // Browsing is not the note route → not suppressed.
    expect(document.body.classList.contains('deck-suppressed')).toBe(false);
  });

  it('setting ON + browsing: unchanged — Deck present + body.deck-custom', async () => {
    seed(true);
    mountShell('/');
    await waitFor(() => expect(deck()).not.toBeNull());
    expect(navAction('New note')).not.toBeNull();
    expect(document.body.classList.contains('deck-custom')).toBe(true);
    expect(document.body.classList.contains('deck-suppressed')).toBe(false);
  });
});

describe('Deck suppressed on the native-mode note route (wrinkle)', () => {
  it('setting OFF + note open: body.deck-suppressed set, but the Deck host stays MOUNTED', async () => {
    seed(false);
    mountShell('/note/n1');
    // The suppression class is applied on the note route in native mode…
    await waitFor(() => expect(document.body.classList.contains('deck-suppressed')).toBe(true));
    // …while deck-custom stays on (touch-first) and the Deck remains in the tree (hidden by CSS, not unmounted).
    expect(document.body.classList.contains('deck-custom')).toBe(true);
    expect(deck()).not.toBeNull();
  });

  it('setting ON + note open: NOT suppressed (the keypad owns the bottom)', async () => {
    seed(true);
    mountShell('/note/n2');
    await waitFor(() => expect(document.querySelector('[data-testid="note-route"]')).not.toBeNull());
    expect(document.body.classList.contains('deck-suppressed')).toBe(false);
    expect(document.body.classList.contains('deck-custom')).toBe(true);
  });
});
