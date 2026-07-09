import { useCallback, useEffect, useRef } from 'react';

const DEFAULT_ROW_UNIT = 8;
const DEFAULT_GAP = 12;

function readPx(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Measures each board card's true content height and writes the CSS Grid row span directly to its cell.
 * React owns ordering; the browser owns placement; this hook only supplies `--board-row-span`.
 */
export function useMeasuredGridSpans(depsKey: unknown = null) {
  const cells = useRef<Map<string, HTMLElement>>(new Map());
  const observed = useRef<Map<Element, HTMLElement>>(new Map());
  const observer = useRef<ResizeObserver | null>(null);
  const frame = useRef<number | null>(null);

  const measureCell = useCallback((cell: HTMLElement, measuredHeight?: number) => {
    const grid = cell.parentElement;
    const styles = grid ? window.getComputedStyle(grid) : null;
    const rowUnit = readPx(styles?.gridAutoRows ?? '', DEFAULT_ROW_UNIT);
    const gap = readPx(styles?.rowGap ?? styles?.gap ?? '', DEFAULT_GAP);
    const card = cell.firstElementChild as HTMLElement | null;
    const height = measuredHeight ?? card?.getBoundingClientRect().height ?? cell.getBoundingClientRect().height;
    const span = Math.max(1, Math.ceil((height + gap) / (rowUnit + gap)));
    cell.style.setProperty('--board-row-span', String(span));
  }, []);

  const scheduleMeasureAll = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = window.requestAnimationFrame(() => {
      frame.current = null;
      for (const cell of cells.current.values()) measureCell(cell);
    });
  }, [measureCell]);

  const ensureObserver = useCallback(() => {
    if (observer.current || typeof ResizeObserver === 'undefined') return observer.current;
    observer.current = new ResizeObserver((entries) => {
      if (frame.current !== null) window.cancelAnimationFrame(frame.current);
      frame.current = window.requestAnimationFrame(() => {
        frame.current = null;
        for (const entry of entries) {
          const cell = observed.current.get(entry.target);
          if (!cell) continue;
          measureCell(cell, entry.contentRect.height);
        }
      });
    });
    return observer.current;
  }, [measureCell]);

  const registerCell = useCallback((id: string, cell: HTMLElement | null) => {
    const prev = cells.current.get(id);
    const ro = ensureObserver();
    if (prev) {
      const prevCard = prev.firstElementChild;
      if (prevCard && ro) {
        ro.unobserve(prevCard);
        observed.current.delete(prevCard);
      }
      cells.current.delete(id);
    }
    if (!cell) return;
    cells.current.set(id, cell);
    cell.style.setProperty('--board-row-span', cell.style.getPropertyValue('--board-row-span') || '1');
    const card = cell.firstElementChild;
    if (card && ro) {
      observed.current.set(card, cell);
      ro.observe(card);
    }
    measureCell(cell);
  }, [ensureObserver, measureCell]);

  useEffect(() => {
    scheduleMeasureAll();
  }, [scheduleMeasureAll, depsKey]);

  useEffect(() => () => {
    if (frame.current !== null) window.cancelAnimationFrame(frame.current);
    observer.current?.disconnect();
  }, []);

  return registerCell;
}
