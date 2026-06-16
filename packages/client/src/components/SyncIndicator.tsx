import { useEffect, useState } from 'react';
import { getSyncState, subscribeSyncState } from '../lib/syncEngine.js';
import type { SyncIndicatorState } from '../lib/syncEngine.js';
import { useSyncQueueCount } from '../db/storeHooks.js';
import { useAuthStore } from '../auth/store.js';
import './SyncIndicator.css';

type EffectiveState = SyncIndicatorState | 'local-only';

/**
 * Human-readable label for each sync state. Queue count replaces the label when pending.
 *
 * 'local-only' is not a SyncIndicatorState from the engine — it's the honest display when the
 * engine reports 'idle' but no session is active (= sync has never actually run this session).
 */
const STATE_LABEL: Record<EffectiveState, string> = {
  'local-only': 'local only',
  idle:         'synced',
  syncing:      'syncing',
  pending:      'pending',
  offline:      'offline',
  error:        'error',
};

/** Tooltip shown on hover — more descriptive than the terse pill label. */
const STATE_TITLE: Record<EffectiveState, string> = {
  'local-only': 'Notes saved locally — sign in to sync',
  idle:         'All changes synced',
  syncing:      'Syncing with server…',
  pending:      'Unsaved changes queued',
  offline:      'Offline — changes saved locally',
  error:        'Last sync failed — will retry',
};

/**
 * Shell header badge that reflects the true server-sync state.
 *
 * 'synced' is shown ONLY when the session is active AND the engine confirms a successful
 * round-trip (idle after push+pull). Without an active session the engine sits at 'idle'
 * not because sync succeeded but because sync never ran — display 'local only' instead so
 * the user can trust the pill as an honest signal of server-sync state.
 */
export function SyncIndicator() {
  const [state, setState] = useState<SyncIndicatorState>(getSyncState);
  const queueCount = useSyncQueueCount();
  const sessionState = useAuthStore((s) => s.sessionState);

  useEffect(() => subscribeSyncState(setState), []);

  // Engine 'idle' means "no pending work" — but that's only trustworthy as "synced" when
  // the session is active and a real server round-trip has completed. Without an active
  // session, idle means sync never ran; show 'local-only' so the pill is never misleadingly
  // green when data hasn't reached the server.
  const effectiveState: EffectiveState =
    state === 'idle' && sessionState !== 'active' ? 'local-only' : state;

  const label =
    effectiveState === 'pending' && queueCount > 0
      ? `${queueCount} pending`
      : STATE_LABEL[effectiveState];

  return (
    <span
      className={`sync-indicator sync-indicator--${effectiveState}`}
      title={STATE_TITLE[effectiveState]}
      aria-live="polite"
      aria-label={`Sync status: ${STATE_TITLE[effectiveState]}`}
    >
      {label}
    </span>
  );
}
