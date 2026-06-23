/**
 * #69 Phase 1 slice 2 — the opt-in toggle + real-editor integration. Default OFF: the editor behaves
 * exactly as today (native keyboard, MobileEditorBar, no inputmode). ON: the editor suppresses the
 * native keyboard (inputmode=none) and shows the context-driven KeyboardSurface instead of the bar.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor, act, renderHook, fireEvent } from '@testing-library/react';
import type { BlockBody } from '@deltos/shared';
import { db } from '../src/db/schema.js';
import { readCustomKeyboard, writeCustomKeyboard } from '../src/db/kbPointer.js';
import { useCustomKeyboard } from '../src/lib/useCustomKeyboard.js';
import { ProseMirrorEditor } from '../src/editor/ProseMirrorEditor.js';

beforeEach(async () => {
  await db.deviceState.clear();
  global.fetch = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })) as typeof fetch;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const pmEl = () => document.querySelector('.editor__pm .ProseMirror') as HTMLElement | null;
const emptyBody = [] as BlockBody;

describe('kbPointer + useCustomKeyboard — device-local opt-in', () => {
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
    expect(await readCustomKeyboard()).toBe(false);            // persisted
  });
});

describe('editor integration (mobile)', () => {
  it('OFF (default): native editor + MobileEditorBar, no inputmode, no custom keyboard', async () => {
    render(<ProseMirrorEditor noteId="n1" initialTitle="T" initialBody={emptyBody} onChange={() => {}} autoFocus />);
    await waitFor(() => expect(pmEl()).not.toBeNull());
    expect(document.querySelector('button[aria-label="Undo"]')).not.toBeNull(); // MobileEditorBar present
    expect(pmEl()!.getAttribute('inputmode')).not.toBe('none');
    expect(document.querySelector('.kb__grid')).toBeNull();
  });

  it('ON: inputmode=none + KeyboardSurface keypad, MobileEditorBar gone, nav suppressed', async () => {
    await writeCustomKeyboard(true);
    const { unmount } = render(<ProseMirrorEditor noteId="n2" initialTitle="T" initialBody={emptyBody} onChange={() => {}} autoFocus />);
    // async read → custom on → view recreated with inputmode=none + the keyboard shown (focused)
    await waitFor(() => expect(pmEl()?.getAttribute('inputmode')).toBe('none'));
    await waitFor(() => expect(document.querySelector('.kb__grid')).not.toBeNull());
    expect(document.querySelector('.kb__key[aria-label="Q"]')).not.toBeNull();
    expect(document.querySelector('button[aria-label="Undo"]')).toBeNull(); // bar replaced by the keyboard
    // the universal bottom nav is suppressed while the keyboard owns the bottom slot
    await waitFor(() => expect(document.body.classList.contains('kb-active')).toBe(true));
    unmount();
    expect(document.body.classList.contains('kb-active')).toBe(false); // restored on leave
  });

  it('a blur that immediately refocuses (tap-to-reposition) does NOT hide the keyboard (#69 regression)', async () => {
    await writeCustomKeyboard(true);
    render(<ProseMirrorEditor noteId="n3" initialTitle="T" initialBody={emptyBody} onChange={() => {}} autoFocus />);
    await waitFor(() => expect(document.querySelector('.kb__grid')).not.toBeNull());

    const ed = pmEl()!;
    fireEvent.blur(ed);   // schedules the debounced hide
    fireEvent.focus(ed);  // refocus within the window → cancels it
    // The keyboard never tore down; the nav stays suppressed.
    expect(document.querySelector('.kb__grid')).not.toBeNull();
    expect(document.body.classList.contains('kb-active')).toBe(true);
  });
});
