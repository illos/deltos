import { describe, it, expect } from 'vitest';
import { PickablesResponseSchema } from '../src/api/pickables.js';

const NB = '11111111-1111-4111-8111-111111111111';
const NOTE = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

describe('PickablesResponseSchema', () => {
  it('accepts notebooks + notes with a nullable notebookId', () => {
    const parsed = PickablesResponseSchema.parse({
      notebooks: [{ id: NB, name: 'Work' }],
      notes: [
        { id: NOTE, title: 'Grocery list', notebookId: NB },
        { id: NOTE, title: 'Uncategorized', notebookId: null },
      ],
    });
    expect(parsed.notebooks).toHaveLength(1);
    expect(parsed.notes[1]?.notebookId).toBeNull();
  });

  it('accepts an empty set (no notebooks, no note matches)', () => {
    expect(PickablesResponseSchema.parse({ notebooks: [], notes: [] })).toEqual({ notebooks: [], notes: [] });
  });

  it('rejects a non-uuid notebook id (branded ids)', () => {
    expect(PickablesResponseSchema.safeParse({ notebooks: [{ id: 'nope', name: 'x' }], notes: [] }).success).toBe(
      false,
    );
  });
});
