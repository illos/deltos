import { Link } from 'react-router-dom';
import { useAuthStore } from '../auth/store.js';
import './SessionStatus.css';

/**
 * Quiet, NON-BLOCKING background-session status. Never a gate — the shell is always usable.
 *
 *  - active / booting / offline → renders nothing. SyncIndicator covers the transport state.
 *  - unauthed → a tappable nudge. The refresh cookie has expired; the user needs to log in again
 *    to re-establish sync. This is rare (30–90d sliding window) and non-blocking.
 */
export function SessionStatus() {
  const sessionState = useAuthStore((s) => s.sessionState);
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
