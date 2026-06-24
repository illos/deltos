// @vitest-environment jsdom
/**
 * #69 §7 / #81 — keypad show/hide. useKeypadSwipe now does ONLY the caret-tap → SHOW (the broken
 * pointer-flick hide was removed in #81). The hide is scroll-driven: isFastUpwardScroll is the pure
 * velocity/direction decision (fast UPWARD scroll → hide; slow / downward → no).
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useKeypadSwipe, isFastUpwardScroll, HIDE_SCROLL_VELOCITY_PX_PER_MS } from '../src/lib/useKeypadSwipe.js';

const ev = (clientX: number, clientY: number, timeStamp: number, pointerId = 1) =>
  ({ clientX, clientY, timeStamp, pointerId }) as unknown as ReactPointerEvent;

function setup(enabled = true) {
  const onTap = vi.fn();
  const { result } = renderHook(() => useKeypadSwipe({ enabled, onTap }));
  return { h: result.current, onTap };
}

describe('useKeypadSwipe — caret-tap → show', () => {
  it('a near-stationary tap → onTap', () => {
    const { h, onTap } = setup();
    h.onPointerDown(ev(100, 300, 0));
    h.onPointerUp(ev(103, 296, 40)); // moved ~5px
    expect(onTap).toHaveBeenCalledTimes(1);
  });

  it('a drag/scroll (movement beyond the tap threshold) → NOT a tap (no-op; hide is scroll-driven now)', () => {
    const { h, onTap } = setup();
    h.onPointerDown(ev(100, 400, 0));
    h.onPointerUp(ev(105, 280, 100)); // a 120px move — used to be a hide-flick; now just not-a-tap
    expect(onTap).not.toHaveBeenCalled();
  });

  it('pointercancel aborts → no tap', () => {
    const { h, onTap } = setup();
    h.onPointerDown(ev(100, 300, 0));
    h.onPointerCancel();
    h.onPointerUp(ev(101, 300, 30));
    expect(onTap).not.toHaveBeenCalled();
  });

  it('disabled → no tap', () => {
    const { h, onTap } = setup(false);
    h.onPointerDown(ev(100, 300, 0));
    h.onPointerUp(ev(101, 300, 30));
    expect(onTap).not.toHaveBeenCalled();
  });

  it('ignores a pointerup from a different pointerId', () => {
    const { h, onTap } = setup();
    h.onPointerDown(ev(100, 300, 0, 1));
    h.onPointerUp(ev(101, 300, 30, 2));
    expect(onTap).not.toHaveBeenCalled();
  });
});

describe('isFastUpwardScroll — the hide decision (#81)', () => {
  it('fast UPWARD scroll (scrollTop increasing, velocity ≥ threshold) → hide', () => {
    expect(isFastUpwardScroll(120, 100)).toBe(true); // 1.2 px/ms
    expect(isFastUpwardScroll(60, 100)).toBe(true);   // 0.6 px/ms = threshold
  });
  it('slow upward scroll (below threshold) → no hide', () => {
    expect(isFastUpwardScroll(30, 100)).toBe(false); // 0.3 px/ms
    expect(isFastUpwardScroll(120, 600)).toBe(false); // 0.2 px/ms
  });
  it('DOWNWARD scroll (scrollTop decreasing) → no hide, however fast', () => {
    expect(isFastUpwardScroll(-200, 100)).toBe(false);
  });
  it('zero / negative elapsed time → no hide (guards divide-by-zero)', () => {
    expect(isFastUpwardScroll(120, 0)).toBe(false);
    expect(isFastUpwardScroll(120, -10)).toBe(false);
  });
  it('honours a custom threshold', () => {
    expect(isFastUpwardScroll(100, 100, 1.5)).toBe(false); // 1.0 < 1.5
    expect(isFastUpwardScroll(200, 100, 1.5)).toBe(true);  // 2.0 ≥ 1.5
  });
  it('exports a sane default threshold', () => {
    expect(HIDE_SCROLL_VELOCITY_PX_PER_MS).toBeGreaterThan(0);
  });
});
