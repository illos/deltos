/**
 * SessionsSection — the "Active sessions" Settings surface (Phase-2 credential lifecycle).
 *
 * The kill-switch: lists the account's active login sessions (each a sign-in on a device), badges the
 * device the user is on as "This device", and lets the owner sign out any single session or every OTHER
 * session at once. Revoking a session signs that device out immediately. Revoking the CURRENT session is
 * allowed but warned — it signs the user out on this device. "Sign out everywhere else" never touches the
 * current session (the server keeps it by construction).
 *
 * RESIDENCY (lazy off-track route): statically imported only by SettingsRoute, which is itself
 * `lazy()`-loaded in App.tsx, so it rides the settings chunk and never touches the mobile first-load
 * bundle. Its network client (`sessionsClient`) is likewise off the entry chunk.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  listSessions,
  revokeSession,
  signOutOthers,
  SessionError,
  type LoginSession,
} from '../lib/sessionsClient.js';

function formatDate(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function messageFor(err: unknown): string {
  if (err instanceof SessionError) return err.message;
  return 'Something went wrong — try again.';
}

export function SessionsSection() {
  const [sessions, setSessions] = useState<LoginSession[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [confirmOthers, setConfirmOthers] = useState(false);
  const [revokingOthers, setRevokingOthers] = useState(false);

  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
      setSessions(await listSessions());
    } catch (err) {
      setSessions([]);
      setLoadError(messageFor(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleRevoke = async (familyId: string) => {
    setRevoking(familyId);
    try {
      await revokeSession(familyId);
      setConfirmRevoke(null);
      await refresh();
    } catch (err) {
      setLoadError(messageFor(err));
    } finally {
      setRevoking(null);
    }
  };

  const handleSignOutOthers = async () => {
    setRevokingOthers(true);
    try {
      await signOutOthers();
      setConfirmOthers(false);
      await refresh();
    } catch (err) {
      setLoadError(messageFor(err));
    } finally {
      setRevokingOthers(false);
    }
  };

  const hasOthers = (sessions ?? []).some((s) => !s.current);

  return (
    <section className="settings__section" aria-label="Active sessions">
      <h2 className="settings__section-title">Active sessions</h2>
      <p className="settings__row-hint">
        Devices currently signed in to your account. Sign out any session you don&rsquo;t recognise —
        that device loses access immediately.
      </p>

      {/* ── Sessions list ─────────────────────────────────────────────────── */}
      {sessions === null ? (
        <div className="settings__row">
          <div className="auth__spinner" aria-label="Loading sessions…" />
        </div>
      ) : sessions.length === 0 ? (
        <div className="settings__row">
          <span className="settings__row-label settings__row-label--lede">No active sessions.</span>
        </div>
      ) : (
        sessions.map((s) => {
          const isConfirming = confirmRevoke === s.familyId;
          const isRevoking = revoking === s.familyId;
          const name = s.label || 'Unknown device';
          return (
            <div key={s.familyId} className="settings__row">
              <span className="settings__token-row-main">
                <span className="settings__row-label">
                  {name}
                  {s.current && <span className="settings__row-meta"> · This device</span>}
                </span>
                <span className="settings__token-meta">Signed in {formatDate(s.createdAt)}</span>
              </span>
              {isConfirming ? (
                <>
                  <button
                    className="settings__row-action"
                    onClick={() => void handleRevoke(s.familyId)}
                    disabled={isRevoking}
                    aria-label={`Confirm sign out ${name}`}
                  >
                    {isRevoking ? 'Signing out…' : s.current ? 'Sign out this device' : 'Confirm'}
                  </button>
                  <button
                    className="settings__row-action"
                    onClick={() => setConfirmRevoke(null)}
                    disabled={isRevoking}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  className="settings__row-action"
                  onClick={() => setConfirmRevoke(s.familyId)}
                  aria-label={`Sign out ${name}`}
                >
                  Sign out
                </button>
              )}
            </div>
          );
        })
      )}

      {/* The current-session revoke is allowed but warned — it signs the user out on THIS device. */}
      {sessions !== null &&
        confirmRevoke !== null &&
        sessions.find((s) => s.familyId === confirmRevoke)?.current && (
          <p className="settings__row-hint">
            This will sign you out on <strong>this device</strong> — you&rsquo;ll re-enter your username
            and password to sync here again.
          </p>
        )}

      {/* ── Sign out everywhere else (only when there's ≥1 other session) ──── */}
      {hasOthers &&
        (confirmOthers ? (
          <div className="settings__row settings__row--btn-group">
            <p className="settings__confirm-body">
              Sign out every other device? They&rsquo;ll need to sign in again. This device stays signed in.
            </p>
            <button
              className="settings__action settings__action--danger"
              onClick={() => void handleSignOutOthers()}
              disabled={revokingOthers}
            >
              {revokingOthers ? 'Signing out…' : 'Sign out everywhere else'}
            </button>
            <button
              className="settings__action"
              onClick={() => setConfirmOthers(false)}
              disabled={revokingOthers}
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            className="settings__action settings__action--everywhere"
            onClick={() => setConfirmOthers(true)}
          >
            Sign out everywhere else
          </button>
        ))}

      {loadError && (
        <div className="settings__row settings__row--btn-group">
          <p className="settings__error">{loadError}</p>
          <button className="settings__row-action" onClick={() => void refresh()}>
            Retry
          </button>
        </div>
      )}
    </section>
  );
}
