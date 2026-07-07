import { db } from './schema.js';

/**
 * Client-local share-URL memory (ROAD-0011 P2). The server hash-stores each share token (F6) and never
 * re-serves it, so the manage-list from `GET /api/shares` has no url. These helpers remember a minted
 * share's full url ON THIS DEVICE so the in-app sheet can keep showing it with a Copy button.
 *
 * ACCOUNT-ISOLATED (compound PK [accountId+shareId]): every call scopes on the resident accountId, so one
 * account can never read another's share urls, and `wipeLocalState` drops the whole table on account switch
 * / logout (db/accountScope.ts). An unauthed (accountId===null) caller is a no-op — nothing to scope to.
 * NO server change: the url lives only here; the server custody model stays hash-only.
 */

/** Remember a minted share's url for `accountId`. Idempotent (compound PK). No-op if accountId is null. */
export async function saveShareUrl(accountId: string | null, shareId: string, url: string): Promise<void> {
  if (!accountId) return;
  await db.shareUrls.put({ accountId, shareId, url, createdAt: new Date().toISOString() });
}

/**
 * Load the locally-known urls for a set of shares under `accountId`, as a { shareId → url } map. Shares
 * with no local url (minted on another device, or before this feature) are simply absent from the map.
 * Returns {} for a null accountId or an empty id list (no read).
 */
export async function getShareUrls(
  accountId: string | null,
  shareIds: string[],
): Promise<Record<string, string>> {
  if (!accountId || shareIds.length === 0) return {};
  const rows = await db.shareUrls.bulkGet(shareIds.map((id) => [accountId, id] as [string, string]));
  const out: Record<string, string> = {};
  for (const row of rows) {
    if (row) out[row.shareId] = row.url;
  }
  return out;
}

/** Forget a share's local url (on revoke). No-op if accountId is null or the row is already absent. */
export async function deleteShareUrl(accountId: string | null, shareId: string): Promise<void> {
  if (!accountId) return;
  await db.shareUrls.delete([accountId, shareId]);
}
