/**
 * Fix A — pmDocToSpine must NEVER leak a render-only / non-UUID block id into the persisted spine.
 *
 * Root cause (the confirmed prod incident): spineToPmDoc emits DETERMINISTIC render-only ids for
 * wrapper/inner nodes — `${atomId}~w` (plugin wrapper paragraph), `${quoteId}~q` (blockquote first
 * paragraph), `${listId}~empty` (empty-list fallback item) — so the #90 reconcile echo-guard short-
 * circuits and undo survives autosave (GOTCHA-0005). They are normally discarded on the way back, but an
 * ORPHANED wrapper paragraph (its plugin atom deleted) serializes as a PLAIN paragraph still carrying the
 * `~w` id, leaking a non-UUID into the spine. BlockIdSchema is a strict UUID, so ONE such block fails
 * SyncPushEntrySchema → the worker 400s the WHOLE batch → all sync wedges.
 *
 * The fix re-mints any non-UUID block id at the pmDocToSpine boundary (sanitizeBlockIds), while preserving
 * idempotency for clean notes (so the undo-determinism guarantee from GOTCHA-0005 is NOT re-broken).
 */

import { describe, it, expect } from 'vitest';
import type { BlockBody, BlockId } from '@deltos/shared';
import { BlockIdSchema } from '@deltos/shared';
import { deltoSchema } from '../src/editor/schema.js';
import { pmDocToSpine, sanitizeBlockIds, isValidBlockId } from '../src/editor/serializer.js';

const UUID = 'c668eee8-b091-4d27-a933-d3dabfa94de6'; // the real id from the prod snapshot
const isUuid = (id: unknown) => BlockIdSchema.safeParse(id).success;

// ── sanitizeBlockIds (the load-bearing helper) ───────────────────────────────────
describe('sanitizeBlockIds: re-mints non-UUID block ids, idempotent for clean ones', () => {
  it('re-mints a `~w` paragraph id to a fresh valid UUID (never the ~-suffixed string)', () => {
    const body: BlockBody = [
      { id: `${UUID}~w` as BlockId, type: 'paragraph', content: { segments: [{ text: 'orphaned' }] } },
    ];
    const out = sanitizeBlockIds(body);
    expect(out[0]!.id).not.toBe(`${UUID}~w`);
    expect(isUuid(out[0]!.id)).toBe(true);
    // content + type preserved — only the id changed.
    expect(out[0]!.type).toBe('paragraph');
    expect(out[0]!.content).toEqual({ segments: [{ text: 'orphaned' }] });
  });

  it('re-mints `~q` and `~empty` ids too', () => {
    const body: BlockBody = [
      { id: `${UUID}~q` as BlockId, type: 'paragraph', content: { segments: [{ text: 'q' }] } },
      { id: `${UUID}~empty` as BlockId, type: 'paragraph', content: { segments: [] } },
    ];
    const out = sanitizeBlockIds(body);
    expect(isUuid(out[0]!.id)).toBe(true);
    expect(isUuid(out[1]!.id)).toBe(true);
    expect(out[0]!.id).not.toContain('~');
    expect(out[1]!.id).not.toContain('~');
  });

  it('re-mints a non-UUID id nested in children (recursive)', () => {
    const body: BlockBody = [
      {
        id: UUID as BlockId,
        type: 'list',
        content: { ordered: false },
        children: [{ id: `${UUID}~empty` as BlockId, type: 'paragraph', content: { segments: [] } }],
      },
    ];
    const out = sanitizeBlockIds(body);
    expect(out[0]!.id).toBe(UUID); // valid parent id UNCHANGED
    expect(isUuid(out[0]!.children![0]!.id)).toBe(true);
    expect(out[0]!.children![0]!.id).not.toContain('~');
  });

  it('is a no-op (value-stable) for an all-valid-UUID body — undo-determinism preserved', () => {
    const body: BlockBody = [
      { id: UUID as BlockId, type: 'paragraph', content: { segments: [{ text: 'clean' }] } },
      {
        id: '11111111-2222-4333-8444-555555555555' as BlockId,
        type: 'list',
        content: { ordered: true },
        children: [{ id: '99999999-2222-4333-8444-555555555555' as BlockId, type: 'paragraph', content: { segments: [{ text: 'i' }] } }],
      },
    ];
    const out = sanitizeBlockIds(body);
    expect(out).toEqual(body); // identical values → re-running pmDocToSpine never re-breaks the echo-guard
    expect(sanitizeBlockIds(out)).toEqual(body); // idempotent
  });
});

describe('isValidBlockId', () => {
  it('accepts a UUID, rejects a ~-suffixed render-only id', () => {
    expect(isValidBlockId(UUID)).toBe(true);
    expect(isValidBlockId(`${UUID}~w`)).toBe(false);
    expect(isValidBlockId('not-an-id')).toBe(false);
  });
});

// ── pmDocToSpine end-to-end: the orphaned-wrapper leak ───────────────────────────
describe('pmDocToSpine: an orphaned `${atomId}~w` paragraph yields a valid-UUID block', () => {
  it('a plain paragraph carrying a ~w id (atom deleted) serializes with a fresh valid UUID', () => {
    // The orphan: a paragraph that once wrapped a plugin atom, now holding only text, still carries the
    // deterministic `${atomId}~w` id. Before the fix this leaked verbatim into the spine.
    const doc = deltoSchema.node('doc', null, [
      deltoSchema.node('title', { id: null }, []),
      deltoSchema.node('paragraph', { id: `${UUID}~w` }, [deltoSchema.text('left-behind caption')]),
    ]);

    const spine = pmDocToSpine(doc);
    expect(spine).toHaveLength(1);
    expect(spine[0]!.type).toBe('paragraph');
    expect(spine[0]!.id).not.toBe(`${UUID}~w`);
    expect(isUuid(spine[0]!.id)).toBe(true);
    // The whole spine validates as a block body now (the per-block UUID gate the server enforces).
    for (const b of spine) expect(isUuid(b.id)).toBe(true);
  });

  it('a normal paragraph (real UUID) is unchanged through pmDocToSpine', () => {
    const doc = deltoSchema.node('doc', null, [
      deltoSchema.node('title', { id: null }, []),
      deltoSchema.node('paragraph', { id: UUID }, [deltoSchema.text('normal')]),
    ]);
    const spine = pmDocToSpine(doc);
    expect(spine[0]!.id).toBe(UUID); // no spurious re-mint
  });
});
