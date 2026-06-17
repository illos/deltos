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
  isReservedKey,
  userProperties,
  isTrashed,
  trashedAt,
  setTrashedAt,
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
});
