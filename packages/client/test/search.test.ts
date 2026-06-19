/**
 * Pure-function tests for the local search engine (lib/search.ts).
 *
 * SRch-1  Exact title match scores and returns the note
 * SRch-2  Exact body match returns the note
 * SRch-3  Fuzzy match (1-char typo) returns the note
 * SRch-4  Title match ranks above body-only match of same query
 * SRch-5  Multi-word query — all terms must match; missing term = no result
 * SRch-6  Empty / blank query returns []
 * SRch-7  Query with zero matching notes returns []
 * SRch-8  Results capped at 50
 * SRch-9  highlightRanges finds correct positions (merge overlaps)
 * SRch-10 noteBodyText extracts text from segment blocks and code blocks
 */

import { describe, it, expect } from 'vitest';
import type { Note, NotebookId } from '@deltos/shared';
import {
  searchNotes,
  highlightRanges,
  noteBodyText,
} from '../src/lib/search.js';

const NB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as NotebookId;

function makeNote(
  id: string,
  title: string,
  bodyBlocks: Array<{ content?: unknown }> = [],
): Note {
  return {
    id: id as Note['id'],
    notebookId: NB,
    title,
    body: bodyBlocks as Note['body'],
    properties: {},
    version: 1,
    createdAt: '2026-06-19T00:00:00.000Z',
    updatedAt: '2026-06-19T00:00:00.000Z',
    syncStatus: 'synced',
  };
}

function seg(text: string) {
  return { content: { segments: [{ text }] } };
}

function code(src: string) {
  return { content: { code: src } };
}

// ---------------------------------------------------------------------------

describe('SRch-1 — exact title match', () => {
  it('returns the note and a non-zero score', () => {
    const notes = [makeNote('n1', 'coffee brewing guide')];
    const results = searchNotes(notes, 'coffee');
    expect(results).toHaveLength(1);
    expect(results[0]!.note.id).toBe('n1');
    expect(results[0]!.score).toBeGreaterThan(0);
  });

  it('title match populates titleRanges', () => {
    const notes = [makeNote('n1', 'coffee brewing guide')];
    const [r] = searchNotes(notes, 'coffee');
    expect(r!.titleRanges).toHaveLength(1);
    expect(r!.titleRanges[0]).toEqual({ start: 0, end: 6 });
  });
});

describe('SRch-2 — exact body match', () => {
  it('returns a note that only matches in the body', () => {
    const notes = [makeNote('n2', 'My note', [seg('I love coffee')])];
    const results = searchNotes(notes, 'coffee');
    expect(results).toHaveLength(1);
    expect(results[0]!.note.id).toBe('n2');
  });

  it('snippet contains matched body text', () => {
    const notes = [makeNote('n2', 'My note', [seg('I love coffee every morning')])];
    const [r] = searchNotes(notes, 'coffee');
    expect(r!.snippet).toContain('coffee');
  });
});

describe('SRch-3 — fuzzy match (typo tolerance)', () => {
  it('"cofee" (missing letter) still matches "coffee"', () => {
    const notes = [makeNote('n3', 'coffee tips')];
    const results = searchNotes(notes, 'cofee');
    expect(results).toHaveLength(1);
  });

  it('"notse" (extra char) still matches "notes"', () => {
    const notes = [makeNote('n4', 'my notes')];
    const results = searchNotes(notes, 'notse');
    expect(results).toHaveLength(1);
  });
});

describe('SRch-4 — title match ranks above body-only match', () => {
  it('title-match note appears before body-match note', () => {
    const titleMatch = makeNote('title', 'coffee guide', []);
    const bodyMatch = makeNote('body', 'My tips', [seg('coffee helps')]);
    const results = searchNotes([bodyMatch, titleMatch], 'coffee');
    expect(results[0]!.note.id).toBe('title');
    expect(results[1]!.note.id).toBe('body');
  });
});

describe('SRch-5 — multi-word query: all terms required', () => {
  it('returns note only when both words match', () => {
    const notes = [
      makeNote('both', 'coffee morning', []),
      makeNote('one', 'coffee only', []),
      makeNote('neither', 'tea evening', []),
    ];
    const results = searchNotes(notes, 'coffee morning');
    expect(results.map((r) => r.note.id)).toContain('both');
    expect(results.map((r) => r.note.id)).not.toContain('neither');
  });

  it('note missing one term is excluded', () => {
    const notes = [makeNote('n', 'coffee guide', [])];
    const results = searchNotes(notes, 'coffee banana');
    expect(results).toHaveLength(0);
  });
});

describe('SRch-6 — empty query returns []', () => {
  it('blank query', () => {
    const notes = [makeNote('n', 'some note', [])];
    expect(searchNotes(notes, '')).toHaveLength(0);
  });

  it('whitespace-only query', () => {
    const notes = [makeNote('n', 'some note', [])];
    expect(searchNotes(notes, '   ')).toHaveLength(0);
  });
});

describe('SRch-7 — no-match query returns []', () => {
  it('unrelated query', () => {
    const notes = [makeNote('n', 'coffee guide', [])];
    expect(searchNotes(notes, 'zzzzzzzzz')).toHaveLength(0);
  });
});

describe('SRch-8 — results capped at 50', () => {
  it('returns at most 50 results even when more match', () => {
    const notes = Array.from({ length: 80 }, (_, i) =>
      makeNote(`n${i}`, `coffee note ${i}`, []),
    );
    const results = searchNotes(notes, 'coffee');
    expect(results.length).toBeLessThanOrEqual(50);
  });
});

describe('SRch-9 — highlightRanges', () => {
  it('finds a single occurrence', () => {
    const ranges = highlightRanges('hello world', ['world']);
    expect(ranges).toEqual([{ start: 6, end: 11 }]);
  });

  it('finds multiple non-overlapping occurrences', () => {
    const ranges = highlightRanges('ab cd ab', ['ab']);
    expect(ranges).toEqual([{ start: 0, end: 2 }, { start: 6, end: 8 }]);
  });

  it('merges overlapping ranges from two terms', () => {
    // 'abc' and 'bc' overlap at position 1-3
    const ranges = highlightRanges('abcde', ['abc', 'bc']);
    expect(ranges).toEqual([{ start: 0, end: 3 }]);
  });

  it('is case-insensitive', () => {
    const ranges = highlightRanges('Hello World', ['hello']);
    expect(ranges).toEqual([{ start: 0, end: 5 }]);
  });

  it('returns [] when no match', () => {
    expect(highlightRanges('hello', ['xyz'])).toEqual([]);
  });
});

describe('SRch-10 — noteBodyText extracts block content', () => {
  it('extracts text from segment blocks', () => {
    const note = makeNote('n', 'title', [seg('first'), seg('second')]);
    expect(noteBodyText(note)).toBe('first second');
  });

  it('extracts code from code blocks', () => {
    const note = makeNote('n', 'title', [code('console.log("hi")')]);
    expect(noteBodyText(note)).toBe('console.log("hi")');
  });

  it('returns empty string for a note with no body', () => {
    const note = makeNote('n', 'title');
    expect(noteBodyText(note)).toBe('');
  });
});
