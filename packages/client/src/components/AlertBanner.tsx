/**
 * AlertBanner — the top-of-shell alert STRIP host (alert-banner-system.md §5). ONE lightweight host, mounted
 * in BOTH shells, that renders the account's active alerts (server-projected + local) as a strip directly
 * under the top bar. It is the sibling surface to ToastHost / UploadProgressHost.
 *
 * OFF-FIRST-LOAD posture (§5.5, matching ToastHost.tsx:37 / UploadProgressHost.tsx:18): renders `null` when
 * the store is empty → zero DOM, zero cost on a normal day. Static-import is fine because THIS module is a
 * cheap null-render (just the strip + the pub/sub subscription); the only heavy dependency — the Approve/Deny
 * detail — is `React.lazy` (ApprovalSheet), so a read-only day never loads it and it isn't in the entry chunk.
 *
 * STACKING (§5.2): the store already sorts severity-desc → actionable-out-ranks-passive → recency-desc. The
 * banner shows the TOP alert as a full strip; if more are active it shows a "+N more" affordance that opens
 * the same sheet listing the rest. One prominent strip protects the quiet/perf north-star (a stack of strips
 * would shove the whole app down).
 *
 * ACTIONABLE vs PASSIVE (§5.3): a passive alert (`actions: []`) renders as a severity-tinted strip with a ×
 * if dismissible. An actionable alert carries inline buttons per `action` (data-driven) + a "Review" that
 * opens the lazy ApprovalSheet; the buttons POST via alertsClient (§6.4) and resolve the alert server-side.
 */
import { Suspense, lazy, useEffect, useState } from 'react';
import type { Alert } from '@deltos/shared';
import { findAlertKind } from '@deltos/shared';
import { currentAlerts, subscribeAlerts, dismissAlert } from '../lib/alertStore.js';
import { actOnAlert, AlertActionError } from '../lib/alertsClient.js';

// LAZY: the Approve/Deny detail sheet is its own chunk — loaded only when the user taps Review / an action.
const ApprovalSheet = lazy(() => import('./ApprovalSheet.js'));

/** Declarative accent glyph per alert kind (the host maps ALERT_KINDS.glyph → a small text mark). */
const GLYPH: Record<string, string> = { agent: '🤖', storage: '💾', info: 'ℹ', warning: '⚠' };

function glyphFor(alert: Alert): string {
  const def = findAlertKind(alert.kind);
  return (def && GLYPH[def.glyph]) ?? GLYPH.info ?? '';
}

export function AlertBanner() {
  const [alerts, setAlerts] = useState<readonly Alert[]>(currentAlerts);
  // The alert open in the lazy sheet (null = closed). Set by "Review" or by an inline action needing detail.
  const [sheetAlert, setSheetAlert] = useState<Alert | null>(null);
  // Inline actions in flight (per alert id) — disables that strip's buttons.
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => subscribeAlerts(setAlerts), []);

  // If the sheet's alert dropped out of the active set (resolved on a pull), close the sheet.
  useEffect(() => {
    if (sheetAlert && !alerts.some((a) => a.id === sheetAlert.id)) setSheetAlert(null);
  }, [alerts, sheetAlert]);

  if (alerts.length === 0 && sheetAlert === null) return null;

  const top = alerts[0];
  const extra = Math.max(0, alerts.length - 1);

  async function inlineAct(alert: Alert, actionId: 'approve' | 'deny'): Promise<void> {
    if (busyId) return;
    setBusyId(alert.id);
    try {
      await actOnAlert(alert.id, actionId);
      dismissAlert(alert.id); // optimistic; next pull confirms
    } catch (e) {
      if (e instanceof AlertActionError && e.alreadyResolved) {
        dismissAlert(alert.id); // benign — already resolved elsewhere
      } else {
        // On a real error, open the sheet so the user sees the message + can retry with full context.
        setSheetAlert(alert);
      }
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      {top && (
        <div
          className={`alert-banner alert-banner--${top.severity}`}
          role={top.severity === 'critical' ? 'alert' : 'status'}
          aria-live={top.severity === 'critical' ? 'assertive' : 'polite'}
        >
          <span className="alert-banner__glyph" aria-hidden="true">{glyphFor(top)}</span>
          <div className="alert-banner__text">
            <span className="alert-banner__title">{top.title}</span>
            <span className="alert-banner__message">{top.message}</span>
          </div>
          <div className="alert-banner__actions">
            {top.actions.length > 0 ? (
              <>
                {top.actions.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    className={`alert-banner__btn alert-banner__btn--${a.style}`}
                    disabled={busyId !== null}
                    onClick={() => inlineAct(top, a.id === 'deny' ? 'deny' : 'approve')}
                  >
                    {a.label}
                  </button>
                ))}
                <button
                  type="button"
                  className="alert-banner__review"
                  onClick={() => setSheetAlert(top)}
                >
                  Review
                </button>
              </>
            ) : (
              top.dismissible && (
                <button
                  type="button"
                  className="alert-banner__close"
                  aria-label="Dismiss"
                  onClick={() => dismissAlert(top.id)}
                >
                  ×
                </button>
              )
            )}
          </div>
        </div>
      )}

      {extra > 0 && (
        <button
          type="button"
          className="alert-banner__more"
          onClick={() => { const next = alerts[1]; if (next) setSheetAlert(next); }}
        >
          +{extra} more
        </button>
      )}

      {/* Lazy Approve/Deny detail — only mounts (and only downloads its chunk) once opened. */}
      {sheetAlert && (
        <Suspense fallback={null}>
          <ApprovalSheet alert={sheetAlert} onClose={() => setSheetAlert(null)} />
        </Suspense>
      )}
    </>
  );
}
