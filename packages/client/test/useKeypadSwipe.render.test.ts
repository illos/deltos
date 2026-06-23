// @vitest-environment jsdom
/**
 * #69 §7 — useKeypadSwipe: the note-body gesture pair. Tap (caret placement) → show; fast+large upward
 * flick → hide; everything else (slow drag, scroll, horizontal, downward, cancel, disabled) → no-op.
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useKeypadSwipe } from '../src/lib/useKeypadSwipe.js';

const ev = (clientX: number, clientY: number, timeStamp: number, pointerId = 1) =>
  ({ clientX, clientY, timeStamp, pointerId }) as unknown as ReactPointerEvent;

function setup(enabled = true) {
  const onTap = vi.fn();
  const onSwipeUp = vi.fn();
  const { result } = renderHook(() => useKeypadSwipe({ enabled, onTap, onSwipeUp }));
  return { h: result.current, onTap, onSwipeUp };
}

describe('useKeypadSwipe', () => {
  it('a near-stationary tap → onTap (show), not onSwipeUp', () => {
    const { h, onTap, onSwipeUp } = setup();
    h.onPointerDown(ev(100, 300, 0));
    h.onPointerUp(ev(103, 296, 40)); // moved ~5px
    expect(onTap).toHaveBeenCalledTimes(1);
    expect(onSwipeUp).not.toHaveBeenCalled();
  });

  it('a fast + large upward flick → onSwipeUp (hide), not onTap', () => {
    const { h, onTap, onSwipeUp } = setup();
    h.onPointerDown(ev(100, 400, 0));
    h.onPointerUp(ev(105, 280, 100)); // up 120px in 100ms = 1.2px/ms
    expect(onSwipeUp).toHaveBeenCalledTimes(1);
    expect(onTap).not.toHaveBeenCalled();
  });

  it('a slow large upward drag (low velocity) → neither (looks like a scroll)', () => {
    const { h, onTap, onSwipeUp } = setup();
    h.onPointerDown(ev(100, 400, 0));
    h.onPointerUp(ev(105, 280, 600)); // up 120px in 600ms = 0.2px/ms < 0.6
    expect(onTap).not.toHaveBeenCalled();
    expect(onSwipeUp).not.toHaveBeenCalled();
  });

  it('a fast but horizontal-dominant drag → neither', () => {
    const { h, onSwipeUp } = setup();
    h.onPointerDown(ev(100, 400, 0));
    h.onPointerUp(ev(300, 320, 100)); // up 80px but dx 200px → horizontal wins
    expect(onSwipeUp).not.toHaveBeenCalled();
  });

  it('a fast DOWNWARD flick → neither (only upward hides)', () => {
    const { h, onTap, onSwipeUp } = setup();
    h.onPointerDown(ev(100, 200, 0));
    h.onPointerUp(ev(102, 360, 100)); // downward
    expect(onTap).not.toHaveBeenCalled();
    expect(onSwipeUp).not.toHaveBeenCalled();
  });

  it('pointercancel (scroll taken over) aborts the gesture → neither', () => {
    const { h, onTap, onSwipeUp } = setup();
    h.onPointerDown(ev(100, 400, 0));
    h.onPointerCancel();
    h.onPointerUp(ev(105, 280, 100)); // would-be flick, but start was cleared
    expect(onTap).not.toHaveBeenCalled();
    expect(onSwipeUp).not.toHaveBeenCalled();
  });

  it('disabled → no gesture is recognized', () => {
    const { h, onTap, onSwipeUp } = setup(false);
    h.onPointerDown(ev(100, 400, 0));
    h.onPointerUp(ev(105, 280, 100));
    expect(onTap).not.toHaveBeenCalled();
    expect(onSwipeUp).not.toHaveBeenCalled();
  });

  it('ignores a pointerup from a different pointerId', () => {
    const { h, onTap } = setup();
    h.onPointerDown(ev(100, 300, 0, 1));
    h.onPointerUp(ev(101, 300, 30, 2)); // different finger
    expect(onTap).not.toHaveBeenCalled();
  });
});
