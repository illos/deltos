/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, cleanup } from '@testing-library/react';
import { useMeasuredGridSpans } from './useMeasuredGridSpans.js';

/**
 * Span math must use the BORDER box (card padding + border ≈ 28px), NOT ResizeObserver's contentRect.
 * A content-box measurement under-counts by that padding → the row span is short → the 12px vertical gap is
 * eaten and the last row spills past the .board background. These tests drive the RO path with entries that
 * expose only a border-box source (jsdom lacks borderBoxSize) and assert the span = ceil((H + gap)/(unit + gap)).
 */

const resizeObservers: MockResizeObserver[] = [];

class MockResizeObserver {
  elements = new Set<Element>();
  constructor(private readonly cb: ResizeObserverCallback) {
    resizeObservers.push(this);
  }
  observe = (el: Element) => { this.elements.add(el); };
  unobserve = (el: Element) => { this.elements.delete(el); };
  disconnect = () => { this.elements.clear(); };
  /** Fire with a border-box height ONLY (no contentRect) — proves the hook doesn't read contentRect. */
  trigger(entries: Array<{ target: Element; borderBoxHeight: number }>) {
    this.cb(
      entries.map(({ target, borderBoxHeight }) => ({
        target,
        // getBoundingClientRect() is the border-box fallback the hook uses when borderBoxSize is absent.
        // Stub it on the target so the fallback yields the intended border-box height.
        contentRect: { height: 0 } as DOMRectReadOnly,
      } as ResizeObserverEntry)),
      this as unknown as ResizeObserver,
    );
  }
}

function Grid({ heights }: { heights: number[] }) {
  const register = useMeasuredGridSpans(heights.join('|'));
  return (
    <ul className="board">
      {heights.map((h, i) => (
        <li
          key={i}
          className="board__cell"
          ref={(el) => {
            if (el) {
              // Stub the card's border-box height via getBoundingClientRect (the RO fallback source).
              const card = el.firstElementChild as HTMLElement;
              card.getBoundingClientRect = () => ({ height: h, width: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
            }
            register(String(i), el);
          }}
        >
          <div className="board__card" />
        </li>
      ))}
    </ul>
  );
}

beforeEach(() => {
  resizeObservers.length = 0;
  vi.stubGlobal('ResizeObserver', MockResizeObserver);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => window.setTimeout(() => cb(performance.now()), 0));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
  // jsdom getComputedStyle returns empty grid values → the hook falls back to DEFAULT_ROW_UNIT 8 / GAP 12.
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useMeasuredGridSpans', () => {
  it('writes span = ceil((borderBoxHeight + gap) / (rowUnit + gap)) using the border box, not contentRect', async () => {
    const { container } = render(<Grid heights={[88, 28]} />);
    const cells = Array.from(container.querySelectorAll<HTMLElement>('.board__cell'));
    const cards = Array.from(container.querySelectorAll<HTMLElement>('.board__card'));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0)); // let observe() + initial measure settle
    });

    act(() => {
      resizeObservers[0]!.trigger([
        { target: cards[0]!, borderBoxHeight: 88 },
        { target: cards[1]!, borderBoxHeight: 28 },
      ]);
    });

    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    // gap 12, unit 8 → ceil((88+12)/20) = 5 ; ceil((28+12)/20) = 2.
    expect(cells[0]!.style.getPropertyValue('--board-row-span')).toBe('5');
    expect(cells[1]!.style.getPropertyValue('--board-row-span')).toBe('2');
  });

  it('never writes a span below 1 for a tiny card', async () => {
    const { container } = render(<Grid heights={[4]} />);
    const cards = Array.from(container.querySelectorAll<HTMLElement>('.board__card'));
    const cell = container.querySelector<HTMLElement>('.board__cell')!;

    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    act(() => { resizeObservers[0]!.trigger([{ target: cards[0]!, borderBoxHeight: 4 }]); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    expect(cell.style.getPropertyValue('--board-row-span')).toBe('1');
  });
});
