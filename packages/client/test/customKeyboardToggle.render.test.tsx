/**
 * #69 Phase 1 slice 2 — the opt-in toggle + real-editor integration. Default OFF: the editor behaves
 * exactly as today (native keyboard, MobileEditorBar, no inputmode). ON: the editor suppresses the
 * native keyboard (inputmode=none) and PUBLISHES its keypad to the shell-level Deck (slice B —
 * DeckHostProvider), driven by the toggle (editor mounted), NOT by editor focus, so incidental
 * tap-blurs / the backplane can't tear it down. (Deck mount + nav loadout: deckNav.render.test.)
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor, act, renderHook, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { BlockBody } from '@deltos/shared';
import { db } from '../src/db/schema.js';
import { readCustomKeyboard, writeCustomKeyboard } from '../src/db/kbPointer.js';
import { useCustomKeyboard, useCustomKeyboardStore } from '../src/lib/useCustomKeyboard.js';
import { ProseMirrorEditor } from '../src/editor/ProseMirrorEditor.js';
import { DeckHostProvider } from '../src/components/DeckHost.js';

// The custom keyboard is installed-PWA-only (useKeypadMode composes useInstalledPwa). Mock it with a mutable
// flag defaulting TRUE so every existing keypad test keeps its "keypad reachable" assumption; the new
// browser-tab case flips it false to prove the keypad is withheld outside the installed PWA. (Vitest allows
// factory references to variables prefixed `mock`.)
let mockInstalledPwa = true;
vi.mock('../src/lib/useInstalledPwa.js', () => ({ useInstalledPwa: () => mockInstalledPwa }));

// Slice B: the Deck mounts at the shell via DeckHostProvider (the editor PUBLISHES its keypad to it,
// no longer renders it directly). The keypad therefore only appears when the editor is inside the host.
const inShell = (ui: ReactNode) =>
  render(<MemoryRouter><DeckHostProvider enabled>{ui}</DeckHostProvider></MemoryRouter>);

beforeEach(async () => {
  await db.deviceState.clear();
  mockInstalledPwa = true; // installed-PWA by default (matches jsdom; keeps existing keypad tests reachable)
  useCustomKeyboardStore.setState({ enabled: false, _loaded: false }); // module singleton — reset per test
  global.fetch = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })) as typeof fetch;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const pmEl = () => document.querySelector('.editor__pm .ProseMirror') as HTMLElement | null;
const emptyBody = [] as BlockBody;

describe('kbPointer + useCustomKeyboard — shared, device-local opt-in', () => {
  it('defaults OFF and persists a flip', async () => {
    expect(await readCustomKeyboard()).toBe(false);
    await writeCustomKeyboard(true);
    expect(await readCustomKeyboard()).toBe(true);
  });

  it('hook starts OFF, swaps to the persisted value, and writes on set', async () => {
    await writeCustomKeyboard(true);
    const { result } = renderHook(() => useCustomKeyboard());
    expect(result.current[0]).toBe(false);                    // render-before-data default
    await waitFor(() => expect(result.current[0]).toBe(true)); // swaps to persisted
    await act(async () => { result.current[1](false); });
    expect(result.current[0]).toBe(false);
    expect(await readCustomKeyboard()).toBe(false);           // persisted
  });
});

describe('editor integration (mobile)', () => {
  it('OFF (default): native editor + Deck top-bar toolbar, no inputmode, no custom keyboard', async () => {
    // Native mode on a touch-first device (jsdom default): the editor rides the native keyboard and publishes
    // its TOOLBAR to the shell-level Deck (context-aware Deck) — so it's mounted inShell. The toolbar (Undo)
    // renders in the Deck, NOT as a standalone bottom bar; there's no keypad and inputmode isn't none.
    inShell(<ProseMirrorEditor noteId="n1" initialTitle="T" initialBody={emptyBody} onChange={() => {}} autoFocus />);
    await waitFor(() => expect(pmEl()).not.toBeNull());
    await waitFor(() => expect(document.querySelector('.deck .editor__mbar--deck')).not.toBeNull()); // toolbar in the Deck
    expect(document.querySelector('.deck button[aria-label="Undo"]')).not.toBeNull();
    expect(pmEl()!.getAttribute('inputmode')).not.toBe('none');
    expect(document.querySelector('.keypad')).toBeNull();
  });

  it('ON: inputmode=none + Deck keypad (toggle-driven), MobileEditorBar gone', async () => {
    await writeCustomKeyboard(true);
    inShell(<ProseMirrorEditor noteId="n2" initialTitle="T" initialBody={emptyBody} onChange={() => {}} autoFocus />);
    // async read → custom on → view recreated with inputmode=none + the keyboard shown
    await waitFor(() => expect(pmEl()?.getAttribute('inputmode')).toBe('none'));
    await waitFor(() => expect(document.querySelector('.keypad')).not.toBeNull());
    expect(document.querySelector('.keypad__key[aria-label="Q"]')).not.toBeNull();
    // MobileEditorBar is replaced by the Deck. (Don't proxy on the Undo button — the Deck editor loadout
    // now has its own Undo in the selector row; assert the MobileEditorBar container itself is gone.)
    expect(document.querySelector('.editor__mbar')).toBeNull();
  });

  it('the keyboard is NOT focus-gated: a blur does not tear it down (#69 drop fix)', async () => {
    await writeCustomKeyboard(true);
    inShell(<ProseMirrorEditor noteId="n3" initialTitle="T" initialBody={emptyBody} onChange={() => {}} autoFocus />);
    await waitFor(() => expect(document.querySelector('.keypad')).not.toBeNull());
    fireEvent.blur(pmEl()!); // a backplane / near-miss tap blurs the editor — must NOT hide the keyboard
    expect(document.querySelector('.keypad')).not.toBeNull();
  });

  it('the 123 mode key is a real (non-disabled) button so it preserves focus, not a dismisser', async () => {
    await writeCustomKeyboard(true);
    inShell(<ProseMirrorEditor noteId="n4" initialTitle="T" initialBody={emptyBody} onChange={() => {}} autoFocus />);
    await waitFor(() => expect(document.querySelector('.keypad__key--mode')).not.toBeNull());
    const mode = document.querySelector('.keypad__key--mode') as HTMLButtonElement;
    expect(mode.disabled).toBe(false);                 // NOT disabled (disabled buttons swallow no events → blur the editor)
  });

  it('setting ON + touch-first but NOT an installed PWA (browser tab): native keyboard, no keypad', async () => {
    // The keypad is installed-PWA-only. Even with the toggle ON and a touch-first jsdom default, a plain
    // mobile browser tab (installedPwa=false) must ride the native keyboard — no inputmode=none, no keypad.
    mockInstalledPwa = false;
    await writeCustomKeyboard(true);
    inShell(<ProseMirrorEditor noteId="n5" initialTitle="T" initialBody={emptyBody} onChange={() => {}} autoFocus />);
    await waitFor(() => expect(pmEl()).not.toBeNull());
    expect(pmEl()!.getAttribute('inputmode')).not.toBe('none'); // native keyboard governs
    expect(document.querySelector('.keypad')).toBeNull();        // keypad withheld outside the installed PWA
  });
});
