import { useEffect, useState } from 'react';
import { getSyncState, subscribeSyncState } from '../lib/syncEngine.js';
import type { SyncIndicatorState } from '../lib/syncEngine.js';
import { useSyncQueueCount } from '../db/storeHooks.js';
import './SyncIndicator.css';

/** Human-readable label for each sync state. Queue count replaces the label when pending. */
const STATE_LABEL: Record<SyncIndicatorState, string> = {
  idle:    'synced',
  syncing: 'syncing',
  pending: 'pending',
  offline: 'offline',
  error:   'error',
};

/** Tooltip shown on hover — more descriptive than the terse pill label. */
const STATE_TITLE: Record<SyncIndicatorState, string> = {
  idle:    'All changes synced',
  syncing: 'Syncing with server…',
  pending: 'Unsaved changes queued',
  offline: 'Offline — changes saved locally',
  error:   'Last sync failed — will retry',
};

/**
 * Shell header badge that reflects the current sync state and pending queue depth.
 *
 * Subscribes to getSyncState/subscribeSyncState (PIN-SYNC state machine in syncEngine.ts).
 * Queue count comes from a live Dexie query so the number stays fresh without polling.
 */
export function SyncIndicator() {
  const [state, setState] = useState<SyncIndicatorState>(getSyncState);
  const queueCount = useSyncQueueCount();

  useEffect(() => subscribeSyncState(setState), []);

  const label =
    state === 'pending' && queueCount > 0
      ? `${queueCount} pending`
      : STATE_LABEL[state];

  return (
    <span
      className={`sync-indicator sync-indicator--${state}`}
      title={STATE_TITLE[state]}
      aria-live="polite"
      aria-label={`Sync status: ${STATE_TITLE[state]}`}
    >
      {label}
    </span>
  );
}
