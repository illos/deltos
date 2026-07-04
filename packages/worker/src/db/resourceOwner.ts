import type { Resource } from '@deltos/shared';
import type { ResolveResourceOwner, ResourceOwner } from '../auth.js';
import type { DbAdapter } from './schema.js';

/**
 * resourceOwner — THE owner-resolver (ROAD-0011 P1 §1): given a `Resource`, return its owning `accountId`
 * and (for coverage) the notebook it currently belongs to, or null when it does not exist. One clean,
 * reusable implementation — the SAME resolver §2/§3 (sharing) and §4 (RTC) will build on, injected into
 * {@link canWith} so the account-less chokepoint can decide notebook→note hierarchy coverage.
 *
 * LIVE SEMANTICS: coverage follows the resource's CURRENT state — a note's answer carries its current
 * `notebookId` (move it out of a granted notebook and the token loses it), and a hard-deleted note/notebook
 * (deletedAt set) resolves to null → fail-closed deny. Trashed-but-live notes (the recoverable `sys:trashedAt`
 * property flag) are still live rows and resolve normally. It reads rows account-AGNOSTICALLY (no caller
 * scope) precisely so the ownership BELT in canWith can compare the TRUE owner to the grant's account.
 */
export function createResourceOwnerResolver(db: DbAdapter): ResolveResourceOwner {
  return async (resource: Resource): Promise<ResourceOwner | null> => {
    switch (resource.kind) {
      case 'workspace':
        // A workspace resource has no single owning row — it is the caller's own account by construction.
        // canWith never resolves it (workspace coverage is decided without an owner).
        return null;
      case 'notebook': {
        const row = await db.first<{ accountId: string | null }>(
          `SELECT accountId FROM notebooks WHERE id = ? AND deletedAt IS NULL`,
          [resource.id],
        );
        if (!row || row.accountId === null) return null;
        return { accountId: row.accountId, notebookId: resource.id };
      }
      case 'note': {
        const row = await db.first<{ accountId: string | null; notebookId: string | null }>(
          `SELECT accountId, notebookId FROM notes WHERE id = ? AND deletedAt IS NULL`,
          [resource.id],
        );
        if (!row || row.accountId === null) return null;
        return { accountId: row.accountId, notebookId: row.notebookId };
      }
      default:
        return null;
    }
  };
}
