/**
 * The engine's VALUE seam (docs/specs/formula-engine.md §3) — the tagged union every computation produces
 * and consumes. v1 ships exactly two arms: `number` (a scalar in the producing type's canonical unit —
 * imperial = inches; the engine itself is unit-blind, locked decision #2) and `error` (a quiet, typed
 * failure — a cycle, an unresolvable reference, a compute fault — never an exception, never a hang).
 *
 * SIZED FOR GROWTH: a future spreadsheet/database plugin adds `text` / `boolean` / `array` / `range` arms
 * by EXTENDING this union — the engine core never pattern-matches on `number` (it only stores values,
 * checks equality, and hands them to resolver.combine / node.compute), so new arms cost zero engine change.
 * Only {@link valuesEqual} needs a comparison line per new arm (unlisted arms conservatively compare
 * unequal, which merely over-recomputes — never corrupts).
 *
 * HOST-AGNOSTIC + PURE: no ProseMirror, no DOM, no editor imports anywhere in src/formula-engine/.
 * Values are NEVER persisted (locked decision #6) — the whole environment is recomputed from the note's
 * formula specs on open, so there is no schema/migration surface here.
 */

/** Why a value is an error. `cycle` = the node sits on a reference cycle; `unresolved` = a reference
 *  named nothing (or a resolved target is missing); `eval` = the compute/combine itself faulted. */
export type ValueErrorCode = 'cycle' | 'unresolved' | 'eval';

export type Value =
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'error'; readonly code: ValueErrorCode };

export function numberValue(value: number): Value {
  return { kind: 'number', value };
}

export function errorValue(code: ValueErrorCode): Value {
  return { kind: 'error', code };
}

export function isErrorValue(v: Value): v is Extract<Value, { kind: 'error' }> {
  return v.kind === 'error';
}

/**
 * Structural equality — the engine's "did this node's value actually change?" test, which gates dirty
 * propagation (an edit that recomputes to the same value stops the ripple there). Add a line per future
 * arm; the default keeps unknown arms "always changed" (safe: extra recompute, never a stale value).
 */
export function valuesEqual(a: Value, b: Value): boolean {
  if (a.kind === 'number' && b.kind === 'number') return Object.is(a.value, b.value);
  if (a.kind === 'error' && b.kind === 'error') return a.code === b.code;
  return false;
}
