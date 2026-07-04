import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { KeypadLoadout } from './KeypadLoadout.js';
import type { KeyActions } from '../types.js';

afterEach(cleanup);

// Minimal KeyActions stub — the toggle button under test doesn't drive any of these; the Keypad layer only
// mounts when keypadShown, and its keys aren't exercised here.
const noopActions = new Proxy({}, { get: () => () => {} }) as unknown as KeyActions;

function renderLoadout(props: Partial<Parameters<typeof KeypadLoadout>[0]> = {}) {
  const onToggleKeypad = vi.fn();
  const onToggleLock = vi.fn();
  const utils = render(
    <KeypadLoadout
      actions={noopActions}
      keypadShown={props.keypadShown ?? false}
      locked={props.locked ?? false}
      onToggleKeypad={onToggleKeypad}
      onToggleLock={onToggleLock}
      {...props}
    />,
  );
  const button = utils.container.querySelector('.deck-kbd-toggle') as HTMLButtonElement;
  return { ...utils, button, onToggleKeypad, onToggleLock };
}

describe('KeypadLoadout show/hide toggle', () => {
  it('the button keeps a constant, fixed-geometry box across shown / hidden / locked (icons, not glyph text)', () => {
    // The BUG this guards: text chevrons (⌄/⌃) have different widths, so the button grew/shrank per toggle.
    // Now every state renders exactly ONE indicator icon in the same fixed-size slot → constant geometry.
    for (const state of [
      { keypadShown: false, locked: false },
      { keypadShown: true, locked: false },
      { keypadShown: false, locked: true },
      { keypadShown: true, locked: true },
    ]) {
      const { button } = renderLoadout(state);
      // Same button class (fixed CSS width/height as the belt) + exactly one indicator slot, one icon in it.
      expect(button.classList.contains('deck-kbd-toggle')).toBe(true);
      const slot = button.querySelector('.deck-kbd-toggle__ind')!;
      expect(slot).not.toBeNull();
      const icons = slot.querySelectorAll('svg.deck-kbd-toggle__ind-icon');
      expect(icons.length, JSON.stringify(state)).toBe(1);
      const svg = icons[0]!;
      // Identical geometry: same 24-grid viewBox + same rendered 16px box in every state.
      expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
      expect(svg.getAttribute('width')).toBe('16');
      expect(svg.getAttribute('height')).toBe('16');
      // No raw glyph text in the button (the whole point of the fix).
      expect(button.textContent).toBe('');
      cleanup();
    }
  });

  it('shows a direction chevron when unlocked (down = hide when shown, up = show when hidden)', () => {
    const shown = renderLoadout({ keypadShown: true, locked: false });
    expect(shown.button.querySelector('[data-ind="down"]')).not.toBeNull();
    expect(shown.button.querySelector('[data-ind="lock"]')).toBeNull();
    cleanup();

    const hidden = renderLoadout({ keypadShown: false, locked: false });
    expect(hidden.button.querySelector('[data-ind="up"]')).not.toBeNull();
  });

  it('shows the Lock icon (no chevron) when locked — the mode is identifiable at a glance', () => {
    const { button } = renderLoadout({ keypadShown: true, locked: true });
    expect(button.querySelector('[data-ind="lock"]')).not.toBeNull();
    expect(button.querySelector('[data-ind="down"]')).toBeNull();
    expect(button.querySelector('[data-ind="up"]')).toBeNull();
    expect(button.getAttribute('data-locked')).toBe('true');
    expect(button.getAttribute('aria-label')).toContain('(locked)');
  });

  it('a short tap toggles the keypad and does NOT lock', () => {
    const { button, onToggleKeypad, onToggleLock } = renderLoadout({ keypadShown: false });
    fireEvent.pointerDown(button);
    fireEvent.pointerUp(button);
    expect(onToggleKeypad).toHaveBeenCalledTimes(1);
    expect(onToggleLock).not.toHaveBeenCalled();
  });

  it('a long-press fires the lock, and the tap on release is SUPPRESSED', () => {
    vi.useFakeTimers();
    try {
      const { button, onToggleKeypad, onToggleLock } = renderLoadout({ keypadShown: false });
      fireEvent.pointerDown(button);
      // Cross the long-press threshold (300ms, the house hold-to-enter-a-mode convention).
      act(() => { vi.advanceTimersByTime(300); });
      expect(onToggleLock).toHaveBeenCalledTimes(1);
      // Releasing after the long-press must NOT also toggle the keypad.
      fireEvent.pointerUp(button);
      expect(onToggleKeypad).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('releasing BEFORE the threshold is a tap, not a lock', () => {
    vi.useFakeTimers();
    try {
      const { button, onToggleKeypad, onToggleLock } = renderLoadout({ keypadShown: true });
      fireEvent.pointerDown(button);
      act(() => { vi.advanceTimersByTime(200); }); // < 300ms threshold
      fireEvent.pointerUp(button);
      expect(onToggleLock).not.toHaveBeenCalled();
      expect(onToggleKeypad).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tapping WHILE locked toggles the keypad and leaves the lock engaged (tap drives; long-press decides auto)', () => {
    // Controlled component: locked stays true (parent owns it); a tap only calls onToggleKeypad, never
    // onToggleLock — so the lock is NOT cleared by a manual tap. Unlock is long-press only.
    const { button, onToggleKeypad, onToggleLock } = renderLoadout({ keypadShown: true, locked: true });
    fireEvent.pointerDown(button);
    fireEvent.pointerUp(button);
    expect(onToggleKeypad).toHaveBeenCalledTimes(1);
    expect(onToggleLock).not.toHaveBeenCalled();
  });

  it('pointerleave / cancel aborts a pending long-press (no lock, no toggle)', () => {
    vi.useFakeTimers();
    try {
      const { button, onToggleKeypad, onToggleLock } = renderLoadout();
      fireEvent.pointerDown(button);
      fireEvent.pointerLeave(button);
      act(() => { vi.advanceTimersByTime(500); });
      expect(onToggleLock).not.toHaveBeenCalled();
      expect(onToggleKeypad).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the arming cue class while pressing, and clears it once the lock fires', () => {
    vi.useFakeTimers();
    try {
      const { button } = renderLoadout();
      fireEvent.pointerDown(button);
      expect(button.classList.contains('deck-kbd-toggle--arming')).toBe(true);
      act(() => { vi.advanceTimersByTime(300); }); // lock fires → snap-back at threshold
      expect(button.classList.contains('deck-kbd-toggle--arming')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
