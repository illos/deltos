import type { DbAdapter } from './schema.js';

/**
 * Account-scoped settings on the `accounts` row (migration 0019+). Free functions over a `DbAdapter` — so
 * BOTH the owner-authed REST routes (`routes/account.ts`) AND the MCP `list_notebooks` tool (which only
 * holds a `DbAdapter`, never the auth store) read the same one implementation. accountId is ALWAYS the
 * server-derived principal.id — never a body field (BOLA-safe: every query is `WHERE accountId = ?`).
 */

/** The owner's note routing guide (freeform text), or null when unset. */
export async function getAccountRoutingGuide(db: DbAdapter, accountId: string): Promise<string | null> {
  const row = await db.first<{ noteRoutingGuide: string | null }>(
    `SELECT noteRoutingGuide FROM accounts WHERE accountId = ?`,
    [accountId],
  );
  return row?.noteRoutingGuide ?? null;
}

/** Set (or clear, with null) the owner's note routing guide. Account-scoped write. */
export async function setAccountRoutingGuide(
  db: DbAdapter,
  accountId: string,
  guide: string | null,
): Promise<void> {
  await db.batch([
    { sql: `UPDATE accounts SET noteRoutingGuide = ? WHERE accountId = ?`, params: [guide, accountId] },
  ]);
}
