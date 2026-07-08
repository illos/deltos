import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Note } from '@deltos/shared';
import { SYS_NOTEBOOK_ORDER_KEY } from '@deltos/shared';

/**
 * reorderCustom unit test (notebook-menu-and-keep-view.md §5.4) — the fractional-key math + the single O(1)
 * write. Pure/deterministic (tdd-cycle: this is test-shaped). Mocks the note write + queue notify.
 */

const { setOrder, notifyQueueWrite } = vi.hoisted(() => ({ setOrder: vi.fn(), notifyQueueWrite: vi.fn() }));
vi.mock('../db/mutate.js', () => ({ mutateNotes: { setOrder } }));
vi.mock('./syncEngine.js', () => ({ notifyQueueWrite }));

import { reorderCustom } from './customOrderReorder.js';

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
});
