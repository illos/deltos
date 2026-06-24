import { Link } from 'react-router-dom';
import { useAuthStore } from '../auth/store.js';
import './SessionStatus.css';

/**
 * Quiet, NON-BLOCKING background-session status. Never a gate — the shell is always usable.
 *
 *  - active / booting → renders nothing. SyncIndicator covers the transport state.
 *  - offline (#85) → renders nothing here; the SyncIndicator shows 'Offline — changes saved locally' and
 *    sync AUTO-resumes on reconnect. Deliberately NOT a 'sign in' nudge (no re-login needed).
 *  - revoked (#89) → a DISTINCT 'Signed out — sign in to resume sync' nudge: the cookie was revoked/expired,
 *    sync is hard-gated, and resuming needs a FULL login (a revoked cookie can't refresh). Explicit user
 *    action, never auto-resume — the visible difference from the offline-transient mode.
 *  - unauthed → a tappable 'Sign in to sync' nudge (the refresh cookie expired mid-session). Rare + non-blocking.
 */
export function SessionStatus() {
  const sessionState = useAuthStore((s) => s.sessionState);
  if (sessionState === 'revoked') {
    return (
      <Link
        to="/login"
        className="session-status session-status--needs-unlock"
        title="Sign in to resume sync"
      >
        Signed out — sign in to resume sync
      </Link>
    );
  }
  if (sessionState !== 'unauthed') return null;
  return (
    <Link
      to="/login"
      className="session-status session-status--needs-unlock"
      title="Tap to sign in and resume sync"
    >
      Sign in to sync
    </Link>
  );
}
