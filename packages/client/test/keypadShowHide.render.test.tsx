/**
 * #69 C-manual — keypad show/hide. Two halves:
 *  - KeypadLoadout (deck core): the collapsible keypad layer + the persistent base region that carries the
 *    show/hide toggle. Tap = flip the keypad; long-press = LOCK (suspend auto). Controlled by the host.
 *  - Editor integration: the editor owns the state — keypad shown by default, manual hide collapses it
 *    (note reclaims height), auto-show on re-focus, and LOCK suspends auto-show.
 *
 * Swipe-up auto-hide is a later slice (deferred) — not covered here.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { BlockBody } from '@deltos/shared';
import { KeypadLoadout } from '../src/deck/index.js';
import type { KeyActions } from '../src/deck/index.js';
import { db } from '../src/db/schema.js';
import { writeCustomKeyboard } from '../src/db/kbPointer.js';
import { useCustomKeyboardStore } from '../src/lib/useCustomKeyboard.js';
import { ProseMirrorEditor } from '../src/editor/ProseMirrorEditor.js';
import { DeckHostProvider } from '../src/components/DeckHost.js';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

const NOOP: KeyActions = { insert: () => {}, backspace: () => {}, enter: () => {} };
const toggle = () => document.querySelector('.deck-kbd-toggle') as HTMLButtonElement;
const tapToggle = () => { fireEvent.pointerDown(toggle()); fireEvent.pointerUp(toggle()); };

describe('KeypadLoadout — collapsible keypad + persistent base region', () => {
  const props = { actions: NOOP, onToggleKeypad: () => {}, onToggleLock: () => {} };

  it('keypad SHOWN: keypad above a base region carrying the toggle (aria Hide, pressed)', () => {
    render(<KeypadLoadout {...props} keypadShown locked={false} />);
    expect(document.querySelector('.keypad')).not.toBeNull();
    expect(document.querySelector('.keypad-loadout__base')).not.toBeNull();
    expect(toggle().getAttribute('aria-label')).toBe('Hide keyboard');
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
  });

  it('keypad HIDDEN: keypad gone, the base region + toggle persist as the slim bar (aria Show)', () => {
    render(<KeypadLoadout {...props} keypadShown={false} locked={false} />);
    expect(document.querySelector('.keypad')).toBeNull();
    expect(document.querySelector('.keypad-loadout__base')).not.toBeNull();
    expect(toggle().getAttribute('aria-label')).toBe('Show keyboard');
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
  });

  it('TAP (quick press/release) toggles the keypad, NOT the lock', () => {
    const onToggleKeypad = vi.fn();
    const onToggleLock = vi.fn();
    render(<KeypadLoadout actions={NOOP} keypadShown locked={false} onToggleKeypad={onToggleKeypad} onToggleLock={onToggleLock} />);
    tapToggle();
    expect(onToggleKeypad).toHaveBeenCalledTimes(1);
    expect(onToggleLock).not.toHaveBeenCalled();
  });

  it('LONG-PRESS locks; the trailing release does NOT also toggle the keypad', () => {
    vi.useFakeTimers();
    const onToggleKeypad = vi.fn();
    const onToggleLock = vi.fn();
    render(<KeypadLoadout actions={NOOP} keypadShown locked={false} onToggleKeypad={onToggleKeypad} onToggleLock={onToggleLock} />);
    fireEvent.pointerDown(toggle());
    act(() => { vi.advanceTimersByTime(460); });
    expect(onToggleLock).toHaveBeenCalledTimes(1);
    fireEvent.pointerUp(toggle());
    expect(onToggleKeypad).not.toHaveBeenCalled();
  });

  it('LOCKED: the toggle shows the lock indicator + "(locked)" in its label', () => {
    render(<KeypadLoadout {...props} keypadShown locked />);
    expect(toggle().className).toContain('is-locked');
    expect(toggle().getAttribute('aria-label')).toContain('(locked)');
  });
});

describe('keypad show/hide — editor integration', () => {
  beforeEach(async () => {
    await db.deviceState.clear();
    useCustomKeyboardStore.setState({ enabled: false, _loaded: false });
    global.fetch = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })) as typeof fetch;
    await writeCustomKeyboard(true); // custom-keyboard mode ON
  });

  const emptyBody = [] as BlockBody;
  const pmEl = () => document.querySelector('.editor__pm .ProseMirror') as HTMLElement | null;
  const renderEditor = () =>
    render(
      <MemoryRouter>
        <DeckHostProvider enabled>
          <ProseMirrorEditor noteId="n1" initialTitle="T" initialBody={emptyBody} onChange={() => {}} autoFocus />
        </DeckHostProvider>
      </MemoryRouter>,
    );

  it('keypad shows by default; manual hide collapses it; the toggle persists + note reclaims height', async () => {
    renderEditor();
    await waitFor(() => expect(document.querySelector('.keypad')).not.toBeNull());
    tapToggle(); // hide
    expect(document.querySelector('.keypad')).toBeNull();
    expect(toggle()).not.toBeNull(); // persistent base region keeps the show button
    expect(document.querySelector('.editor__pm--kb-collapsed')).not.toBeNull(); // shorter caret clearance
  });

  it('AUTO-SHOW: re-focusing the note re-shows a manually-hidden keypad', async () => {
    renderEditor();
    await waitFor(() => expect(document.querySelector('.keypad')).not.toBeNull());
    tapToggle(); // hide
    expect(document.querySelector('.keypad')).toBeNull();
    act(() => { fireEvent.focus(pmEl()!); }); // caret returns to the note
    expect(document.querySelector('.keypad')).not.toBeNull();
  });

  it('LOCK suspends auto-show: a locked-hidden keypad stays hidden on re-focus', async () => {
    renderEditor();
    await waitFor(() => expect(document.querySelector('.keypad')).not.toBeNull());
    tapToggle(); // hide
    // lock via long-press
    vi.useFakeTimers();
    fireEvent.pointerDown(toggle());
    act(() => { vi.advanceTimersByTime(460); });
    fireEvent.pointerUp(toggle());
    vi.useRealTimers();
    expect(toggle().className).toContain('is-locked');
    act(() => { fireEvent.focus(pmEl()!); }); // auto suspended → must NOT re-show
    expect(document.querySelector('.keypad')).toBeNull();
  });
});
