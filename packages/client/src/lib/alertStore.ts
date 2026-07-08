/**
 * alertStore — the client's single, durable in-app ALERT store (docs/design/alert-banner-system.md §4.3).
 *
 * A SIBLING of the transient toast pub/sub (lib/toastEvents.ts:24-71) — same bones (`_listeners` Set +
 * module-level state + `_notify` + `subscribe`), DIFFERENT lifecycle: an alert is DURABLE (no auto-TTL) and
 * server-driven-presence. Do NOT overload the toast host with these; a toast is a 4.5s transient, an alert
 * persists until it resolves/dismisses (toastEvents.ts:11 TTL vs. here: none).
 *
 * TWO provenances, one ordered list:
 *   - SERVER alerts ride the sync-pull `alerts` array and are REPLACED WHOLESALE each pull
 *     (setServerAlerts, called from syncEngine.ts). Alerts are a CURRENT-STATE PROJECTION, not a merged/
 *     tombstoned stream (§4.1): a resolved/expired alert simply stops appearing on the next pull. There is
 *     NO Dexie table and NO merge — last-writer-wins on the whole set.
 *   - LOCAL alerts (client-originated notices) are added/removed individually via showAlert/removeAlert.
 *
 * SESSION-LOCAL DISMISS: `dismissAlert(id)` hides an alert client-side for this session (a `Set` of ids). For
 * a server actionable alert the ACTION (Approve/Deny) resolves it server-side so it stops projecting; the
 * session dismiss is the passive-alert × affordance. Dismissal is intentionally NOT persisted (projection
 * model, §4.1) — a dismissed condition that re-crosses its threshold re-appears.
 *
 * RESIDENCY: entry-bundle-safe. This module is tiny (pub/sub + arrays), exactly like toastEvents.ts — no
 * heavy imports, no React. `import type` only pulls the erased `Alert` type from @deltos/shared (no zod
 * runtime tags along). The heavy Approve/Deny detail is a React.lazy sheet, loaded only when the user acts.
 */
import type { Alert } from '@deltos/shared';

type AlertListener = (alerts: readonly Alert[]) => void;

const _listeners = new Set<AlertListener>();
/** Last projection from the sync-pull (replaced wholesale each pull — §4.1). */
let _server: readonly Alert[] = [];
/** Client-originated alerts (added / removed individually). */
let _local: readonly Alert[] = [];
/** Ids the user dismissed THIS SESSION — a client-side hide (not persisted). */
const _dismissed = new Set<string>();

/**
 * Merge the two provenances into ONE ordered, de-duped, dismiss-filtered snapshot.
 * Order (§5.2): severity desc (critical > warning > info), then ACTIONABLE out-ranks passive at equal
 * severity (an approval never hides behind a storage notice), then recency desc (newest first).
 * De-dupe on `id` (server wins over local for a shared id) so a stable-id alert can't double-render.
 */
const SEVERITY_RANK: Record<string, number> = { critical: 2, warning: 1, info: 0 };

function _merged(): readonly Alert[] {
  const byId = new Map<string, Alert>();
  // local first, then server — so a server alert of the same id overwrites the local one.
  for (const a of _local) byId.set(a.id, a);
  for (const a of _server) byId.set(a.id, a);
  return [...byId.values()]
    .filter((a) => !_dismissed.has(a.id))
    .sort((a, b) => {
      const sev = (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0);
      if (sev !== 0) return sev;
      const act = (b.actions.length > 0 ? 1 : 0) - (a.actions.length > 0 ? 1 : 0);
      if (act !== 0) return act;
      return b.createdAt - a.createdAt; // newest first
    });
}

function _notify(): void {
  const snapshot = _merged();
  _listeners.forEach((fn) => fn(snapshot));
}

/**
 * REPLACE the server projection wholesale (§4.1). Called by syncEngine after each pull with
 * `json.alerts ?? []`. Defensive by design: an absent/empty array (old server) is a no-op that clears the
 * set — it never throws.
 */
export function setServerAlerts(alerts: readonly Alert[] | undefined | null): void {
  _server = Array.isArray(alerts) ? alerts : [];
  _notify();
}

/** Local producer API — push a client-originated notice (source:'client'). De-dupes on id. */
export function showAlert(alert: Alert): void {
  _local = [..._local.filter((a) => a.id !== alert.id), alert];
  _notify();
}

/** Remove a client-originated alert by id (the producer's own clear — distinct from a user dismiss). */
export function removeAlert(id: string): void {
  _local = _local.filter((a) => a.id !== id);
  _notify();
}

/**
 * User dismiss — hides the alert client-side for this session. For a server actionable alert this only
 * collapses the strip locally; the underlying request stays pending server-side (Approve/Deny resolves it).
 * For a passive/local alert it also drops any local copy.
 */
export function dismissAlert(id: string): void {
  _dismissed.add(id);
  _local = _local.filter((a) => a.id !== id);
  _notify();
}

/** Subscribe to the merged alert list. Fires immediately with the current snapshot. Returns unsubscribe. */
export function subscribeAlerts(fn: AlertListener): () => void {
  _listeners.add(fn);
  fn(_merged());
  return () => _listeners.delete(fn);
}

/** Sync snapshot for `useState(currentAlerts)` initial state (mirrors toastEvents.getToasts). */
export function currentAlerts(): readonly Alert[] {
  return _merged();
}

/** TEST-ONLY: reset all module state between tests (server/local/dismissed). Not used in app code. */
export function __resetAlertStore(): void {
  _server = [];
  _local = [];
  _dismissed.clear();
  _notify();
}
