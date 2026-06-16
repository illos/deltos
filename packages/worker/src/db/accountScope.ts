import type { RequestPrincipal } from '@deltos/shared';
import type { AppContext } from '../context.js';
import type { DbAdapter, NoteRow } from './schema.js';

/**
 * accountScope — THE per-query account dimension. The PRIMARY, fail-closed cross-account control
 * (docs/design/account-identity-strawman.md §5; secSys S6). Route-owners (scopeSys notes / devSys2
 * sync) funnel every data read + write through these helpers so no handler can forget the account
 * filter — a forgotten `can()` arg cannot bypass it, because the filter is in the SQL itself.
 *
 * ⚠ LOAD-BEARING SEMANTIC (planSys binding condition). After the zero-delta re-point (migration 0003),
 *   `principal.id` MEANS `accountId` — the stable, random, credential-INDEPENDENT account key — NOT
 *   `accountFingerprint`. The credential id lives on `devices.accountFingerprint` / `grants.mintedByKeyId`
 *   / `accountCredentials`. NEVER read a credential fingerprint off `principal.id`. This file is the one
 *   place that turns a principal into an account scope, so the rule is enforced here, once.
 *
 * Two-layer model: this data-layer scope is PRIMARY (physical row isolation — A's and B's "notebook-X"
 * are distinct invisible rows under `(accountId, notebookId)`); the `can()` ownership assertion
 * (see `grantAllows`' `resourceAccountId` belt in auth.ts) is defense-in-depth on top.
 */

/**
 * The caller's account — the single source of truth for BOTH read-scoping and write-stamping. It is
 * `principal.id` (re-pointed to `accountId`). Fail-closed: a principal with no account is unusable for
 * data access (an empty id can never match a stamped row), so it is rejected here rather than silently
 * scoping to "" and matching nothing by accident.
 */
export function callerAccountId(principal: RequestPrincipal): string {
  const accountId = principal.id;
  if (!accountId) {
    // Unreachable for a schema-valid principal (id is min(1)); a defensive fail-closed assertion so a
    // future regression that constructs an account-less principal cannot reach the data layer unscoped.
    throw new Error('accountScope: principal has no accountId — refusing unscoped data access');
  }
  return accountId;
}

/**
 * THE single chokepoint for getting the caller's account inside a handler. `guard()` sets the resolved,
 * authorized principal on the context; this reads it and returns the `accountId` to scope/stamp by.
 * Fail-closed: if no principal was set (a handler reached outside the guard, or guard regressed), it
 * THROWS rather than returning an empty scope. Both notes (scopeSys) and sync (devSys2) handlers use
 * THIS — identically — so the account dimension is surfaced one way, never two divergent ways.
 */
export function requireAccountId(c: AppContext): string {
  const principal = c.get('principal');
  if (!principal) {
    throw new Error('accountScope: no principal on context — requireAccountId() must run inside guard()');
  }
  return callerAccountId(principal);
}

/** The value a write path stamps as the owning account — server-side, from the principal, NEVER a body field. */
export function stampAccountId(principal: RequestPrincipal): string {
  return callerAccountId(principal);
}

/**
 * Account-scoped single-note read (id-keyed CRUD). Returns the note ONLY if it belongs to `accountId`;
 * a note owned by another account returns null — indistinguishable from not-found, so there is no
 * cross-account existence oracle. This REPLACES bare `WHERE id = ?` reads in the note routes.
 */
export async function getNoteForAccount(
  db: DbAdapter,
  accountId: string,
  id: string,
): Promise<NoteRow | null> {
  return db.first<NoteRow>(
    `SELECT * FROM notes WHERE id = ? AND accountId = ? AND deletedAt IS NULL`,
    [id, accountId],
  );
}

/** Same, but includes tombstones (for delete/CAS paths that must see soft-deleted rows). */
export async function getNoteForAccountIncludingDeleted(
  db: DbAdapter,
  accountId: string,
  id: string,
): Promise<NoteRow | null> {
  return db.first<NoteRow>(`SELECT * FROM notes WHERE id = ? AND accountId = ?`, [id, accountId]);
}

/**
 * The SQL fragment + bound param for the notebookId-keyed paths (sync push/pull, search) that the
 * cross-account sweep flagged. Append `AND ${ACCOUNT_CLAUSE}` to those queries and add `accountId`
 * to the params — so a notebookId never resolves across accounts.
 */
export const ACCOUNT_CLAUSE = 'accountId = ?';

/**
 * The ownership BELT comparator (defense-in-depth, secSys S6). Does a fetched row belong to the
 * caller's account? Used by the `can()` belt (`grantAllows` `resourceAccountId`) and by any
 * fetch-then-act handler. A NULL row account (un-backfilled / unstamped) is NEVER owned — fail-closed.
 */
export function ownedByAccount(rowAccountId: string | null, accountId: string): boolean {
  return rowAccountId !== null && rowAccountId === accountId;
}
