/**
 * ApprovalSheet — the LAZY Approve/Deny detail for an ACTIONABLE alert (alert-banner-system.md §5.1, §6.4).
 *
 * Built on the ContextMenuSheet overlay LANGUAGE (components/ContextMenuSheet.tsx:41-64): a bottom-sheet over
 * a dimmed + blurred backdrop, `role="dialog" aria-modal`, backdrop-tap + Escape dismiss, `inert` when closed,
 * a grabber, and thumb-zone action buttons at the bottom. It reuses the `.context-menu*` CSS classes so the
 * geometry/blur/animation match the app's other sheets exactly (no hand-rolled overlay — CONV-0015 reuse).
 *
 * LAZY: this is the ONLY heavy dependency of the alert surface, so it is `React.lazy`-split (AlertBanner
 * imports it via `lazy(() => import('./ApprovalSheet.js'))`). On a read-only day it never loads; once loaded
 * it is SW-precached ([[plugins-lazy-past-first-paint]]).
 *
 * It shows the agent's ask VERBATIM (count + reason — the human seeing scale+intent IS the injection
 * defence, §6.1) and, on Approve/Deny, POSTs to the generic action endpoint (alertsClient.actOnAlert). On
 * success the alert resolves server-side and drops off the next pull; we also optimistically dismiss it. A
 * 409 (already resolved / expired) is treated as a benign clear, not an error. A network error stays on the
 * sheet with a retry-able message.
 */
import { useEffect, useState } from 'react';
import type { Alert } from '@deltos/shared';
import { actOnAlert, AlertActionError } from '../lib/alertsClient.js';
import { dismissAlert } from '../lib/alertStore.js';

interface ApprovalSheetProps {
  /** The actionable alert being reviewed. null → the sheet is closed (renders the parked overlay). */
  alert: Alert | null;
  onClose: () => void;
}

export default function ApprovalSheet({ alert, onClose }: ApprovalSheetProps) {
  const open = alert !== null;
  const [busy, setBusy] = useState<string | null>(null); // the actionId in flight (disables both buttons)
  const [error, setError] = useState<string | null>(null);

  // Escape closes (mirrors ContextMenuSheet.tsx:34-39). Reset transient state whenever the sheet reopens.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setBusy(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  async function act(actionId: 'approve' | 'deny'): Promise<void> {
    if (!alert || busy) return;
    setBusy(actionId);
    setError(null);
    try {
      await actOnAlert(alert.id, actionId);
      dismissAlert(alert.id); // optimistic: clear now; the next pull confirms it's gone
      onClose();
    } catch (e) {
      if (e instanceof AlertActionError && e.alreadyResolved) {
        // Already resolved/expired elsewhere — clear it and close, not an error worth showing.
        dismissAlert(alert.id);
        onClose();
        return;
      }
      setError(e instanceof Error ? e.message : 'Something went wrong — try again.');
      setBusy(null);
    }
  }

  return (
    <div className={`context-menu${open ? ' context-menu--open' : ''}`} aria-hidden={!open}>
      <div className="context-menu__backdrop" onClick={onClose} aria-hidden="true" />
      <div
        className="context-menu__panel"
        role="dialog"
        aria-modal="true"
        aria-label="Review request"
        inert={!open}
      >
        <div className="context-menu__grabber" aria-hidden="true">
          <span className="context-menu__grabber-bar" />
        </div>
        <div className="context-menu__body context-menu__body--menu">
          {alert && (
            <div className="approval-sheet">
              <h2 className="approval-sheet__title">{alert.title}</h2>
              <p className="approval-sheet__message">{alert.message}</p>
              {error && <p className="approval-sheet__error" role="alert">{error}</p>}
            </div>
          )}
        </div>
        {/* Thumb-zone actions — driven by the alert's declared `actions` (data, not code). */}
        {alert && (
          <div className="approval-sheet__actions">
            {alert.actions.map((a) => (
              <button
                key={a.id}
                type="button"
                className={`approval-sheet__btn approval-sheet__btn--${a.style}`}
                disabled={busy !== null}
                onClick={() => act(a.id === 'deny' ? 'deny' : 'approve')}
              >
                {busy === a.id ? '…' : a.label}
              </button>
            ))}
          </div>
        )}
        <button type="button" className="context-menu__close" onClick={onClose} disabled={busy !== null}>
          Close
        </button>
      </div>
    </div>
  );
}
