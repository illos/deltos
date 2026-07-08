/**
 * SwipeRow rendered-UI gate (ui-features-need-rendered-ui-gate). Mounts the row and drives real Pointer
 * Events through useDragAxis to lock the notebook-organization rearrange:
 *   LEFT fling  → Delete   (the delete commit moved from the right side to the left)
 *   RIGHT fling → Pin      (pin replaced delete as the right-side fling)
 *   Copy stays a RIGHT tap; Move stays a LEFT tap (secondary options, not flings).
 *
 * NOTE: an on-device smoke of the actual swipe FEEL (geometry/threshold, fly-off animation) is still
 * required before deploy — jsdom can assert the wiring but not the touch feel.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { SwipeRow } from './SwipeRow.js';

// FAR = 200 in SwipeRow; a single move past ±FAR locks + flings. Secondary (Y) stays 0 so the X axis locks.
const FLING = 260;
const TAP_OPEN = 90; // > SNAP_OPEN (55), < FAR → snaps the tap seam open

function fg(container: HTMLElement) {
  return container.querySelector('.swipe-row__foreground') as HTMLElement;
}

/** A horizontal drag from x0 → x1 on the foreground (locks the X axis in useDragAxis). */
function dragX(el: HTMLElement, x0: number, x1: number) {
  fireEvent.pointerDown(el, { pointerId: 1, clientX: x0, clientY: 300 });
  fireEvent.pointerMove(el, { pointerId: 1, clientX: x1, clientY: 300 });
  fireEvent.pointerUp(el, { pointerId: 1, clientX: x1, clientY: 300 });
}

function mount(props: Partial<React.ComponentProps<typeof SwipeRow>> = {}) {
  const onDelete = vi.fn();
  const onDuplicate = vi.fn();
  const onMove = vi.fn();
  const onPin = vi.fn();
  const onOpen = vi.fn();
  const onClose = vi.fn();
  const { container } = render(
    <SwipeRow
      isOpen={props.isOpen ?? false}
      onOpen={onOpen}
      onClose={onClose}
      onDelete={onDelete}
      onDuplicate={onDuplicate}
      onMove={onMove}
      onPin={onPin}
      isPinned={props.isPinned ?? false}
    >
      <div className="row-body">note</div>
    </SwipeRow>,
  );
  return { container, onDelete, onDuplicate, onMove, onPin, onOpen, onClose };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.runOnlyPendingTimers(); vi.useRealTimers(); cleanup(); });

describe('SwipeRow rearrange', () => {
  it('LEFT fling commits Delete (delete moved to the left side)', () => {
    const { container, onDelete } = mount();
    act(() => dragX(fg(container), 300, 300 - FLING));
    // commitDelete chains setTimeout(260) → setTimeout(220) → onDelete.
    act(() => { vi.advanceTimersByTime(600); });
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('RIGHT fling commits Pin (pin replaced delete as the right fling)', () => {
    const { container, onPin, onDelete } = mount();
    act(() => dragX(fg(container), 300, 300 + FLING));
    expect(onPin).toHaveBeenCalledTimes(1);
    expect(onDelete).not.toHaveBeenCalled(); // right fling is NOT delete anymore
  });

  it('Copy is a RIGHT tap button and stays on the right', () => {
    const { container, onDuplicate } = mount();
    const copy = container.querySelector('.swipe-row__back-right .swipe-row__btn--copy') as HTMLElement;
    expect(copy).not.toBeNull();
    expect(copy.textContent).toBe('Copy');
    fireEvent.click(copy);
    expect(onDuplicate).toHaveBeenCalledTimes(1);
  });

  it('Move is a LEFT tap button and stays on the left', () => {
    const { container, onMove } = mount();
    const move = container.querySelector('.swipe-row__back-left .swipe-row__btn--move') as HTMLElement;
    expect(move).not.toBeNull();
    expect(move.textContent).toBe('Move');
    fireEvent.click(move);
    expect(onMove).toHaveBeenCalledTimes(1);
  });

  it('a SHORT left drag opens the Move seam (tap) without committing delete', () => {
    const { container, onDelete, onOpen } = mount();
    act(() => dragX(fg(container), 300, 300 - TAP_OPEN));
    act(() => { vi.advanceTimersByTime(600); });
    expect(onDelete).not.toHaveBeenCalled();
    expect(onOpen).toHaveBeenCalled(); // the seam snapped open
  });

  it('a SHORT right drag opens the Copy seam (tap) without committing pin', () => {
    const { container, onPin, onOpen } = mount();
    act(() => dragX(fg(container), 300, 300 + TAP_OPEN));
    expect(onPin).not.toHaveBeenCalled();
    expect(onOpen).toHaveBeenCalled();
  });
});
