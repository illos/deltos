/**
 * Reserved system-key namespace guardrail (planSys HARD GUARDRAIL / v1 acceptance + secSys build-contract).
 *
 * The trash flag rides the property bag (Fork P) but is system-owned. These tests lock the four
 * guarantees — reserved-namespace detection, the user-visible filter (UI hide + export exclusion),
 * trash set/clear, and the user-input rejection — AND the secSys contract that the WRITER and the
 * export-EXCLUSION filter agree via ONE shared constant (no drifted literal → no silent export leak).
 */
import { describe, it, expect } from 'vitest';
import {
  RESERVED_KEY_PREFIX,
  SYS_TRASHED_AT_KEY,
  SYS_PINNED_AT_KEY,
  SYS_NOTEBOOK_ORDER_KEY,
  isReservedKey,
  userProperties,
  isTrashed,
  trashedAt,
  setTrashedAt,
  isPinned,
  pinnedAt,
  setPinnedAt,
  clearPinned,
  notebookOrder,
  setNotebookOrder,
  UserPropertyKeySchema,
  UserPropertyBagSchema,
  containsReservedKey,
} from '../src/spine/reservedKeys.js';
import type { PropertyBag } from '../src/spine/property.js';
import { SetPropertyRequestSchema } from '../src/api/operations.js';

const NOW = '2026-06-17T12:00:00.000Z';

const userBag = (): PropertyBag => ({
  status: { type: 'select', value: ['active'] },
  priority: { type: 'number', value: 3 },
});

describe('reserved system-key namespace', () => {
  it('isReservedKey keys off the prefix — system keys reserved, user keys are not', () => {
    expect(isReservedKey(SYS_TRASHED_AT_KEY)).toBe(true);
    expect(isReservedKey(`${RESERVED_KEY_PREFIX}pinnedAt`)).toBe(true); // a future system key, free
    expect(isReservedKey('status')).toBe(false);
    expect(isReservedKey('priority')).toBe(false);
  });

  it('userProperties strips reserved keys, preserves user properties (UI-hide + export-exclude chokepoint)', () => {
    const bag = setTrashedAt(userBag(), NOW);
    const visible = userProperties(bag);
    expect(visible).toEqual(userBag());           // exactly the user keys, system key gone
    expect(SYS_TRASHED_AT_KEY in visible).toBe(false);
  });

  it('SECSYS CONTRACT: the writer key is the SAME constant the export filter excludes (no literal drift)', () => {
    // setTrashedAt (writer) and userProperties/isReservedKey (export filter) must agree via one constant:
    // anything the writer adds is, by construction, stripped by the filter — so it can NEVER reach export.
    const written = setTrashedAt({}, NOW);
    const writtenKey = Object.keys(written)[0]!;
    expect(isReservedKey(writtenKey)).toBe(true);          // the written key is in the reserved namespace
    expect(userProperties(written)).toEqual({});           // ...and the filter removes exactly it
  });

  it('isTrashed / trashedAt reflect the flag; set then clear round-trips clean', () => {
    const live = userBag();
    expect(isTrashed(live)).toBe(false);
    expect(trashedAt(live)).toBeNull();

    const trashed = setTrashedAt(live, NOW);
    expect(isTrashed(trashed)).toBe(true);
    expect(trashedAt(trashed)).toBe(NOW);

    const restored = setTrashedAt(trashed, null);           // clear = OMIT the key (no residue)
    expect(isTrashed(restored)).toBe(false);
    expect(SYS_TRASHED_AT_KEY in restored).toBe(false);
    expect(restored).toEqual(userBag());
  });

  it('isTrashed is FAIL-SAFE: a corrupt non-date value under the key reads NOT-trashed (stays visible)', () => {
    // secSys-B: a hidden note is data-loss-shaped; a corrupt flag must keep the note visible, not bury it.
    const corrupt: PropertyBag = { [SYS_TRASHED_AT_KEY]: { type: 'boolean', value: true } };
    expect(isTrashed(corrupt)).toBe(false);
    expect(trashedAt(corrupt)).toBeNull();
    // isTrashed and trashedAt never diverge (the predicate is defined via the timestamp).
    const good = setTrashedAt({}, NOW);
    expect(isTrashed(good)).toBe(trashedAt(good) !== null);
  });

  it('setTrashedAt is pure — does not mutate its input', () => {
    const original = userBag();
    setTrashedAt(original, NOW);
    expect(isTrashed(original)).toBe(false);
  });

  it('UserPropertyKeySchema rejects the reserved namespace, accepts ordinary keys (user-input guard)', () => {
    expect(UserPropertyKeySchema.safeParse('status').success).toBe(true);
    expect(UserPropertyKeySchema.safeParse(SYS_TRASHED_AT_KEY).success).toBe(false);
    expect(UserPropertyKeySchema.safeParse(`${RESERVED_KEY_PREFIX}anything`).success).toBe(false);
  });

  it('property.set endpoint REJECTS a reserved key (guardrail-c at the explicit-key write path)', () => {
    // PUT /api/notes/:id/properties/sys:trashedAt must 400 — the server CAN reject here (explicit key
    // param), unlike the upsert path. SetPropertyRequestSchema.key uses UserPropertyKeySchema.
    const noteId = '00000000-0000-4000-8000-000000000001';
    const base = { noteId, value: { type: 'boolean', value: true } as const };
    expect(SetPropertyRequestSchema.safeParse({ ...base, key: SYS_TRASHED_AT_KEY }).success).toBe(false);
    expect(SetPropertyRequestSchema.safeParse({ ...base, key: `${RESERVED_KEY_PREFIX}anything` }).success).toBe(false);
    expect(SetPropertyRequestSchema.safeParse({ ...base, key: 'status' }).success).toBe(true);
  });

  it('SA-9 mutate-boundary guard: a user-originated bag with a reserved key is REJECTED', () => {
    // A buggy/malicious client trying to set the trash flag as a normal property is caught at the
    // user-content write boundary — not merely hidden in the UI.
    const sneaky = setTrashedAt(userBag(), NOW); // bag carrying sys:trashedAt
    expect(containsReservedKey(sneaky)).toBe(true);
    expect(UserPropertyBagSchema.safeParse(sneaky).success).toBe(false);
    // A clean user bag passes.
    expect(containsReservedKey(userBag())).toBe(false);
    expect(UserPropertyBagSchema.safeParse(userBag()).success).toBe(true);
  });

  // ── PIN flag (sys:pinnedAt) — mirrors the trash contract ──────────────────────────────────────
  describe('pin flag (sys:pinnedAt)', () => {
    it('SYS_PINNED_AT_KEY is reserved and stripped by userProperties (UI-hide + export-exclude)', () => {
      expect(isReservedKey(SYS_PINNED_AT_KEY)).toBe(true);
      const bag = setPinnedAt(userBag(), NOW);
      expect(userProperties(bag)).toEqual(userBag());
      expect(SYS_PINNED_AT_KEY in userProperties(bag)).toBe(false);
    });

    it('isPinned / pinnedAt reflect the flag; set then clear round-trips clean (no residue)', () => {
      const live = userBag();
      expect(isPinned(live)).toBe(false);
      expect(pinnedAt(live)).toBeNull();

      const pinned = setPinnedAt(live, NOW);
      expect(isPinned(pinned)).toBe(true);
      expect(pinnedAt(pinned)).toBe(NOW);

      const unpinned = clearPinned(pinned); // clear = OMIT the key
      expect(isPinned(unpinned)).toBe(false);
      expect(SYS_PINNED_AT_KEY in unpinned).toBe(false);
      expect(unpinned).toEqual(userBag());
    });

    it('isPinned is FAIL-SAFE: a corrupt non-date value reads NOT-pinned', () => {
      const corrupt: PropertyBag = { [SYS_PINNED_AT_KEY]: { type: 'boolean', value: true } };
      expect(isPinned(corrupt)).toBe(false);
      expect(pinnedAt(corrupt)).toBeNull();
    });

    it('setPinnedAt is pure — does not mutate its input', () => {
      const original = userBag();
      setPinnedAt(original, NOW);
      expect(isPinned(original)).toBe(false);
    });

    it('a bag carrying sys:pinnedAt fails the user-input mutate-boundary guard (SA-9 class)', () => {
      const sneaky = setPinnedAt(userBag(), NOW);
      expect(containsReservedKey(sneaky)).toBe(true);
      expect(UserPropertyBagSchema.safeParse(sneaky).success).toBe(false);
    });

    it('duplicate behavior: userProperties strips BOTH pin and trash → a copy is live + unpinned', () => {
      // Mirrors how mutateNotes.duplicate strips reserved keys — a duplicated pinned/trashed note is clean.
      const bag = setPinnedAt(setTrashedAt(userBag(), NOW), NOW);
      const dup = userProperties(bag);
      expect(isPinned(dup)).toBe(false);
      expect(isTrashed(dup)).toBe(false);
      expect(dup).toEqual(userBag());
    });
  });

  // ── CUSTOM order (sys:notebookOrder) — fractional index ───────────────────────────────────────
  describe('custom order (sys:notebookOrder)', () => {
    it('SYS_NOTEBOOK_ORDER_KEY is reserved and stripped by userProperties', () => {
      expect(isReservedKey(SYS_NOTEBOOK_ORDER_KEY)).toBe(true);
      const bag = setNotebookOrder(userBag(), 1.5);
      expect(userProperties(bag)).toEqual(userBag());
    });

    it('notebookOrder reads the number; set then clear round-trips clean', () => {
      expect(notebookOrder(userBag())).toBeNull();
      const ordered = setNotebookOrder(userBag(), 2.25);
      expect(notebookOrder(ordered)).toBe(2.25);
      const cleared = setNotebookOrder(ordered, null);
      expect(notebookOrder(cleared)).toBeNull();
      expect(SYS_NOTEBOOK_ORDER_KEY in cleared).toBe(false);
    });

    it('notebookOrder is FAIL-SAFE: a non-number value reads null', () => {
      const corrupt: PropertyBag = { [SYS_NOTEBOOK_ORDER_KEY]: { type: 'text', value: 'x' } };
      expect(notebookOrder(corrupt)).toBeNull();
    });
  });
});
