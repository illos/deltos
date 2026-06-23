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

// Slice B: the Deck mounts at the shell via DeckHostProvider (the editor PUBLISHES its keypad to it,
// no longer renders it directly). The keypad therefore only appears when the editor is inside the host.
const inShell = (ui: ReactNode) =>
  render(<MemoryRouter><DeckHostProvider enabled>{ui}</DeckHostProvider></MemoryRouter>);

beforeEach(async () => {
  await db.deviceState.clear();
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
  it('OFF (default): native editor + MobileEditorBar, no inputmode, no custom keyboard', async () => {
    render(<ProseMirrorEditor noteId="n1" initialTitle="T" initialBody={emptyBody} onChange={() => {}} autoFocus />);
    await waitFor(() => expect(pmEl()).not.toBeNull());
    expect(document.querySelector('button[aria-label="Undo"]')).not.toBeNull(); // MobileEditorBar present
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

  it('the inert 123 key is a real (non-disabled) button so it preserves focus, not a dismisser', async () => {
    await writeCustomKeyboard(true);
    inShell(<ProseMirrorEditor noteId="n4" initialTitle="T" initialBody={emptyBody} onChange={() => {}} autoFocus />);
    await waitFor(() => expect(document.querySelector('.keypad__key--mode')).not.toBeNull());
    const mode = document.querySelector('.keypad__key--mode') as HTMLButtonElement;
    expect(mode.disabled).toBe(false);                 // NOT disabled (disabled buttons swallow no events)
    expect(mode.className).toContain('keypad__key--inert'); // greyed via class
  });
});
