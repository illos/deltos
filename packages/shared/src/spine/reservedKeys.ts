import { z } from 'zod';
import { PropertyBagSchema, type PropertyBag } from './property.js';

/**
 * Reserved SYSTEM property-key namespace (planSys HARD GUARDRAIL — v1 acceptance item).
 *
 * Some note state is carried IN the property bag so it rides the existing sync `upsert` path with NO
 * wire/protocol change (Fork P — the soft-delete "trash" flag is the first such key). But that state is
 * SYSTEM-OWNED, not user content. Reserved keys live under a single namespace PREFIX so they are
 * unambiguously distinguishable from user-authored properties and can be uniformly:
 *   (a) HIDDEN from the property / frontmatter editing UI,
 *   (b) EXCLUDED from any markdown / frontmatter EXPORT (so a system key can never leak — written now,
 *       even though export is Phase-3, so the leak is impossible by construction), and
 *   (c) NOT settable / deletable by the user as a normal property.
 * The namespace is GENERAL: more system keys (pin, colour, …) will join it. EVERYTHING keys off the
 * prefix via {@link isReservedKey} — never a per-key allow-list — so a new system key is automatically
 * hidden, export-excluded, and user-protected the moment it adopts the prefix.
 *
 * {@link userProperties} is THE single chokepoint for (a) + (b): every user-facing property surface
 * (the editor render, the export serializer) MUST route through it. {@link UserPropertyKeySchema} is the
 * boundary guard for (c). The stored {@link PropertyBag} itself still legitimately CONTAINS reserved
 * keys — so the storage schema is NOT constrained; only the user-input boundary rejects the namespace.
 */
export const RESERVED_KEY_PREFIX = 'sys:' as const;

/**
 * Soft-delete "trash" flag (Fork P). A `date`-typed system property: PRESENT ⇔ the note is in the trash,
 * value = when it was trashed (enables trash-view ordering + a future auto-purge; mirrors `deletedAt`'s
 * shape). Cleared (key removed) ⇔ the note is live. Distinct from the hard `deletedAt` server tombstone —
 * the two coexist (trash = soft/recoverable/synced; deletedAt = permanent).
 */
export const SYS_TRASHED_AT_KEY = `${RESERVED_KEY_PREFIX}trashedAt` as const;

/** True iff `key` is in the reserved system namespace (i.e. NOT a user-authored property). */
export function isReservedKey(key: string): boolean {
  return key.startsWith(RESERVED_KEY_PREFIX);
}

/**
 * The USER-VISIBLE slice of a property bag: every reserved system key removed. THE chokepoint for both
 * the property/frontmatter editing UI (render only this) and markdown/frontmatter EXPORT (emit only
 * this). Route every user-facing property surface through it and a system key can never surface or leak.
 * Pure — returns a new bag, does not mutate the input.
 */
export function userProperties(bag: PropertyBag): PropertyBag {
  const out: PropertyBag = {};
  for (const [k, v] of Object.entries(bag)) {
    if (!isReservedKey(k)) out[k] = v;
  }
  return out;
}

/** The trash timestamp (ISO), or null if the note is not trashed (key absent OR not a valid date value). */
export function trashedAt(bag: PropertyBag): string | null {
  const v = bag[SYS_TRASHED_AT_KEY];
  return v?.type === 'date' ? v.value : null;
}

/**
 * Is this note currently trashed? FAIL-SAFE + consistent with {@link trashedAt}: true ONLY for a
 * well-formed date-typed flag. A corrupt / non-date value under the key reads as NOT trashed, so the
 * note stays VISIBLE in the list rather than being silently hidden (a hidden note is data-loss-shaped;
 * a stray visible one is recoverable). secSys-B list fail-safe (devSys2). Defined via trashedAt so the
 * predicate and the timestamp can never diverge.
 */
export function isTrashed(bag: PropertyBag): boolean {
  return trashedAt(bag) !== null;
}

/**
 * Return a NEW bag with the trash flag SET to `atIso` (trashed) or CLEARED (`null` → live). Setting
 * writes `{ type: 'date', value: atIso }`; clearing REMOVES the key entirely so a restored note carries
 * no trash residue. Pure — does not mutate. Rides the normal `upsert` push (it is just a property edit).
 */
export function setTrashedAt(bag: PropertyBag, atIso: string | null): PropertyBag {
  const { [SYS_TRASHED_AT_KEY]: _drop, ...rest } = bag;
  return atIso === null ? rest : { ...rest, [SYS_TRASHED_AT_KEY]: { type: 'date', value: atIso } };
}

/**
 * Boundary guard for a USER-authored property key: REJECTS the reserved namespace so a user can neither
 * create nor overwrite a system key (guardrail (c)). Use at the user-input edge (the property editor),
 * NOT on the stored bag (which legitimately holds reserved keys). Schema-first: the refinement lives
 * here, on the schema, not at the call site.
 */
export const UserPropertyKeySchema = z
  .string()
  .min(1)
  .refine((k) => !isReservedKey(k), {
    message: `property key must not use the reserved "${RESERVED_KEY_PREFIX}" namespace`,
  });

/** True iff `bag` carries ANY reserved system key — the imperative form of the mutate-boundary guard. */
export function containsReservedKey(bag: PropertyBag): boolean {
  return Object.keys(bag).some(isReservedKey);
}

/**
 * A USER-ORIGINATED property bag — asserts NO reserved key is present (SA-9). The user property-edit
 * MUTATE BOUNDARY (the editor's set-properties write path) MUST validate against this — NOT merely hide
 * reserved keys in the UI — so a buggy or malicious client cannot set/clear a system key (e.g. the trash
 * flag) by writing it as a normal property. The ONLY sanctioned writer of a reserved key is the
 * dedicated helper ({@link setTrashedAt}); user-content writes go through this guard.
 *
 * Fork-P scope note: the trash flag travels the SAME `upsert` as content, so the SERVER cannot
 * distinguish a legitimate trash toggle from a user edit without the protocol awareness Fork P
 * deliberately avoids. SA-9 is therefore a CLIENT mutate-boundary guard (enforced via this schema on the
 * user-content write path), not a server-side invariant — within-account, the documented low-surface
 * trust model (spec §Security) still holds.
 */
export const UserPropertyBagSchema = PropertyBagSchema.refine(
  (bag) => !containsReservedKey(bag),
  { message: `property bag must not contain reserved "${RESERVED_KEY_PREFIX}" keys` },
);
