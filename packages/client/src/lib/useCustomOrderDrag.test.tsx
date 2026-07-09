/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, cleanup, fireEvent } from '@testing-library/react';
import type { Note } from '@deltos/shared';
import { useCustomOrderDrag } from './useCustomOrderDrag.js';

/**
 * Drag-reorder correctness (ROAD-0019 defects 2 & 3):
 *  - pointerup during an active drag commits exactly one reorderCustom(from, to).
 *  - pointercancel during an active drag ABORTS — no write, order untouched, overlay/placeholder cleared.
 *  - after a touch drag ARMS, the window touchmove listener preventDefaults (kills native scroll that would
 *    fire pointercancel); during the pending press it does NOT (scroll stays native).
 */

const reorderCustom = vi.fn();
vi.mock('./customOrderReorder.js', () => ({
  reorderCustom: (...args: unknown[]) => reorderCustom(...args),
}));

function note(id: string): Note {
  return { id, notebookId: 'nb-1', title: id, updatedAt: '2026-06-01T00:00:00Z', createdAt: '2026-06-01T00:00:00Z', properties: {}, body: [] } as unknown as Note;
}

const NOTES = [note('a'), note('b'), note('c')];

// A minimal list harness that wires the hook exactly like App.tsx HomeView (rows registered, bodyProps on body).
function Harness({ layout = 'list' as 'list' | 'grid' }) {
  const drag = useCustomOrderDrag(NOTES, true, layout);
  return (
    <ul>
      {drag.renderItems.map((item) => {
        if (item.kind === 'placeholder') {
          return <li key={item.key} data-testid="placeholder" />;
        }
        const { note: n, originalIndex } = item;
        return (
          <li key={n.id} ref={(el) => drag.registerRow(n.id, el)}>
            <div data-testid={`body-${n.id}`} {...drag.bodyProps(originalIndex, n)}>{n.id}</div>
          </li>
        );
      })}
    </ul>
  );
}

// Stub each row's getBoundingClientRect so indexAtPoint resolves deterministically. untransformedRect now reads
// the live gBCR (minus the row's own transform), so the geometry lives there — not on offset* props.
function stubRowGeometry(container: HTMLElement) {
  const lis = Array.from(container.querySelectorAll('li')) as HTMLElement[];
  lis.forEach((li, i) => {
    const top = i * 100;
    li.getBoundingClientRect = () =>
      ({ left: 0, top, right: 300, bottom: top + 100, width: 300, height: 100, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
  });
}

function press(el: Element, pointerId = 1) {
  fireEvent.pointerDown(el, { button: 0, pointerId, pointerType: 'touch', clientX: 10, clientY: 10 });
}

beforeEach(() => {
  reorderCustom.mockClear();
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => window.setTimeout(() => cb(performance.now()), 0));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.unstubAllGlobals();
});

describe('useCustomOrderDrag — commit vs abort', () => {
  it('pointerup during an active drag commits exactly one reorderCustom(from, to)', () => {
    const { container } = render(<Harness />);
    stubRowGeometry(container);
    const body = container.querySelector('[data-testid="body-a"]')!;

    press(body);
    act(() => { vi.advanceTimersByTime(300); }); // arm (260ms long-press)

    // Move the pointer down past row c's center → drop at the end.
    act(() => {
      fireEvent(window, new PointerEvent('pointermove', { pointerId: 1, clientX: 10, clientY: 260, cancelable: true, bubbles: true }));
      vi.advanceTimersByTime(20); // flush the rAF that recomputes overIndex
    });
    act(() => {
      fireEvent(window, new PointerEvent('pointerup', { pointerId: 1, clientX: 10, clientY: 260, cancelable: true, bubbles: true }));
    });

    expect(reorderCustom).toHaveBeenCalledTimes(1);
    const [, from, to] = reorderCustom.mock.calls[0]!;
    expect(from).toBe(0); // note 'a' was index 0
    expect(to).toBe(3);   // dropped at the end
  });

  it('pointercancel during an active drag ABORTS — no write, overlay/placeholder cleared', () => {
    const { container } = render(<Harness />);
    stubRowGeometry(container);
    const body = container.querySelector('[data-testid="body-a"]')!;

    press(body);
    act(() => { vi.advanceTimersByTime(300); }); // arm
    act(() => {
      fireEvent(window, new PointerEvent('pointermove', { pointerId: 1, clientX: 10, clientY: 160, cancelable: true, bubbles: true }));
      vi.advanceTimersByTime(20);
    });
    // A placeholder should exist mid-drag.
    expect(container.querySelector('[data-testid="placeholder"]')).not.toBeNull();

    act(() => {
      fireEvent(window, new PointerEvent('pointercancel', { pointerId: 1, clientX: 10, clientY: 160, cancelable: true, bubbles: true }));
    });

    expect(reorderCustom).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="placeholder"]')).toBeNull(); // order restored, no gap
  });
});

describe('useCustomOrderDrag — hit-tests at the UNTRANSFORMED position mid-FLIP', () => {
  it('subtracts a row\'s own in-flight transform so the drop index derives from settled geometry', () => {
    const { container } = render(<Harness />);
    // Rows sit at settled tops 0 / 100 / 200 (each 100 tall). Simulate a FLIP mid-flight by shifting the
    // reported gBCR of every row DOWN by 40px and reporting a matching matrix(1,0,0,1,0,40) transform — the
    // untransformedRect must undo the 40px so hit-testing sees the settled tops, not the shifted ones.
    const SHIFT = 40;
    const lis = Array.from(container.querySelectorAll('li')) as HTMLElement[];
    lis.forEach((li, i) => {
      const top = i * 100 + SHIFT; // shifted (as gBCR would report mid-transition)
      li.getBoundingClientRect = () =>
        ({ left: 0, top, right: 300, bottom: top + 100, width: 300, height: 100, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    });

    // jsdom lacks DOMMatrixReadOnly; provide a minimal stub that parses `matrix(a,b,c,d,e,f)` into m41/m42.
    const savedMatrix = (globalThis as { DOMMatrixReadOnly?: unknown }).DOMMatrixReadOnly;
    class FakeMatrix { m41: number; m42: number; constructor(tf: string) {
      const nums = tf.replace(/matrix\(|\)/g, '').split(',').map((s) => parseFloat(s));
      this.m41 = nums[4] ?? 0; this.m42 = nums[5] ?? 0;
    } }
    (globalThis as { DOMMatrixReadOnly?: unknown }).DOMMatrixReadOnly = FakeMatrix;

    const savedGCS = window.getComputedStyle;
    const gcsSpy = vi.spyOn(window, 'getComputedStyle').mockImplementation(((el: Element, pe?: string | null) => {
      if (lis.includes(el as HTMLElement)) return { transform: `matrix(1, 0, 0, 1, 0, ${SHIFT})` } as CSSStyleDeclaration;
      return savedGCS.call(window, el, pe ?? undefined);
    }) as typeof window.getComputedStyle);

    try {
      const body = container.querySelector('[data-testid="body-a"]')!;
      press(body);
      act(() => { vi.advanceTimersByTime(300); }); // arm

      // Point at clientY=260 in VIEWPORT coords. Settled row c center is at 250 (top 200 + 50); 260 is past it,
      // so with correct un-shifting the drop index is the end (3). If the 40px shift were NOT undone, the shifted
      // centers (90/190/290) would put 260 before row c's center → index 2, and this assertion would catch it.
      act(() => {
        fireEvent(window, new PointerEvent('pointermove', { pointerId: 1, clientX: 10, clientY: 260, cancelable: true, bubbles: true }));
        vi.advanceTimersByTime(20);
      });
      act(() => {
        fireEvent(window, new PointerEvent('pointerup', { pointerId: 1, clientX: 10, clientY: 260, cancelable: true, bubbles: true }));
      });

      expect(reorderCustom).toHaveBeenCalledTimes(1);
      const [, from, to] = reorderCustom.mock.calls[0]!;
      expect(from).toBe(0);
      expect(to).toBe(3);
    } finally {
      gcsSpy.mockRestore();
      if (savedMatrix === undefined) delete (globalThis as { DOMMatrixReadOnly?: unknown }).DOMMatrixReadOnly;
      else (globalThis as { DOMMatrixReadOnly?: unknown }).DOMMatrixReadOnly = savedMatrix;
    }
  });
});

describe('useCustomOrderDrag — touch scroll suppression', () => {
  it('does NOT preventDefault touchmove during the pending (unarmed) press', () => {
    const { container } = render(<Harness />);
    stubRowGeometry(container);
    const body = container.querySelector('[data-testid="body-a"]')!;

    press(body); // pending press — listener attached but must be inert until armed
    const ev = new Event('touchmove', { cancelable: true, bubbles: true });
    act(() => { window.dispatchEvent(ev); });
    expect(ev.defaultPrevented).toBe(false);
  });

  it('preventDefaults touchmove once the drag is ARMED (blocks native scroll → no pointercancel)', () => {
    const { container } = render(<Harness />);
    stubRowGeometry(container);
    const body = container.querySelector('[data-testid="body-a"]')!;

    press(body);
    act(() => { vi.advanceTimersByTime(300); }); // arm

    const ev = new Event('touchmove', { cancelable: true, bubbles: true });
    act(() => { window.dispatchEvent(ev); });
    expect(ev.defaultPrevented).toBe(true);
  });
});
