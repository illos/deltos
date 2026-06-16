import { Link } from 'react-router-dom';
import { useAuthStore } from '../auth/store.js';
import './SessionStatus.css';

/**
 * Quiet, NON-BLOCKING background-session status (spec Part 1a §Behavior 2–3). It is NEVER a gate:
 * the notes shell is fully usable on local data regardless of session state.
 *
 *  - active / establishing / booting / offline → renders nothing. A healthy (or merely transiently
 *    offline) session is invisible; sync transport state — pending / syncing / offline — is the
 *    SyncIndicator's job. This component is strictly the AUTH nudge.
 *  - needs-unlock → a tappable nudge routing to the unlock gesture. For Part 1a the at-rest key
 *    unwrap still needs a gesture; Part 1b (Option-A autoUnlock) makes re-auth silent and this nudge
 *    will rarely appear.
 */
export function SessionStatus() {
  const sessionState = useAuthStore((s) => s.sessionState);
  if (sessionState !== 'needs-unlock') return null;
  return (
    <Link
      to="/unlock"
      className="session-status session-status--needs-unlock"
      title="Tap to sign in and resume sync"
    >
      Sign in to sync
    </Link>
  );
}
