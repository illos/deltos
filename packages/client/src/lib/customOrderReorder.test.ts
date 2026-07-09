import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Note } from '@deltos/shared';
import { SYS_NOTEBOOK_ORDER_KEY, notebookOrder } from '@deltos/shared';

/**
 * reorderCustom unit test (notebook-menu-and-keep-view.md §5.4) — the fractional-key math + the single O(1)
 * write. Pure/deterministic (tdd-cycle: this is test-shaped). Mocks the note write + queue notify.
 */

const { setOrder, notifyQueueWrite } = vi.hoisted(() => ({ setOrder: vi.fn(), notifyQueueWrite: vi.fn() }));
vi.mock('../db/mutate.js', () => ({ mutateNotes: { setOrder } }));
vi.mock('./syncEngine.js', () => ({ notifyQueueWrite }));

import { reorderCustom } from './customOrderReorder.js';
import { sortNotes } from './noteSort.js';

/** A note with a custom-order key (or none). */
function note(id: string, order: number | null): Note {
  const props = order === null ? {} : { [SYS_NOTEBOOK_ORDER_KEY]: { type: 'number', value: order } };
  return { id, notebookId: 'nb-1', properties: props } as unknown as Note;
}

beforeEach(() => vi.clearAllMocks());

describe('reorderCustom', () => {
  it('writes the midpoint of the two new neighbours when dropped between them', async () => {
    // [a=0, b=10, c=20] — move a (index 0) to index 2 (between b and c → midpoint 15).
    const notes = [note('a', 0), note('b', 10), note('c', 20)];
    await reorderCustom(notes, 0, 2);
    expect(setOrder).toHaveBeenCalledTimes(1);
    const [moved, key] = setOrder.mock.calls[0]!;
    expect((moved as Note).id).toBe('a');
    expect(key).toBe(15); // (10 + 20) / 2
    expect(notifyQueueWrite).toHaveBeenCalledWith('nb-1');
  });

  it('offsets past the single bound when dropped at the very top', async () => {
    // [a=0, b=10, c=20] — move c (index 2) to index 0 (above a → a.order - 1 = -1).
    const notes = [note('a', 0), note('b', 10), note('c', 20)];
    await reorderCustom(notes, 2, 0);
    const [moved, key] = setOrder.mock.calls[0]!;
    expect((moved as Note).id).toBe('c');
    expect(key).toBe(-1);
  });

  it('offsets past the single bound when dropped at the very bottom', async () => {
    // [a=0, b=10] — move a (index 0) to the END (insert position 2 = past every row). reduced=[b],
    // destIndex=1 → before=b(10), after=null → before + 1 = 11.
    const notes = [note('a', 0), note('b', 10)];
    await reorderCustom(notes, 0, 2 /* insert-at-end */);
    const [moved, key] = setOrder.mock.calls[0]!;
    expect((moved as Note).id).toBe('a');
    expect(key).toBe(11); // dropped below b → b.order + 1
  });

  it('is a no-op when from === to', async () => {
    const notes = [note('a', 0), note('b', 10)];
    await reorderCustom(notes, 1, 1);
    expect(setOrder).not.toHaveBeenCalled();
  });

  it('places between exactly two items regardless of unkeyed neighbours', async () => {
    // b has no key → fractionalMidpoint(0, null) = 0 - ... actually with before=a(0), after=null → before+1.
    const notes = [note('a', 0), note('b', null)];
    await reorderCustom(notes, 1, 0); // move b above a → before=null, after=a(0) → after-1 = -1
    const [, key] = setOrder.mock.calls[0]!;
    expect(key).toBe(-1);
  });

  /** Apply the recorded setOrder(note, key) writes onto fresh note copies, then real-sort by 'custom'. */
  function applyWritesAndSort(base: Note[]): Note[] {
    const byId = new Map(base.map((n) => [n.id, note(n.id, notebookOrder(n.properties))]));
    for (const [n, key] of setOrder.mock.calls as [Note, number][]) {
      byId.set(n.id, note(n.id, key));
    }
    return sortNotes([...byId.values()], 'custom');
  }

  it('cold notebook: seeds keys then drops the moved note where it landed', async () => {
    // No note has a key. [a, b, c] — drag a (index 0) → insert position 2 ("after the second note", between
    // b and c). reduced=[b,c], destIndex=1. before=b, after=c are BOTH null → seed b=0,c=1 then a=0.5.
    const notes = [note('a', null), note('b', null), note('c', null)];
    await reorderCustom(notes, 0, 2);

    // Seeding writes over the reduced order [b, c] (b=0, c=1) + the final moved write (a).
    const calls = setOrder.mock.calls as [Note, number][];
    const byIdKey = new Map(calls.map(([n, k]) => [String(n.id), k]));
    expect(byIdKey.get('b')).toBe(0);
    expect(byIdKey.get('c')).toBe(1);
    // a seeds nowhere (it's the moved note); its final fractional key is between b(0) and c(1) → 0.5.
    expect(byIdKey.get('a')).toBe(0.5);
    expect(notifyQueueWrite).toHaveBeenCalledWith('nb-1');

    // REAL acceptance: applying the written keys + real 'custom' sort lands the moved note where dropped.
    expect(applyWritesAndSort(notes).map((n) => n.id)).toEqual(['b', 'a', 'c']);
  });

  it('partially-keyed: needed neighbour already keyed → no seeding, single write (fast path)', async () => {
    // [a=0, b=10, c=null] — move c (index 2) to index 1 (between a and b → midpoint 5). The needed bounds
    // (a, b) are BOTH keyed → no seeding, exactly one setOrder for the moved note.
    const notes = [note('a', 0), note('b', 10), note('c', null)];
    await reorderCustom(notes, 2, 1);
    expect(setOrder).toHaveBeenCalledTimes(1);
    const [moved, key] = setOrder.mock.calls[0]!;
    expect((moved as Note).id).toBe('c');
    expect(key).toBe(5); // (0 + 10) / 2
  });

  it('cold notebook no-op drop (to === from) → zero writes (guards run before seeding)', async () => {
    const notes = [note('a', null), note('b', null), note('c', null)];
    await reorderCustom(notes, 1, 1);
    expect(setOrder).not.toHaveBeenCalled();
    expect(notifyQueueWrite).not.toHaveBeenCalled();
  });
});
