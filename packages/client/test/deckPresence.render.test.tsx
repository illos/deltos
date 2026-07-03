/**
 * Deck presence is MODALITY-driven, not setting-driven (the custom-keyboard-toggle-no-longer-gates-the-Deck
 * refinement). Mounts the REAL AuthedShell (mobile / touch-first — useTouchPrimary's jsdom default is TRUE)
 * and proves:
 *
 *  - With the custom-keyboard setting OFF, the Deck host STILL renders its navigation loadout and
 *    body.deck-custom is applied (which is what hides the legacy standalone BottomNav) — the setting no
 *    longer makes the Deck vanish / the old BottomNav reappear (the reported regression).
 *  - With the setting ON, shell behavior is unchanged (Deck present + deck-custom).
 *  - NATIVE-MODE PLACEMENT is CONTEXT-aware (Jim): whenever the editor rides the OS keyboard (setting OFF,
 *    OR a plain mobile browser tab even with the setting ON) the Deck flips to a sticky TOP bar —
 *    body.deck-top — ONLY while a note is open (the note route), where the top escapes the keyboard/URL bar.
 *    While BROWSING (no note open) there is no keyboard, so deck-top is OFF and the Deck rides its default
 *    BOTTOM slot showing the nav loadout (restored pre-513026c browsing placement). In keypad mode
 *    (installed PWA + setting ON) there is NO deck-top on any screen — the Deck keeps the bottom slot.
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
// The keypad (and thus the Deck keeping the BOTTOM slot) is installed-PWA-only: App's useKeypadMode composes
// useInstalledPwa. Mock it with a mutable flag defaulting TRUE (matches jsdom) so the "setting ON → keypad
// mode → NO deck-top" case holds; the browser-tab case flips it false to prove the Deck rides the TOP
// (deck-top) there even with the setting ON. (Vitest allows factory refs to `mock`-prefixed vars.)
let mockInstalledPwa = true;
vi.mock('../src/lib/useInstalledPwa.js', () => ({ useInstalledPwa: () => mockInstalledPwa }));

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
  mockInstalledPwa = true; // installed-PWA by default (keypad reachable)
  global.fetch = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })) as typeof fetch;
});
afterEach(() => {
  cleanup();
  document.body.classList.remove('deck-custom', 'deck-top');
  vi.restoreAllMocks();
});

describe('Deck presence is touch-first, not custom-keyboard-setting driven', () => {
  it('setting OFF + browsing (native mode): the Deck nav loadout renders + body.deck-custom, NO deck-top (BOTTOM slot)', async () => {
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
    // BROWSING (no note open) → no keyboard to escape → the Deck rides its default BOTTOM slot, NOT the top
    // bar. deck-top is EDITING-only (note route). This is the restored pre-513026c browsing placement (Jim).
    expect(document.body.classList.contains('deck-top')).toBe(false);
  });

  it('setting ON + browsing (keypad mode): Deck present + body.deck-custom, NO deck-top (bottom Deck)', async () => {
    seed(true);
    mountShell('/');
    await waitFor(() => expect(deck()).not.toBeNull());
    expect(navAction('New note')).not.toBeNull();
    expect(document.body.classList.contains('deck-custom')).toBe(true);
    // Installed PWA + setting on = keypad mode → the Deck keeps the BOTTOM slot (no top bar).
    expect(document.body.classList.contains('deck-top')).toBe(false);
  });
});

describe('Native-mode Deck rides the top on the note route (body.deck-top)', () => {
  it('setting OFF + note open: body.deck-top set, Deck MOUNTED + visible, nav loadout present', async () => {
    seed(false);
    mountShell('/note/n1');
    // Native mode on the note route → the top-bar class is applied…
    await waitFor(() => expect(document.body.classList.contains('deck-top')).toBe(true));
    // …deck-custom stays on (touch-first) and the Deck stays in the tree — MOUNTED and visible (deck-top
    // repositions it to the top; it is NOT display:none'd the way the old deck-suppressed hid it).
    expect(document.body.classList.contains('deck-custom')).toBe(true);
    expect(deck()).not.toBeNull();
    // NoteRoute is STUBBED here (this is the shell-level class-wiring test), so no editor mounts to publish
    // a loadout → the Deck falls back to the navigation loadout. (With the REAL editor, native mode publishes
    // the editor TOOLBAR under the 'toolbar' context and the nav loadout is hidden — that context-aware swap
    // is covered end-to-end in deckToolbar.render.test.tsx; here we only assert the deck-top shell wiring.)
    expect(document.querySelector('[data-deck-context="navigation"]')).not.toBeNull();
    expect(navAction('New note')).not.toBeNull();
  });

  it('setting ON + note open (keypad mode): NO deck-top — the keypad owns the bottom', async () => {
    seed(true);
    mountShell('/note/n2');
    await waitFor(() => expect(document.querySelector('[data-testid="note-route"]')).not.toBeNull());
    expect(document.body.classList.contains('deck-top')).toBe(false);
    expect(document.body.classList.contains('deck-custom')).toBe(true);
  });

  it('setting ON but NOT an installed PWA (browser tab) + note open: deck-top set (native mode governs)', async () => {
    // The keypad is installed-PWA-only. In a plain mobile browser tab the setting has no effect — the editor
    // rides the native keyboard + its sticky MobileEditorBar, so the Deck rides the TOP on the note route
    // exactly as in native mode, even though the toggle is ON.
    mockInstalledPwa = false;
    seed(true);
    mountShell('/note/n3');
    await waitFor(() => expect(document.body.classList.contains('deck-top')).toBe(true));
    expect(document.body.classList.contains('deck-custom')).toBe(true); // still touch-first (Deck mounted)
  });
});
