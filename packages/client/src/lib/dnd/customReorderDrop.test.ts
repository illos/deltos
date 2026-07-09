import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Note } from '@deltos/shared';

/**
 * Unit test for the library-based reorder drop mapping (ROAD-0019) — the pure translation from dnd-kit's
 * reordered-ids to reorderCustom's (from, to) insert-position contract. reorderCustom itself is mocked; we
 * assert the (from, to) it's called with, plus the no-op cases (no write).
 */
const { reorderCustom } = vi.hoisted(() => ({ reorderCustom: vi.fn() }));
vi.mock('../customOrderReorder.js', () => ({ reorderCustom }));

import { computeReorderMove, commitReorder } from './customReorderDrop.js';

const notes = (ids: string[]): Note[] => ids.map((id) => ({ id }) as unknown as Note);

beforeEach(() => vi.clearAllMocks());

describe('computeReorderMove', () => {
  it('maps a downward move to an insert-position past the target slot', () => {
    // [a,b,c] → drag a below b: dnd-kit yields [b,a,c]. from=0, newIndex=1 → to = 1+1 = 2.
    expect(computeReorderMove(['a', 'b', 'c'], ['b', 'a', 'c'], 'a')).toEqual({ from: 0, to: 2 });
  });

  it('maps an upward move to the new index as the insert-position', () => {
    // [a,b,c] → drag c above a: [c,a,b]. from=2, newIndex=0 → to = 0 (insert before a).
    expect(computeReorderMove(['a', 'b', 'c'], ['c', 'a', 'b'], 'c')).toEqual({ from: 2, to: 0 });
  });

  it('maps a middle-insert correctly', () => {
    // [a,b,c,d] → drag a between b and c: [b,a,c,d]. from=0, newIndex=1 → to=2.
    expect(computeReorderMove(['a', 'b', 'c', 'd'], ['b', 'a', 'c', 'd'], 'a')).toEqual({ from: 0, to: 2 });
  });

  it('returns null for a no-op drop (id lands in its own slot)', () => {
    expect(computeReorderMove(['a', 'b', 'c'], ['a', 'b', 'c'], 'a')).toBeNull();
  });

  it('returns null when a downward map collapses to the adjacent slot', () => {
    // Order unchanged but computed the "down" way: newIndex === from → to = from+1 → reorderCustom no-op guard.
    expect(computeReorderMove(['a', 'b', 'c'], ['a', 'b', 'c'], 'b')).toBeNull();
  });

  it('returns null when the moved id is missing', () => {
    expect(computeReorderMove(['a', 'b'], ['a', 'b'], 'zzz')).toBeNull();
  });
});

describe('commitReorder', () => {
  it('issues exactly one reorderCustom(notes, from, to) for a real move', async () => {
    const list = notes(['a', 'b', 'c']);
    await commitReorder(list, ['a', 'b', 'c'], ['b', 'a', 'c'], 'a');
    expect(reorderCustom).toHaveBeenCalledTimes(1);
    expect(reorderCustom).toHaveBeenCalledWith(list, 0, 2);
  });

  it('writes nothing for a no-op drop (same index)', async () => {
    await commitReorder(notes(['a', 'b', 'c']), ['a', 'b', 'c'], ['a', 'b', 'c'], 'a');
    expect(reorderCustom).not.toHaveBeenCalled();
  });
});
