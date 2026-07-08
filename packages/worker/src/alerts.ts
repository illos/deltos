import type { Alert } from '@deltos/shared';
import type { AuthStore, WriteApprovalRow } from './db/authStore.js';

/**
 * SERVER-SIDE ALERT PROJECTION (alert-banner-system.md §4.1) — computes the `alerts` array the sync-pull
 * returns, FRESH on every pull, for `(accountId, requesting-token)`. Alerts are ephemeral CURRENT STATE,
 * not a versioned/tombstoned sync entity: the client replaces its server-alert set wholesale each pull, so a
 * resolved/expired alert simply stops appearing (no Dexie table, no merge, no cursor arm).
 *
 * RESIDENCY: worker — it reads the account's D1 (`agentWriteApprovals`) and the (future) storage ratio; it
 * takes its `AuthStore`/`accountId` by argument, so account isolation is inherited (it never reads anything
 * the caller doesn't own — `accountId` is server-derived at the pull chokepoint).
 *
 * EXTENSIBILITY: a new server alert PRODUCER is one branch here (union its rows into the array), keyed to a
 * declared `ALERT_KINDS` entry in @deltos/shared. Consumer #2 (storage warning) is DESIGNED-FOR but NOT
 * built — its clean seam is marked below.
 */

/** How long a pending write-approval request stays actionable before it self-expires (§6.3). */
export const WRITE_APPROVAL_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * The active alerts for this account+token, RIGHT NOW. Unions:
 *   (a) pending, unexpired `agentWriteApprovals` for the caller's token → ACTIONABLE alerts (Approve/Deny);
 *   (b) [SEAM] computed status alerts (storage) → passive alerts — NOT built (see §7).
 *
 * `tokenGroupId` scopes the actionable-approval alerts to the REQUESTING token so a second token doesn't see
 * (and can't act to lift) another token's ask. Passing `null` (a session/legacy row with no group) surfaces
 * no token-scoped approvals — correct: a request is always minted with a concrete tokenGroupId.
 */
export async function getActiveAlerts(
  store: AuthStore,
  accountId: string,
  tokenGroupId: string | null,
  nowMs: number,
): Promise<Alert[]> {
  const alerts: Alert[] = [];

  // (a) Agent bulk-write approval — pending asks the human can Approve/Deny. Scoped to the requesting token.
  const pending = await store.listPendingWriteApprovals(accountId, nowMs);
  for (const row of pending) {
    if (tokenGroupId !== null && row.tokenGroupId !== tokenGroupId) continue;
    alerts.push(writeApprovalAlert(row));
  }

  // (b) STORAGE-WARNING SEAM (Consumer #2, alert-banner-system.md §7) — DESIGNED-FOR, NOT BUILT. When it
  // lands, it is ONE branch here: read the cached R2 usage ratio (blobStore.accountUsage, computed on
  // write/cron) and, when `used >= 0.95 * quota`, push a PASSIVE alert
  //   { id: 'storage.quota', kind: 'storage.quota', severity: 'warning', source: 'server',
  //     title: 'Storage almost full', message: '…', dismissible: true, actions: [], targetKind: null,
  //     targetId: null, createdAt: nowMs, expiresAt: null }
  // through this SAME array — zero new schema/carrier/surface. Its stable id de-dupes across pulls; when
  // usage drops back under threshold the branch omits it → it drops off automatically. Left as a comment so
  // adding the producer is a one-branch declaration, per the "it just slots in" proof.

  return alerts;
}

/** A pending write-approval row → the actionable alert the human sees (scale + intent, Approve/Deny). */
export function writeApprovalAlert(row: WriteApprovalRow): Alert {
  return {
    id: row.id,
    kind: 'agent.writeApproval',
    severity: 'warning',
    source: 'server',
    title: 'Agent wants to write more',
    message: `This agent wants to make ~${row.requestedCount} writes: ${row.reason}`,
    createdAt: row.createdAt,
    dismissible: false, // an approval must be acted on (Approve/Deny) — not silently hidden (§5.4)
    expiresAt: row.expiresAt,
    actions: [
      { id: 'approve', label: 'Approve', style: 'primary' },
      { id: 'deny', label: 'Deny', style: 'danger' },
    ],
    targetKind: 'writeApproval',
    targetId: row.id,
  };
}
