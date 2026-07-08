/**
 * noteSort — THE note-ordering comparator (notebook-menu-and-keep-view.md §5). Pure, test-shaped: the four
 * sort modes + the pin partition (all modes) + custom fractional order + the drag midpoint. A regression
 * here silently mis-orders every list, so it is locked with unit tests (tdd-cycle).
 */
import { describe, it, expect } from 'vitest';
import type { Note } from '@deltos/shared';
import { setPinnedAt, setNotebookOrder } from '@deltos/shared';
import { sortNotes, coerceNoteSort, fractionalMidpoint } from './noteSort.js';

const note = (over: Record<string, unknown> = {}): Note =>
  ({
    id: 'n',
    notebookId: null,
    title: 'Title',
    properties: {},
    body: [],
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    version: 1,
    syncStatus: 'synced',
    ...over,
  }) as unknown as Note;

const ids = (notes: Note[]) => notes.map((n) => n.id);

describe('sortNotes — the four modes', () => {
  it("'modified' orders by updatedAt DESC", () => {
    const a = note({ id: 'a', updatedAt: '2026-07-01T00:00:00.000Z' });
    const b = note({ id: 'b', updatedAt: '2026-07-03T00:00:00.000Z' });
    const c = note({ id: 'c', updatedAt: '2026-07-02T00:00:00.000Z' });
    expect(ids(sortNotes([a, b, c], 'modified'))).toEqual(['b', 'c', 'a']);
  });

  it("'created' orders by createdAt DESC", () => {
    const a = note({ id: 'a', createdAt: '2026-07-03T00:00:00.000Z' });
    const b = note({ id: 'b', createdAt: '2026-07-01T00:00:00.000Z' });
    const c = note({ id: 'c', createdAt: '2026-07-02T00:00:00.000Z' });
    expect(ids(sortNotes([a, b, c], 'created'))).toEqual(['a', 'c', 'b']);
  });

  it("'alpha' orders by display title A–Z, case-insensitive", () => {
    const a = note({ id: 'a', title: 'banana' });
    const b = note({ id: 'b', title: 'Apple' });
    const c = note({ id: 'c', title: 'cherry' });
    expect(ids(sortNotes([a, b, c], 'alpha'))).toEqual(['b', 'a', 'c']);
  });

  it("'alpha' uses notePreview displayTitle for untitled notes (first body text, else 'Untitled')", () => {
    const titled = note({ id: 'z', title: 'Aardvark' });
    const untitled = note({
      id: 'u',
      title: '',
      body: [{ id: 'p', type: 'paragraph', content: { segments: [{ text: 'Marmot' }] } }] as unknown as Note['body'],
    });
    // 'Aardvark' < 'Marmot' → titled first, deterministically (no crash on empty title).
    expect(ids(sortNotes([untitled, titled], 'alpha'))).toEqual(['z', 'u']);
  });

  it("'custom' orders by sys:notebookOrder ASC; unkeyed notes sort LAST", () => {
    const a = note({ id: 'a', properties: setNotebookOrder({}, 2) });
    const b = note({ id: 'b', properties: setNotebookOrder({}, 1) });
    const c = note({ id: 'c' }); // no order key → last
    const d = note({ id: 'd', properties: setNotebookOrder({}, 1.5) });
    expect(ids(sortNotes([a, b, c, d], 'custom'))).toEqual(['b', 'd', 'a', 'c']);
  });

  it('an unknown mode falls back to the default (modified)', () => {
    const a = note({ id: 'a', updatedAt: '2026-07-01T00:00:00.000Z' });
    const b = note({ id: 'b', updatedAt: '2026-07-02T00:00:00.000Z' });
    // @ts-expect-error — exercising the runtime fallback with a bad mode
    expect(ids(sortNotes([a, b], 'garbage'))).toEqual(['b', 'a']);
  });
});

describe('sortNotes — pin partition (applies to ALL modes)', () => {
  it('pinned notes float ABOVE the sort, most-recently-pinned on top', () => {
    const p1 = note({ id: 'p1', updatedAt: '2026-01-01T00:00:00.000Z', properties: setPinnedAt({}, '2026-07-01T00:00:00.000Z') });
    const p2 = note({ id: 'p2', updatedAt: '2026-01-01T00:00:00.000Z', properties: setPinnedAt({}, '2026-07-05T00:00:00.000Z') });
    const u1 = note({ id: 'u1', updatedAt: '2026-07-09T00:00:00.000Z' }); // newest unpinned
    const u2 = note({ id: 'u2', updatedAt: '2026-07-08T00:00:00.000Z' });
    // p2 (pinned later) first, then p1, THEN the unpinned by updatedAt DESC — pins win regardless of recency.
    expect(ids(sortNotes([u1, p1, u2, p2], 'modified'))).toEqual(['p2', 'p1', 'u1', 'u2']);
  });

  it('the pin partition holds under alpha too', () => {
    const pinnedZ = note({ id: 'z', title: 'Zebra', properties: setPinnedAt({}, '2026-07-01T00:00:00.000Z') });
    const plainA = note({ id: 'a', title: 'Apple' });
    // Alphabetically 'Apple' < 'Zebra', but the pin lifts Zebra above.
    expect(ids(sortNotes([plainA, pinnedZ], 'alpha'))).toEqual(['z', 'a']);
  });
});

describe('coerceNoteSort', () => {
  it('passes valid modes through, defaults anything else', () => {
    expect(coerceNoteSort('alpha')).toBe('alpha');
    expect(coerceNoteSort('custom')).toBe('custom');
    expect(coerceNoteSort(null)).toBe('modified');
    expect(coerceNoteSort(undefined)).toBe('modified');
    expect(coerceNoteSort('bogus')).toBe('modified');
  });
});

describe('fractionalMidpoint — O(1) reorder key', () => {
  it('midpoint between two keys, offset past a single bound, 0 for empty', () => {
    expect(fractionalMidpoint(1, 3)).toBe(2);
    expect(fractionalMidpoint(null, 5)).toBe(4); // dropped at top → below-of-first
    expect(fractionalMidpoint(5, null)).toBe(6); // dropped at bottom → above-of-last
    expect(fractionalMidpoint(null, null)).toBe(0); // first item, empty order
  });

  it('a repeated between-insert stays strictly between its neighbours (no collision)', () => {
    const mid = fractionalMidpoint(1, 2); // 1.5
    expect(mid).toBeGreaterThan(1);
    expect(mid).toBeLessThan(2);
    const mid2 = fractionalMidpoint(1, mid); // 1.25
    expect(mid2).toBeGreaterThan(1);
    expect(mid2).toBeLessThan(mid);
  });
});
