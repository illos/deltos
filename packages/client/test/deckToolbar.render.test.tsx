/**
 * Context-aware Deck (Jim's correction of the native-mode top bar): while a NOTE is open in NATIVE mode
 * (touch-first device, native keyboard — custom-keyboard setting OFF) the Deck's TOP bar carries the editor
 * TOOLBAR (the MobileEditorBar controls), NOT the site-navigation loadout — nav is a browsing-only context.
 * Mounts the REAL ProseMirrorEditor inside the REAL DeckHostProvider/Deck and proves the swap end-to-end
 * (ui-features-need-rendered-ui-gate — a real-DOM assertion, not a class check):
 *
 *  - the Deck renders under the fixed 'toolbar' context, containing MobileEditorBar's group toggles +
 *    undo/redo (the '--deck' variant), and NONE of the nav loadout actions (New note / Search / Upload);
 *  - NO bottom `.editor__mbar` renders (its content moved into the Deck top bar);
 *  - the bottom `.editor__mbar` DOES still render in the Deck-less case (a hardware-keyboard narrow window:
 *    not desktop, not touch-first) — the only home left for the bottom instance.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { BlockBody } from '@deltos/shared';

// Modality is mocked so a single jsdom run can exercise both native-touch and hardware-keyboard-narrow.
// Defaults mirror jsdom (touch-first true, desktop false) → native mode with the setting off.
let mockTouchPrimary = true;
let mockIsDesktop = false;
vi.mock('../src/lib/useTouchPrimary.js', () => ({ useTouchPrimary: () => mockTouchPrimary }));
vi.mock('../src/lib/useIsDesktop.js', () => ({ useIsDesktop: () => mockIsDesktop }));

import { ProseMirrorEditor } from '../src/editor/ProseMirrorEditor.js';
import { DeckHostProvider } from '../src/components/DeckHost.js';
import { useCustomKeyboardStore } from '../src/lib/useCustomKeyboard.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
beforeEach(() => {
  mockTouchPrimary = true;
  mockIsDesktop = false;
  // NATIVE mode: custom-keyboard setting OFF (and _loaded so the hook doesn't re-hydrate over it).
  useCustomKeyboardStore.setState({ enabled: false, _loaded: true });
  global.fetch = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })) as typeof fetch;
});

const emptyBody = [] as BlockBody;
const renderEditor = (deckEnabled: boolean) =>
  render(
    <MemoryRouter>
      <DeckHostProvider enabled={deckEnabled}>
        <ProseMirrorEditor noteId="n1" initialTitle="T" initialBody={emptyBody} onChange={() => {}} autoFocus />
      </DeckHostProvider>
    </MemoryRouter>,
  );

const deck = () => document.querySelector('.deck');

describe('Native-mode Deck top bar carries the EDITOR TOOLBAR while a note is open (not the nav loadout)', () => {
  it('publishes the toolbar loadout: Deck context=toolbar, MobileEditorBar controls INSIDE .deck, no nav', async () => {
    renderEditor(true);
    // The editor mounts and publishes its native-mode toolbar loadout → the Deck flips to context 'toolbar'.
    await waitFor(() => expect(deck()?.getAttribute('data-deck-context')).toBe('toolbar'));
    const d = deck() as HTMLElement;
    // The MobileEditorBar controls ride the Deck (compact '--deck' variant): group toggles + undo/redo.
    expect(d.querySelector('.editor__mbar--deck')).not.toBeNull();
    expect(d.querySelector('button[aria-label="Format"]')).not.toBeNull();
    expect(d.querySelector('button[aria-label="Undo"]')).not.toBeNull();
    expect(d.querySelector('button[aria-label="Redo"]')).not.toBeNull();
    // The site-navigation loadout is NOT shown while editing (browsing context only).
    expect(document.querySelector('.deck-nav')).toBeNull();
    for (const nav of ['New note', 'Search', 'Upload file']) {
      expect(document.querySelector(`[aria-label="${nav}"]`), nav).toBeNull();
    }
  });

  it('renders NO bottom .editor__mbar in native mode — the toolbar lives only in the Deck', async () => {
    renderEditor(true);
    await waitFor(() => expect(deck()?.getAttribute('data-deck-context')).toBe('toolbar'));
    // The ONLY MobileEditorBar in the tree is the Deck's ('--deck' variant); no bottom (non-deck) instance.
    expect(document.querySelector('.editor__mbar:not(.editor__mbar--deck)')).toBeNull();
    expect(deck()?.querySelector('.editor__mbar--deck')).not.toBeNull();
  });
});

describe('Deck-less hardware-keyboard narrow window keeps the BOTTOM MobileEditorBar', () => {
  it('not desktop + not touch-first + native keyboard: bottom bar renders, no Deck top-bar toolbar', async () => {
    mockTouchPrimary = false; // no Deck present (App gates the Deck on touch-first)
    mockIsDesktop = false;
    renderEditor(false); // mirror App: DeckHostProvider enabled=false when not touch-first
    // The grouped contextual bar rides the bottom of the sub-screen (its only remaining home).
    await waitFor(() => expect(document.querySelector('.editor__mbar')).not.toBeNull());
    const bar = document.querySelector('.editor__mbar') as HTMLElement;
    expect(bar.classList.contains('editor__mbar--deck')).toBe(false); // the bottom variant, not the deck one
    expect(bar.querySelector('button[aria-label="Format"]')).not.toBeNull();
    expect(deck()).toBeNull(); // no Deck at all
  });
});
