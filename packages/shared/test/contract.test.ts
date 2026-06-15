import { describe, it, expect } from 'vitest';
import {
  NoteIdSchema,
  NoteSchema,
  PropertyValueSchema,
  BlockSchema,
  SearchQuerySchema,
  UpdateNoteRequestSchema,
  GrantConstraintsSchema,
  GrantSchema,
  RequestPrincipalSchema,
  UNSYNCED_VERSION,
  FIRST_SERVER_VERSION,
} from '../src/index.js';

/**
 * Contract tests for the frozen substrate. These exist to make a *loosening* of the contract
 * fail CI: every `expect(...).toBe(false)` pins a boundary that must keep rejecting. If a later
 * edit makes one of these pass, the spine got weaker — that's the regression we're guarding.
 */

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const validNote = () => ({
  id: uuid(1),
  notebookId: uuid(2),
  createdAt: '2026-06-15T12:00:00Z',
  updatedAt: '2026-06-15T12:00:00Z',
  version: FIRST_SERVER_VERSION,
  syncStatus: 'synced',
  title: 'Hello',
  properties: {
    tags: { type: 'select', value: ['recipe', 'quick'] },
    related: { type: 'relation', value: [uuid(3)] },
  },
  body: [
    { id: uuid(10), type: 'heading', content: { text: 'Title', level: 1 } },
    { id: uuid(11), type: 'list', children: [{ id: uuid(12), type: 'paragraph', content: {} }] },
    { id: uuid(13), type: 'my-plugin.chart', content: { opaque: true } },
    { id: uuid(14), type: 'divider' },
  ],
});

describe('ids & branding', () => {
  it('accepts a UUID', () => {
    expect(NoteIdSchema.safeParse(uuid(1)).success).toBe(true);
  });
  it('rejects a non-UUID string', () => {
    expect(NoteIdSchema.safeParse('not-a-uuid').success).toBe(false);
    expect(NoteIdSchema.safeParse('').success).toBe(false);
  });
});

describe('note spine', () => {
  it('parses a representative note (recursive blocks, opaque plugin content)', () => {
    expect(NoteSchema.safeParse(validNote()).success).toBe(true);
  });
  it('rejects a note missing the system version field', () => {
    const n = validNote() as Record<string, unknown>;
    delete n.version;
    expect(NoteSchema.safeParse(n).success).toBe(false);
  });
});

describe('property value discriminated union', () => {
  it('accepts each known type', () => {
    expect(PropertyValueSchema.safeParse({ type: 'number', value: 3 }).success).toBe(true);
    expect(PropertyValueSchema.safeParse({ type: 'url', value: 'https://x.dev' }).success).toBe(
      true,
    );
  });
  it('rejects an unknown property type', () => {
    expect(PropertyValueSchema.safeParse({ type: 'geo', value: [1, 2] }).success).toBe(false);
  });
  it('rejects a value mismatched to its type', () => {
    expect(PropertyValueSchema.safeParse({ type: 'number', value: 'three' }).success).toBe(false);
    expect(PropertyValueSchema.safeParse({ type: 'url', value: 'not-a-url' }).success).toBe(false);
  });
  it('rejects a relation carrying a non-UUID reference', () => {
    expect(PropertyValueSchema.safeParse({ type: 'relation', value: ['nope'] }).success).toBe(
      false,
    );
  });
});

describe('block tree', () => {
  it('keeps block type open (plugin types accepted)', () => {
    expect(BlockSchema.safeParse({ id: uuid(1), type: 'anything.custom' }).success).toBe(true);
  });
  it('rejects an empty block type', () => {
    expect(BlockSchema.safeParse({ id: uuid(1), type: '' }).success).toBe(false);
  });
});

describe('search refinement', () => {
  it('rejects an unbounded (empty) query', () => {
    expect(SearchQuerySchema.safeParse({}).success).toBe(false);
    expect(SearchQuerySchema.safeParse({ filters: [] }).success).toBe(false);
  });
  it('accepts a query narrowed by any one of text / notebookId / filter', () => {
    expect(SearchQuerySchema.safeParse({ text: 'x' }).success).toBe(true);
    expect(SearchQuerySchema.safeParse({ notebookId: uuid(2) }).success).toBe(true);
  });
});

describe('optimistic-concurrency precondition (expectedVersion)', () => {
  const base = { id: uuid(1), patch: { title: 'new' } };
  it('is optional', () => {
    expect(UpdateNoteRequestSchema.safeParse(base).success).toBe(true);
  });
  it('accepts a valid version', () => {
    expect(UpdateNoteRequestSchema.safeParse({ ...base, expectedVersion: 3 }).success).toBe(true);
  });
  it('rejects a negative or fractional version', () => {
    expect(UpdateNoteRequestSchema.safeParse({ ...base, expectedVersion: -1 }).success).toBe(false);
    expect(UpdateNoteRequestSchema.safeParse({ ...base, expectedVersion: 1.5 }).success).toBe(
      false,
    );
  });
});

describe('grant constraints are fail-closed', () => {
  it('accepts known constraints', () => {
    expect(GrantConstraintsSchema.safeParse({}).success).toBe(true);
    expect(GrantConstraintsSchema.safeParse({ expiresAt: '2026-07-01T00:00:00Z' }).success).toBe(
      true,
    );
  });
  it('REJECTS an unrecognized constraint key (no silent fail-open)', () => {
    expect(GrantConstraintsSchema.safeParse({ rateLimit: 10 }).success).toBe(false);
  });
});

describe('grant & live principal', () => {
  it('parses a grant with a discriminated resource', () => {
    const grant = {
      principal: { kind: 'agent', id: 'bot-1' },
      resource: { kind: 'note', id: uuid(1) },
      scope: ['read', 'search'],
      constraints: {},
    };
    expect(GrantSchema.safeParse(grant).success).toBe(true);
  });
  it('requires a verification marker on a live principal', () => {
    expect(RequestPrincipalSchema.safeParse({ kind: 'owner', id: 'o' }).success).toBe(false);
    expect(
      RequestPrincipalSchema.safeParse({
        kind: 'owner',
        id: 'o',
        verification: { method: 'unverified' },
      }).success,
    ).toBe(true);
  });
});

describe('version convention', () => {
  it('pins the named constants', () => {
    expect(UNSYNCED_VERSION).toBe(0);
    expect(FIRST_SERVER_VERSION).toBe(1);
  });
});
